import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import ts from "typescript";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(testDirectory, "../..");
const nativeRequire = createRequire(import.meta.url);
const moduleCache = new Map();

/** Loads the small framework-free engine modules without adding a test runner dependency. */
function loadTypeScriptModule(filePath) {
  const absolutePath = resolve(filePath);
  const cached = moduleCache.get(absolutePath);
  if (cached) return cached.exports;

  const moduleRecord = { exports: {} };
  moduleCache.set(absolutePath, moduleRecord);
  const source = readFileSync(absolutePath, "utf8");
  const output = ts.transpileModule(source, {
    fileName: absolutePath,
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const localRequire = (specifier) => {
    if (specifier.startsWith("@/")) {
      const candidate = resolve(projectDirectory, specifier.slice(2));
      return loadTypeScriptModule(extname(candidate) ? candidate : `${candidate}.ts`);
    }
    if (!specifier.startsWith(".")) return nativeRequire(specifier);
    const candidate = resolve(dirname(absolutePath), specifier);
    return loadTypeScriptModule(extname(candidate) ? candidate : `${candidate}.ts`);
  };
  const execute = new Function(
    "require",
    "module",
    "exports",
    "__filename",
    "__dirname",
    output,
  );
  execute(
    localRequire,
    moduleRecord,
    moduleRecord.exports,
    absolutePath,
    dirname(absolutePath),
  );
  return moduleRecord.exports;
}

const tuner = loadTypeScriptModule(resolve(testDirectory, "tuner-detection.ts"));
const timeline = loadTypeScriptModule(resolve(testDirectory, "timeline.ts"));
const wav = loadTypeScriptModule(resolve(testDirectory, "wav.ts"));
const advancedUtils = loadTypeScriptModule(
  resolve(projectDirectory, "components/advanced-studio/utils.ts"),
);
const audioFileFormat = loadTypeScriptModule(
  resolve(projectDirectory, "lib/audio-file-format.ts"),
);
const validation = loadTypeScriptModule(resolve(projectDirectory, "lib/validation.ts"));

function memoryStorage() {
  const values = new Map();
  return {
    values,
    get length() { return values.size; },
    key(index) { return Array.from(values.keys())[index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function sineWave(frequency, sampleRate = 48_000, length = 4_096) {
  return Float32Array.from(
    { length },
    (_, index) => Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 0.7,
  );
}

function audioBufferStub(duration, channels = [new Float32Array(Math.round(duration * 48_000))]) {
  return {
    duration,
    length: channels[0]?.length ?? 0,
    numberOfChannels: channels.length,
    sampleRate: 48_000,
    getChannelData(channel) {
      return channels[channel];
    },
  };
}

test("guitar pitch detector resolves E2, A2, and E4", () => {
  for (const [note, frequency] of [["E2", 82.4069], ["A2", 110], ["E4", 329.6276]]) {
    const result = tuner.detectPitchAutocorrelation(sineWave(frequency), 48_000);
    assert.ok(result, `${note} should be detected`);
    assert.ok(Math.abs(result.frequency - frequency) < 0.8, `${note} frequency should be stable`);
  }
});

test("capture and scheduled punch playback both lock shared studio transport", () => {
  assert.equal(advancedUtils.isStudioTransportInteractionLocked(false, false), false);
  assert.equal(advancedUtils.isStudioTransportInteractionLocked(true, false), true);
  assert.equal(advancedUtils.isStudioTransportInteractionLocked(false, true), true);
  assert.equal(advancedUtils.isStudioTransportInteractionLocked(true, true), true);
});

test("studio action lock rejects concurrent starts and ignores stale releases", () => {
  const lock = advancedUtils.createStudioActionLock("tracks");
  assert.equal(lock.pending, "tracks");
  assert.equal(lock.tryAcquire("export"), false);
  assert.equal(lock.release("preview"), false);
  assert.equal(lock.pending, "tracks");
  assert.equal(lock.release("tracks"), true);
  assert.equal(lock.tryAcquire("export"), true);
  assert.equal(lock.tryAcquire("punch"), false);
  assert.equal(lock.release("export"), true);
  assert.equal(lock.pending, null);
});

test("blocked browser storage getters and unavailable outboxes fail closed", () => {
  const deniedHost = {};
  Object.defineProperties(deniedHost, {
    localStorage: {
      get() {
        throw new DOMException("Storage is disabled", "SecurityError");
      },
    },
    sessionStorage: {
      get() {
        throw new DOMException("Storage is disabled", "SecurityError");
      },
    },
  });

  assert.equal(advancedUtils.getBrowserStorageOrNull("local", deniedHost), null);
  assert.equal(advancedUtils.getBrowserStorageOrNull("session", deniedHost), null);
  assert.equal(advancedUtils.getBrowserStorageOrNull("local", null), null);

  const draft = {
    baseSignature: "[]",
    baseRevision: 0,
    savedAtMs: 1,
    rows: [],
  };
  assert.equal(
    advancedUtils.persistRevisionedOutbox(null, "track-patches", new Map([
      ["track-a", { baseRevision: 0, patch: { volume: 0.5 } }],
    ])),
    false,
  );
  assert.equal(advancedUtils.persistCompDraftOutbox(null, "comp", draft), false);
  assert.deepEqual(advancedUtils.listOwnerScopedOutboxKeys(null, "outbox"), []);
  assert.equal(
    advancedUtils.suppressOutboxSnapshots(null, "outbox", [{
      sourceKey: "source",
      entryId: null,
      fingerprint: "fingerprint",
    }]),
    0,
  );
  assert.equal(
    advancedUtils.clearAppliedCompDraftOutboxes(null, "comp", [], []),
    0,
  );
  assert.equal(
    advancedUtils.readCompDraftOutbox(null, "comp", "comp:owner:a", null),
    null,
  );

  const durableState = {
    trackPatchCount: 0,
    trackOutboxDurable: true,
    markerPatchCount: 0,
    markerOutboxDurable: true,
    compDraftDurable: true,
  };
  assert.equal(advancedUtils.hasUndurableStudioChanges(durableState), false);
  assert.equal(advancedUtils.hasUndurableStudioChanges({
    ...durableState,
    trackPatchCount: 1,
    trackOutboxDurable: false,
  }), true);
  assert.equal(advancedUtils.hasUndurableStudioChanges({
    ...durableState,
    compDraftDurable: false,
  }), true);
});

test("track import picker advertises every supported audio family and its limit", () => {
  assert.equal(
    advancedUtils.AUDIO_TRACK_IMPORT_HELP,
    "MP3 · WAV · AIFF · M4A · AAC · FLAC · OGG/Opus · WebM, 파일당 95MB",
  );
  for (const extension of [
    ".mp3",
    ".wav",
    ".aiff",
    ".m4a",
    ".aac",
    ".flac",
    ".ogg",
    ".opus",
    ".webm",
  ]) {
    assert.ok(
      advancedUtils.AUDIO_TRACK_IMPORT_ACCEPT.split(",").includes(extension),
      `${extension} should be selectable`,
    );
  }
});

test("generic browser MIME falls back only to an explicit matching audio extension", () => {
  const fallbacks = [
    ["song.MP3", "audio/mpeg", "mp3"],
    ["song.wav", "audio/wav", "wav"],
    ["song.wave", "audio/wav", "wav"],
    ["song.AIF", "audio/aiff", "aiff"],
    ["song.aiff", "audio/aiff", "aiff"],
    ["song.m4a", "audio/mp4", "m4a"],
    ["song.aac", "audio/aac", "aac"],
    ["song.flac", "audio/flac", "flac"],
    ["song.ogg", "audio/ogg", "ogg"],
    ["song.oga", "audio/ogg", "ogg"],
    ["song.opus", "audio/opus", "opus"],
    ["song.webm", "audio/webm", "webm"],
  ];
  assert.deepEqual(
    fallbacks.map(([fileName]) => fileName.split(".").at(-1).toLowerCase()),
    [...audioFileFormat.SUPPORTED_AUDIO_FILE_EXTENSIONS],
  );
  for (const [fileName, mimeType, extension] of fallbacks) {
    assert.deepEqual(
      audioFileFormat.resolveSupportedAudioFileFormat("", fileName),
      { mimeType, extension },
    );
    assert.deepEqual(
      audioFileFormat.resolveSupportedAudioFileFormat(
        "application/octet-stream",
        fileName,
      ),
      { mimeType, extension },
    );
  }

  assert.deepEqual(
    audioFileFormat.resolveSupportedAudioFileFormat("audio/mpeg", "song.mp3"),
    { mimeType: "audio/mpeg", extension: "mp3" },
  );
  assert.equal(
    audioFileFormat.resolveSupportedAudioFileFormat("text/html", "song.mp3"),
    null,
  );
  assert.equal(
    audioFileFormat.resolveSupportedAudioFileFormat("audio/mpeg", "song.wav"),
    null,
  );
  assert.equal(
    audioFileFormat.resolveSupportedAudioFileFormat("", "song.mp3.exe"),
    null,
  );
});

test("audio import preflight rejects before hashing and shares the exact 95MB boundary", () => {
  const valid = audioFileFormat.preflightAudioFile({
    name: "backing.wav",
    size: audioFileFormat.MAX_AUDIO_FILE_BYTES,
    type: "audio/wav",
  });
  assert.equal(valid.ok, true);

  const empty = audioFileFormat.preflightAudioFile({
    name: "empty.mp3",
    size: 0,
    type: "audio/mpeg",
  });
  assert.deepEqual(
    empty,
    {
      ok: false,
      message: "empty.mp3: 비어 있는 오디오 파일이에요.",
      reason: "empty",
      status: 400,
    },
  );

  const oversized = audioFileFormat.preflightAudioFile({
    name: "huge.wav",
    size: audioFileFormat.MAX_AUDIO_FILE_BYTES + 1,
    type: "audio/wav",
  });
  assert.equal(oversized.ok, false);
  assert.equal(oversized.status, 413);
  assert.match(oversized.message, /huge\.wav/);
  assert.match(oversized.message, /95MB/);

  const unsupported = audioFileFormat.preflightAudioFile({
    name: "notes.txt",
    size: 12,
    type: "text/plain",
  });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.status, 415);
  assert.match(unsupported.message, /notes\.txt/);
});

test("Comp skips empty segments and applies a symmetric crossfade", () => {
  const oneSecond = audioBufferStub(1);
  const halfSecond = audioBufferStub(0.5);
  const tracks = timeline.buildCompTimeline([
    {
      id: "empty",
      takeId: "take-empty",
      buffer: oneSecond,
      sourceStartSeconds: 0.8,
      sourceEndSeconds: 0.2,
    },
    {
      id: "first",
      takeId: "take-one",
      buffer: oneSecond,
      sourceStartSeconds: 0,
      sourceEndSeconds: 1,
    },
    {
      id: "second",
      takeId: "take-two",
      buffer: halfSecond,
      sourceStartSeconds: 0,
      sourceEndSeconds: 0.5,
    },
  ], { crossfadeSeconds: 0.1 });

  assert.equal(tracks.length, 2);
  assert.equal(tracks[0].fadeOutSeconds, 0.1);
  assert.equal(tracks[1].fadeInSeconds, 0.1);
  assert.ok(Math.abs(tracks[1].offsetSeconds - 0.9) < 1e-9);
  assert.ok(Math.abs(timeline.getTimelineDuration(tracks) - 1.4) < 1e-9);
});

test("timeline mute and solo gating is shared by duration and scheduling", () => {
  const oneSecond = audioBufferStub(1);
  const tracks = [
    { id: "main", buffer: oneSecond },
    { id: "muted", buffer: oneSecond, muted: true },
    { id: "solo", buffer: oneSecond, offsetSeconds: 0.25, durationSeconds: 0.5, solo: true },
    { id: "muted-solo", buffer: oneSecond, muted: true, solo: true },
  ];
  assert.deepEqual(
    timeline.getAudibleTimelineTracks(tracks).map((track) => track.id),
    ["solo"],
  );
  assert.equal(timeline.getTimelineDuration(tracks), 0.75);

  let starts = 0;
  const destination = { connect() {}, disconnect() {} };
  const context = {
    currentTime: 0,
    destination,
    createBufferSource() {
      return {
        buffer: null,
        connect() {},
        disconnect() {},
        addEventListener() {},
        start() { starts += 1; },
        stop() {},
      };
    },
    createGain() {
      return {
        gain: {
          cancelScheduledValues() {},
          setValueAtTime() {},
          linearRampToValueAtTime() {},
        },
        connect() {},
        disconnect() {},
      };
    },
    createStereoPanner() {
      return {
        pan: { setValueAtTime() {} },
        connect() {},
        disconnect() {},
      };
    },
  };
  timeline.scheduleTimelineTracks(context, tracks, destination);
  assert.equal(starts, 1);
});

test("decoded imported tracks use AudioBuffer duration when metadata is automatic", () => {
  const imported = advancedUtils.normalizeTrack({
    id: "track-imported",
    kind: "backing",
    durationMs: null,
    offsetMs: 750,
  });
  assert.equal(imported?.durationMs, null);
  assert.equal(
    timeline.getTimelineDuration([{
      id: imported.id,
      buffer: audioBufferStub(4.25),
      offsetSeconds: imported.offsetMs / 1_000,
    }]),
    5,
  );
});

test("track normalization and outbox preserve boolean mixer state", () => {
  const track = advancedUtils.normalizeTrack({
    id: "track-a",
    kind: "guitar",
    muted: true,
    solo: "true",
  });
  assert.equal(track?.muted, true);
  assert.equal(track?.solo, true);
  assert.equal(advancedUtils.normalizeTrack({ id: "track-b" })?.muted, false);
  assert.equal(advancedUtils.normalizeTrack({ id: "track-b" })?.solo, false);
  assert.deepEqual(
    advancedUtils.sanitizeTrackPatch({ muted: true, solo: false, volume: 3, pan: -2 }),
    { muted: true, solo: false, volume: 2, pan: -1 },
  );
  assert.equal(advancedUtils.sanitizeTrackPatch({ muted: "true", solo: 1 }), null);
});

test("track PATCH validation accepts booleans without coercing strings", () => {
  assert.deepEqual(validation.trackUpdateSchema.parse({ muted: true, solo: false }), {
    muted: true,
    solo: false,
  });
  assert.throws(() => validation.trackUpdateSchema.parse({ muted: "true" }));
  assert.throws(() => validation.trackUpdateSchema.parse({}));
});

test("advanced create request IDs survive response loss and rotate after reconciliation", () => {
  const storage = memoryStorage();
  const registry = new Map();
  const firstId = "10000000-0000-4000-8000-000000000001";
  const secondId = "20000000-0000-4000-8000-000000000002";
  const intent = advancedUtils.trackCreateIntentFingerprint({
    kind: "backing",
    name: "Night Drive",
    durationMs: null,
    fileName: "night-drive.wav",
    mimeType: "audio/wav",
    byteSize: 4,
    contentDigest: "source-a",
  });
  const first = advancedUtils.getOrCreateCreateRequest(
    registry,
    storage,
    "track",
    "riff-a",
    intent,
    () => firstId,
  );
  const responseLossRetry = advancedUtils.getOrCreateCreateRequest(
    registry,
    storage,
    "track",
    "riff-a",
    intent,
    () => {
      throw new Error("the pending request ID must be reused");
    },
  );
  assert.equal(responseLossRetry.requestId, first.requestId);

  advancedUtils.completeCreateRequest(registry, storage, responseLossRetry);
  const nextIntentionalCreate = advancedUtils.getOrCreateCreateRequest(
    registry,
    storage,
    "track",
    "riff-a",
    intent,
    () => secondId,
  );
  assert.equal(nextIntentionalCreate.requestId, secondId);
  assert.notEqual(nextIntentionalCreate.requestId, first.requestId);
});

test("track and marker create intents change with source or payload", () => {
  const baseTrack = {
    kind: "guitar",
    name: "Take 01",
    durationMs: 1_000,
    fileName: "take.wav",
    mimeType: "audio/wav",
    byteSize: 4,
    contentDigest: "source-a",
  };
  assert.equal(
    advancedUtils.trackCreateIntentFingerprint(baseTrack),
    advancedUtils.trackCreateIntentFingerprint({ ...baseTrack }),
  );
  assert.notEqual(
    advancedUtils.trackCreateIntentFingerprint(baseTrack),
    advancedUtils.trackCreateIntentFingerprint({ ...baseTrack, contentDigest: "source-b" }),
  );
  assert.notEqual(
    advancedUtils.markerCreateIntentFingerprint({ positionMs: 500, label: "Verse", color: "rose" }),
    advancedUtils.markerCreateIntentFingerprint({ positionMs: 501, label: "Verse", color: "rose" }),
  );
});

test("large browser retry fingerprints stream without requesting one full-size buffer", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const digestInput = (parts) => ({
    size: 9 * 1024 * 1024,
    arrayBuffer() {
      throw new Error("large files must not use arrayBuffer");
    },
    stream() {
      let index = 0;
      return new ReadableStream({
        pull(controller) {
          const part = parts[index++];
          if (part) controller.enqueue(part);
          else controller.close();
        },
      });
    },
  });
  const digest = await advancedUtils.audioFileContentDigest(
    digestInput([bytes.subarray(0, 2), bytes.subarray(2)]),
  );
  const differentlyChunked = await advancedUtils.audioFileContentDigest(
    digestInput([bytes]),
  );
  assert.match(digest, /^fallback-[a-f0-9]{16}$/);
  assert.equal(digest, differentlyChunked);
});

test("failed outbox persistence never claims a rejected PATCH is safely stored", () => {
  const quotaStorage = {
    setItem() { throw new Error("QuotaExceededError"); },
    removeItem() { throw new Error("QuotaExceededError"); },
  };
  const persisted = advancedUtils.persistRevisionedOutbox(
    quotaStorage,
    "riff-sketchbook:track-patches:riff-a:owner:tab-a",
    new Map([["track-a", { baseRevision: 2, patch: { volume: 0.7 } }]]),
  );
  assert.equal(persisted, false);
  const message = advancedUtils.deferredPatchFailureMessage(
    "트랙 설정",
    new Error("네트워크 요청이 실패했어요."),
    persisted,
  );
  assert.match(message, /브라우저에 보관하지 못했어요/);
  assert.match(message, /이 화면을 닫지 말고/);
  assert.doesNotMatch(message, /보관했으며|안전하게 보관/);
});

test("Comp conflict refresh is blocked when its draft is not durable", async () => {
  let refreshed = false;
  const blocked = await advancedUtils.refreshCompAfterDurableConflictDraft(
    () => false,
    async () => {
      refreshed = true;
      return ["server-row"];
    },
  );
  assert.deepEqual(blocked, { durable: false });
  assert.equal(refreshed, false);

  const allowed = await advancedUtils.refreshCompAfterDurableConflictDraft(
    () => true,
    async () => {
      refreshed = true;
      return ["server-row"];
    },
  );
  assert.deepEqual(allowed, { durable: true, refreshed: ["server-row"] });
  assert.equal(refreshed, true);
});

test("marker create validation requires one strict UUID request ID", () => {
  const valid = {
    requestId: "10000000-0000-4000-8000-000000000001",
    positionMs: 500,
    label: "Verse",
    color: "rose",
  };
  assert.deepEqual(validation.markerCreateSchema.parse(valid), valid);
  assert.throws(() => validation.markerCreateSchema.parse({ ...valid, requestId: undefined }));
  assert.throws(() => validation.markerCreateSchema.parse({ ...valid, extra: true }));
});

test("advanced outboxes isolate owners and migrate prior and legacy entries", () => {
  const baseKey = "riff-sketchbook:track-patches:riff-a";
  assert.notEqual(
    advancedUtils.ownerScopedOutboxKey(baseKey, "tab-a"),
    advancedUtils.ownerScopedOutboxKey(baseKey, "tab-b"),
  );

  const memoryEntry = { baseRevision: 7, patch: { volume: 0.7 } };
  const currentOwnerEntry = { baseRevision: 7, patch: { volume: 0.7 } };
  const previousOwnerEntry = { baseRevision: 4, patch: { pan: -0.25 } };
  const legacyEntry = { baseRevision: 2, patch: { muted: true } };
  const merged = advancedUtils.mergeOwnerOutboxEntries(
    new Map([["shared", memoryEntry]]),
    new Map([["shared", currentOwnerEntry]]),
    new Map([["previous", previousOwnerEntry]]),
    new Map([["legacy", legacyEntry]]),
  );

  assert.deepEqual(merged.entries.get("shared"), { ...memoryEntry, generation: 1 });
  assert.deepEqual(merged.entries.get("previous"), { ...previousOwnerEntry, generation: 1 });
  assert.deepEqual(merged.entries.get("legacy"), { ...legacyEntry, generation: 1 });
  assert.equal(merged.shouldPersistToCurrentOwner, true);
});

test("advanced outbox migration merges partial fields and conflicts mismatched bases", () => {
  const compatible = advancedUtils.mergeOwnerOutboxEntries(
    new Map([["track-a", { baseRevision: 8, patch: { volume: 0.7 } }]]),
    new Map(),
    new Map([["track-a", { baseRevision: 8, patch: { pan: -0.25 } }]]),
    new Map(),
  );
  assert.deepEqual(compatible.entries.get("track-a"), {
    baseRevision: 8,
    generation: 1,
    patch: { pan: -0.25, volume: 0.7 },
  });

  const mismatched = advancedUtils.mergeOwnerOutboxEntries(
    new Map([["marker-a", { baseRevision: 4, patch: { label: "Verse" } }]]),
    new Map(),
    new Map(),
    new Map([["marker-a", { baseRevision: 3, patch: { positionMs: 900 } }]]),
  );
  assert.deepEqual(mismatched.entries.get("marker-a"), {
    baseRevision: null,
    generation: 1,
    patch: { positionMs: 900, label: "Verse" },
  });

  const overlapping = advancedUtils.mergeOwnerOutboxEntries(
    new Map([["track-a", { baseRevision: 8, patch: { volume: 0.7 } }]]),
    new Map(),
    new Map([["track-a", { baseRevision: 8, patch: { volume: 0.9 } }]]),
    new Map(),
  );
  assert.deepEqual(overlapping.entries.get("track-a"), {
    baseRevision: null,
    generation: 1,
    patch: { volume: 0.7 },
  });
});

test("a new tab discovers all closed-tab owners without deleting their sources", () => {
  const storage = memoryStorage();
  const baseKey = "riff-sketchbook:track-patches:riff-a";
  const ownerA = advancedUtils.ownerScopedOutboxKey(baseKey, "owner-a");
  const ownerB = advancedUtils.ownerScopedOutboxKey(baseKey, "owner-b");
  storage.setItem(ownerA, "owner-a-value");
  storage.setItem(ownerB, "owner-b-value");

  assert.deepEqual(advancedUtils.listOwnerScopedOutboxKeys(storage, baseKey), [
    ownerA,
    ownerB,
  ]);
  const recovered = advancedUtils.mergeOwnerOutboxEntries(
    new Map(),
    new Map(),
    new Map(),
    new Map(),
    [
      new Map([["track-a", { baseRevision: 2, patch: { pan: -0.2 } }]]),
      new Map([["marker-a", { baseRevision: 4, patch: { label: "Verse" } }]]),
    ],
  );
  assert.equal(recovered.entries.size, 2);
  assert.equal(recovered.shouldPersistToCurrentOwner, true);
  assert.equal(storage.getItem(ownerA), "owner-a-value");
  assert.equal(storage.getItem(ownerB), "owner-b-value");
});

test("discard tombstones suppress only an exact snapshot and never mutate its source", () => {
  const storage = memoryStorage();
  const baseKey = "riff-sketchbook:marker-patches:riff-a";
  const sourceKey = advancedUtils.ownerScopedOutboxKey(baseKey, "owner-a");
  const entry = { baseRevision: 4, patch: { label: "Verse" } };
  const snapshot = {
    sourceKey,
    entryId: "marker-a",
    fingerprint: advancedUtils.revisionedOutboxFingerprint(entry),
  };
  storage.setItem(sourceKey, JSON.stringify({ "marker-a": entry }));

  assert.equal(advancedUtils.suppressOutboxSnapshots(storage, baseKey, [snapshot]), 1);
  assert.equal(advancedUtils.isOutboxSnapshotSuppressed(storage, baseKey, snapshot), true);
  assert.notEqual(storage.getItem(sourceKey), null);

  const changedSnapshot = {
    ...snapshot,
    fingerprint: advancedUtils.revisionedOutboxFingerprint({
      baseRevision: 4,
      patch: { label: "Chorus" },
    }),
  };
  assert.equal(
    advancedUtils.isOutboxSnapshotSuppressed(storage, baseKey, changedSnapshot),
    false,
  );
});

test("a persisted pre-generation tombstone still suppresses its legacy entry", () => {
  const storage = memoryStorage();
  const baseKey = "riff-sketchbook:marker-patches:riff-a";
  const sourceKey = advancedUtils.ownerScopedOutboxKey(baseKey, "legacy-owner");
  const generationlessEntry = { baseRevision: 4, patch: { label: "Verse" } };
  const legacyFingerprint = JSON.stringify({
    baseRevision: 4,
    patch: { label: "Verse" },
  });
  const persistedLegacyTombstone = {
    sourceKey,
    entryId: "marker-a",
    fingerprint: legacyFingerprint,
  };
  storage.setItem(
    sourceKey,
    JSON.stringify({ "marker-a": generationlessEntry }),
  );
  assert.equal(
    advancedUtils.suppressOutboxSnapshots(
      storage,
      baseKey,
      [persistedLegacyTombstone],
    ),
    1,
  );

  assert.equal(
    advancedUtils.revisionedOutboxFingerprint(generationlessEntry),
    legacyFingerprint,
  );
  assert.equal(
    advancedUtils.revisionedOutboxFingerprint({
      ...generationlessEntry,
      generation: 0,
    }),
    legacyFingerprint,
  );
  assert.equal(
    advancedUtils.isOutboxSnapshotSuppressed(storage, baseKey, {
      ...persistedLegacyTombstone,
      fingerprint: advancedUtils.revisionedOutboxFingerprint({
        ...generationlessEntry,
        generation: 0,
      }),
    }),
    true,
  );

  const migratedEntry = {
    ...generationlessEntry,
    generation: advancedUtils.nextOutboxGeneration(0),
  };
  assert.notEqual(
    advancedUtils.revisionedOutboxFingerprint(migratedEntry),
    legacyFingerprint,
  );
});

test("delayed server resolution suppresses only snapshots captured before a foreign rewrite", () => {
  for (const [kind, firstPatch, rewrittenPatch] of [
    ["track", { pan: -0.2 }, { pan: 0.4 }],
    ["marker", { label: "Verse" }, { label: "Bridge" }],
  ]) {
    const storage = memoryStorage();
    const baseKey = `riff-sketchbook:${kind}-patches:riff-a`;
    const foreignSourceKey = advancedUtils.ownerScopedOutboxKey(
      baseKey,
      "foreign-live-owner",
    );
    const beforeRequest = {
      baseRevision: 6,
      generation: 3,
      patch: firstPatch,
    };
    const capturedBeforeRequest = {
      sourceKey: foreignSourceKey,
      entryId: `${kind}-a`,
      fingerprint: advancedUtils.revisionedOutboxFingerprint(beforeRequest),
    };

    // The other live tab writes while the server-version request is delayed.
    const rewrittenDuringRequest = {
      baseRevision: 6,
      generation: advancedUtils.nextOutboxGeneration(
        beforeRequest.generation,
        beforeRequest.generation,
      ),
      patch: rewrittenPatch,
    };
    storage.setItem(
      foreignSourceKey,
      JSON.stringify({ [`${kind}-a`]: rewrittenDuringRequest }),
    );

    assert.equal(
      advancedUtils.suppressOutboxSnapshots(
        storage,
        baseKey,
        [capturedBeforeRequest],
      ),
      1,
    );
    assert.equal(
      advancedUtils.isOutboxSnapshotSuppressed(
        storage,
        baseKey,
        capturedBeforeRequest,
      ),
      true,
    );
    assert.equal(
      advancedUtils.isOutboxSnapshotSuppressed(storage, baseKey, {
        ...capturedBeforeRequest,
        fingerprint: advancedUtils.revisionedOutboxFingerprint(
          rewrittenDuringRequest,
        ),
      }),
      false,
    );
    assert.notEqual(storage.getItem(foreignSourceKey), null);
  }
});

test("track and marker rewrites remain recoverable after changing away and back", () => {
  for (const [kind, originalPatch, awayPatch] of [
    ["track", { volume: 0.7 }, { volume: 0.9 }],
    ["marker", { label: "Verse" }, { label: "Chorus" }],
  ]) {
    const storage = memoryStorage();
    const baseKey = `riff-sketchbook:${kind}-patches:riff-a`;
    const sourceKey = advancedUtils.ownerScopedOutboxKey(baseKey, "owner-a");
    const original = { baseRevision: 4, generation: 1, patch: originalPatch };
    const discarded = {
      sourceKey,
      entryId: `${kind}-a`,
      fingerprint: advancedUtils.revisionedOutboxFingerprint(original),
    };
    assert.equal(
      advancedUtils.suppressOutboxSnapshots(storage, baseKey, [discarded]),
      1,
    );

    const awayGeneration = advancedUtils.nextOutboxGeneration(
      original.generation,
      original.generation,
    );
    const away = {
      ...original,
      generation: awayGeneration,
      patch: awayPatch,
    };
    const back = {
      ...original,
      generation: advancedUtils.nextOutboxGeneration(
        away.generation,
        away.generation,
      ),
    };
    storage.setItem(sourceKey, JSON.stringify({ [`${kind}-a`]: back }));
    const rewrittenSnapshot = {
      ...discarded,
      fingerprint: advancedUtils.revisionedOutboxFingerprint(back),
    };

    assert.notEqual(rewrittenSnapshot.fingerprint, discarded.fingerprint);
    assert.equal(
      advancedUtils.isOutboxSnapshotSuppressed(storage, baseKey, rewrittenSnapshot),
      false,
    );
    assert.deepEqual(back.patch, originalPatch);
  }
});

test("advanced outbox migration persists a previous owner across another reload", () => {
  const previousEntry = { baseRevision: 3, patch: { solo: true } };
  const migrated = advancedUtils.mergeOwnerOutboxEntries(
    new Map(),
    new Map(),
    new Map([["track-a", previousEntry]]),
    new Map(),
  );

  assert.deepEqual(migrated.entries.get("track-a"), {
    ...previousEntry,
    generation: 1,
  });
  assert.equal(migrated.shouldPersistToCurrentOwner, true);
});

test("server-version resolution rejects a structurally equal newer outbox generation", () => {
  const captured = { baseRevision: 1, patch: { volume: 0.5 } };
  assert.equal(advancedUtils.isSameOutboxGeneration(captured, captured), true);
  assert.equal(
    advancedUtils.isSameOutboxGeneration(captured, {
      baseRevision: 1,
      patch: { volume: 0.5 },
    }),
    false,
  );
  assert.equal(advancedUtils.isSameOutboxGeneration(captured, undefined), false);
});

test("list refresh rejects responses older than a mutation generation or known revision", () => {
  const known = new Map([["track-a", 6]]);
  assert.equal(
    advancedUtils.canApplyRevisionedList(3, 4, 2, 1, [{ id: "track-a", revision: 6 }], known),
    false,
  );
  assert.equal(
    advancedUtils.canApplyRevisionedList(4, 4, 2, 1, [{ id: "track-a", revision: 5 }], known),
    false,
  );
  assert.equal(
    advancedUtils.canApplyRevisionedList(4, 4, 2, 1, [{ id: "track-a", revision: 7 }], known),
    true,
  );
});

test("a stale empty list cannot erase an entity learned or edited by a newer request", () => {
  assert.equal(
    advancedUtils.canApplyRevisionedList(8, 8, 3, 4, [], new Map([["track-a", 2]])),
    false,
  );
  assert.equal(
    advancedUtils.canApplyRevisionedList(7, 8, 5, 4, [], new Map([["track-a", 2]])),
    false,
  );
});

test("Comp recovery recognizes a committed draft despite client-only row ids", () => {
  const draft = [{
    clientId: "draft-row",
    takeId: "take-a",
    startMs: 100,
    endMs: 900,
  }];
  const server = [{
    clientId: "server-row",
    id: "segment-a",
    takeId: "take-a",
    startMs: 100,
    endMs: 900,
  }];
  assert.equal(advancedUtils.isCompDraftAlreadyApplied(draft, server), true);
  assert.equal(
    advancedUtils.isCompDraftAlreadyApplied(draft, [{ ...server[0], endMs: 901 }]),
    false,
  );
});

test("Comp save acknowledgement never replaces edits made while the request is in flight", () => {
  const requested = [{
    clientId: "requested-row",
    takeId: "take-a",
    startMs: 100,
    endMs: 900,
  }];
  const sameContent = [{ ...requested[0], clientId: "rendered-row" }];
  const laterEdit = [{ ...requested[0], clientId: "later-row", endMs: 1_000 }];

  assert.equal(
    advancedUtils.shouldAcknowledgeCompSave(requested, sameContent, 4, 4),
    true,
  );
  assert.equal(
    advancedUtils.shouldAcknowledgeCompSave(requested, laterEdit, 4, 5),
    false,
  );
  assert.equal(
    advancedUtils.shouldAcknowledgeCompSave(requested, sameContent, 4, 5),
    false,
  );
});

test("Comp editing stays fail-closed until the initial server snapshot hydrates", () => {
  assert.equal(advancedUtils.canMutateCompDraft(false), false);
  assert.equal(advancedUtils.canMutateCompDraft(true), true);
});

test("Comp drafts stay owner-scoped and legacy migration never steals a duplicated tab", () => {
  const storage = memoryStorage();
  const baseKey = "riff-sketchbook:comp-draft:riff-a";
  const ownerA = advancedUtils.ownerScopedOutboxKey(baseKey, "owner-a");
  const ownerB = advancedUtils.ownerScopedOutboxKey(baseKey, "owner-b");
  const rowsA = [{ clientId: "a", takeId: "take-a", startMs: 0, endMs: 800 }];
  const draftA = {
    baseSignature: "server-1",
    baseRevision: 1,
    savedAtMs: 100,
    rows: rowsA,
  };

  storage.setItem(baseKey, JSON.stringify(draftA));
  const migrated = advancedUtils.readCompDraftOutbox(storage, baseKey, ownerA, null);
  assert.equal(migrated?.baseSignature, draftA.baseSignature);
  assert.equal(migrated?.baseRevision, draftA.baseRevision);
  assert.equal(advancedUtils.isCompDraftAlreadyApplied(migrated?.rows ?? [], rowsA), true);
  assert.notEqual(storage.getItem(baseKey), null);
  assert.notEqual(storage.getItem(ownerA), null);

  const duplicated = advancedUtils.readCompDraftOutbox(storage, baseKey, ownerB, ownerA);
  assert.equal(duplicated?.baseSignature, draftA.baseSignature);
  assert.equal(duplicated?.baseRevision, draftA.baseRevision);
  assert.equal(advancedUtils.isCompDraftAlreadyApplied(duplicated?.rows ?? [], rowsA), true);
  assert.notEqual(storage.getItem(ownerA), null);
  assert.notEqual(storage.getItem(ownerB), null);
});

test("saving one tab clears only matching Comp copies and preserves another tab draft", () => {
  const storage = memoryStorage();
  const baseKey = "riff-sketchbook:comp-draft:riff-a";
  const ownerA = advancedUtils.ownerScopedOutboxKey(baseKey, "owner-a");
  const ownerB = advancedUtils.ownerScopedOutboxKey(baseKey, "owner-b");
  const ownerBReloaded = advancedUtils.ownerScopedOutboxKey(baseKey, "owner-b-reloaded");
  const rowsA = [{ clientId: "a", takeId: "take-a", startMs: 0, endMs: 800 }];
  const rowsB = [{ clientId: "b", takeId: "take-b", startMs: 100, endMs: 900 }];

  advancedUtils.persistCompDraftOutbox(storage, ownerA, {
    baseSignature: "server-1",
    baseRevision: 1,
    savedAtMs: 100,
    rows: rowsA,
  });
  advancedUtils.readCompDraftOutbox(storage, baseKey, ownerB, ownerA);
  advancedUtils.persistCompDraftOutbox(storage, ownerB, {
    baseSignature: "server-1",
    baseRevision: 1,
    savedAtMs: 200,
    rows: rowsB,
  });

  assert.equal(
    advancedUtils.clearAppliedCompDraftOutboxes(
      storage,
      baseKey,
      rowsA,
      [ownerA, ownerB],
    ),
    1,
  );
  assert.notEqual(storage.getItem(ownerA), null);
  assert.notEqual(storage.getItem(ownerB), null);
  const recovered = advancedUtils.readCompDraftOutbox(
    storage,
    baseKey,
    ownerBReloaded,
    ownerB,
  );
  assert.equal(advancedUtils.isCompDraftAlreadyApplied(recovered?.rows ?? [], rowsB), true);
});

test("a brand-new tab recovers the newest orphan Comp while preserving every owner", () => {
  const storage = memoryStorage();
  const baseKey = "riff-sketchbook:comp-draft:riff-a";
  const ownerA = advancedUtils.ownerScopedOutboxKey(baseKey, "owner-a");
  const ownerB = advancedUtils.ownerScopedOutboxKey(baseKey, "owner-b");
  const ownerNew = advancedUtils.ownerScopedOutboxKey(baseKey, "owner-new");
  const rowsA = [{ clientId: "a", takeId: "take-a", startMs: 0, endMs: 800 }];
  const rowsB = [{ clientId: "b", takeId: "take-b", startMs: 50, endMs: 900 }];
  advancedUtils.persistCompDraftOutbox(storage, ownerA, {
    baseSignature: "server-1",
    baseRevision: 1,
    savedAtMs: 100,
    rows: rowsA,
  });
  advancedUtils.persistCompDraftOutbox(storage, ownerB, {
    baseSignature: "server-1",
    baseRevision: 1,
    savedAtMs: 200,
    rows: rowsB,
  });

  const recovered = advancedUtils.readCompDraftOutbox(
    storage,
    baseKey,
    ownerNew,
    null,
  );
  assert.equal(advancedUtils.isCompDraftAlreadyApplied(recovered?.rows ?? [], rowsB), true);
  assert.notEqual(storage.getItem(ownerA), null);
  assert.notEqual(storage.getItem(ownerB), null);
  assert.notEqual(storage.getItem(ownerNew), null);
});

test("discarded Comp orphan stays suppressed until that source actually changes", () => {
  const storage = memoryStorage();
  const baseKey = "riff-sketchbook:comp-draft:riff-a";
  const ownerA = advancedUtils.ownerScopedOutboxKey(baseKey, "owner-a");
  const ownerNew = advancedUtils.ownerScopedOutboxKey(baseKey, "owner-new");
  const ownerChanged = advancedUtils.ownerScopedOutboxKey(baseKey, "owner-changed");
  const rows = [{ clientId: "a", takeId: "take-a", startMs: 0, endMs: 800 }];
  const draft = {
    baseSignature: "server-1",
    baseRevision: 1,
    savedAtMs: 100,
    rows,
  };
  advancedUtils.persistCompDraftOutbox(storage, ownerA, draft);
  assert.equal(advancedUtils.suppressCompDraftCopies(storage, baseKey, draft), true);
  assert.equal(
    advancedUtils.readCompDraftOutbox(storage, baseKey, ownerNew, null),
    null,
  );
  assert.notEqual(storage.getItem(ownerA), null);

  advancedUtils.persistCompDraftOutbox(storage, ownerA, {
    ...draft,
    savedAtMs: 200,
  });
  const changed = advancedUtils.readCompDraftOutbox(
    storage,
    baseKey,
    ownerChanged,
    null,
  );
  assert.equal(advancedUtils.isCompDraftAlreadyApplied(changed?.rows ?? [], rows), true);
});

test("PCM WAV encoder writes the expected RIFF header and byte length", async () => {
  const left = Float32Array.from([-1, 0, 1]);
  const right = Float32Array.from([1, 0, -1]);
  const blob = wav.encodePcmWav(audioBufferStub(left.length / 48_000, [left, right]), {
    bitDepth: 16,
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const text = (start, length) => String.fromCharCode(...bytes.slice(start, start + length));

  assert.equal(text(0, 4), "RIFF");
  assert.equal(text(8, 4), "WAVE");
  assert.equal(text(36, 4), "data");
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 12);
  assert.equal(blob.size, 56);
});
