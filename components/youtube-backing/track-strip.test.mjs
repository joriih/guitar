import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));

function source(fileName) {
  return readFile(path.join(directory, fileName), "utf8");
}

test("connected YouTube backing uses one compact track strip and a closed settings disclosure", async () => {
  const [section, player] = await Promise.all([
    source("YouTubeBackingSection.tsx"),
    source("YouTubeBackingPlayer.tsx"),
  ]);

  assert.match(section, /className=\{styles\.addRow\}/);
  assert.match(section, /placeholder="YouTube 링크 붙여넣기"/);
  assert.match(section, /<details className=\{styles\.settingsDisclosure\}/);
  assert.match(section, /<summary>/);
  assert.doesNotMatch(section, /<details[^>]*\sopen(?:=|\s|>)/);
  assert.doesNotMatch(section, /백킹과 녹음 시작/);
  assert.match(section, /상단 새 테이크 버튼으로 함께 녹음/);
  assert.match(player, /data-youtube-track-strip/);
  assert.match(player, /className=\{styles\.trackHeader\}/);
  assert.match(player, /className=\{styles\.transport\} role="group"/);
  assert.match(player, /<dt>동기화<\/dt>/);
  assert.match(player, /<dt>시작점<\/dt>/);
});

test("official iframe controls and real-iframe visibility policy remain intact", async () => {
  const [section, player, playerStyles] = await Promise.all([
    source("YouTubeBackingSection.tsx"),
    source("YouTubeBackingPlayer.tsx"),
    source("YouTubeBackingPlayer.module.css"),
  ]);

  assert.match(player, /controls:\s*1/);
  assert.match(player, /player\.getIframe\(\)\.getBoundingClientRect\(\)/);
  assert.match(player, /isRectMostlyVisible/);
  assert.match(player, /document\.visibilityState !== "visible"/);
  assert.match(player, /window\.addEventListener\("scroll", pauseWhenObscured/);
  assert.match(player, /onPlaybackInterrupted/);
  assert.match(player, /onError/);
  assert.match(player, /onAutoplayBlocked/);
  assert.match(playerStyles, /\.playerMount iframe\s*\{[^}]*display:\s*block/s);
  assert.match(playerStyles, /\.videoFrame\s*\{[^}]*min-height:\s*200px/s);
  assert.doesNotMatch(playerStyles, /\.videoFrame::(?:before|after)/);

  const playerUsage = section.match(/<YouTubeBackingPlayer\s[\s\S]*?\/>/)?.[0] ?? "";
  assert.ok(playerUsage);
  assert.doesNotMatch(playerUsage, /\bdisabled=/);
  assert.match(playerUsage, /customControlsDisabled=\{disabled\}/);
  assert.match(playerUsage, /syncEnabled=\{source\.syncEnabled\}/);
});

test("a failed YouTube API load removes stale global and script state before retry", async () => {
  const loader = await source("youtube-iframe-api.ts");
  assert.match(loader, /const restoreReadyCallback = \(\) =>/);
  assert.match(loader, /script\?\.removeEventListener\("error", fail\)/);
  assert.match(loader, /if \(!window\.YT\?\.Player\) script\?\.remove\(\)/);
  assert.match(loader, /apiPromise = null/);
});

test("transport and saved sync callbacks use stable refs rather than parent callback identity", async () => {
  const section = await source("YouTubeBackingSection.tsx");

  assert.match(section, /onTransportChangeRef\.current\?\.\(transport\)/);
  assert.match(
    section,
    /onTransportChangeRef\.current\?\.\(transport\);[\s\S]*?onTransportChangeRef\.current\?\.\(null\);[\s\S]*?\}, \[transport\]\)/,
  );
  assert.match(section, /onSyncEnabledChange\?: \(enabled: boolean\) => void/);
  assert.match(section, /onSyncEnabledChangeRef\.current\?\.\(nextEnabled\)/);
  assert.match(section, /reportedSyncEnabledRef\.current/);
});

test("track strip retains 390px-friendly controls and keyboard focus treatment", async () => {
  const [section, sectionStyles, playerStyles] = await Promise.all([
    source("YouTubeBackingSection.tsx"),
    source("YouTubeBackingSection.module.css"),
    source("YouTubeBackingPlayer.module.css"),
  ]);

  assert.match(sectionStyles, /@media \(max-width:\s*460px\)/);
  assert.match(playerStyles, /@media \(max-width:\s*520px\)/);
  assert.match(sectionStyles, /@media \(min-width:\s*960px\)/);
  assert.match(sectionStyles, /grid-template-columns:\s*minmax\(360px, 720px\)/);
  assert.match(sectionStyles, /\.settingsDisclosure summary\s*\{[^}]*min-height:\s*44px/s);
  assert.match(sectionStyles, /:focus-visible[\s\S]*?outline:\s*2px solid #fff/);
  assert.match(playerStyles, /\.transport \.playButton\s*\{[^}]*min-width:\s*82px/s);
  assert.match(playerStyles, /@media \(max-width:\s*520px\)[\s\S]*?\.transport \.playButton\s*\{[^}]*min-height:\s*44px/s);
  assert.match(playerStyles, /@media \(max-width:\s*520px\)[\s\S]*?\.transport \.stopButton\s*\{[^}]*width:\s*44px[^}]*min-height:\s*44px/s);
  assert.match(playerStyles, /\.trackMeta dt\s*\{[^}]*font-size:\s*var\(--text-caption, 11px\)/s);
  assert.match(section, /lastPlayerErrorRef\.current/);
});

test("one global record control owns backing startup and measured take alignment", async () => {
  const [recording, advanced] = await Promise.all([
    readFile(path.join(directory, "..", "recording", "RecordingStudio.tsx"), "utf8"),
    readFile(path.join(directory, "..", "advanced-studio", "AdvancedStudioTools.tsx"), "utf8"),
  ]);

  assert.match(recording, /onSyncEnabledChange=\{setYouTubeSyncEnabled\}/);
  assert.match(recording, /youtubeSyncEnabled[\s\S]*?"백킹 \+ 새 테이크"/);
  assert.doesNotMatch(recording, /onStartRecording=/);
  const youtubeStart = advanced.indexOf("await youtubeTransport?.start()");
  const localStart = advanced.indexOf("await engine.playTracks(arrangement");
  assert.ok(youtubeStart >= 0 && localStart > youtubeStart);
  assert.match(
    advanced,
    /const primeRecordingMix[\s\S]*?stopPreview\(\);[\s\S]*?await youtubeTransport\?\.prime\(\);/,
  );
  assert.match(
    recording,
    /const playbackLeadMs = await recordingTransportRef\.current\?\.start\(\)[\s\S]*?recordingOffsetRef\.current = Math\.max\(0, Math\.round\(playbackLeadMs\)\);[\s\S]*?beginMediaRecorder\(stream\);/,
  );
});
