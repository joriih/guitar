import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

import {
  assertLoopbackDatabaseUrl,
  normalizedDatabaseHostname,
  resolvePostgresAdminUsername,
} from "./local-database-url.mjs";
import { SESSION_BEARING_BACKUP_EXCLUSIONS } from "./backup.mjs";

const PROJECT_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const SOURCE_DATABASE_NAME = "riff_sketchbook";
const APP_ROLE = "riff_sketchbook_app";
const shutdownController = new AbortController();

function handleShutdownSignal(signal) {
  if (shutdownController.signal.aborted) return;
  process.exitCode = signal === "SIGINT" ? 130 : 143;
  shutdownController.abort(new Error(`E2E interrupted by ${signal}.`));
}

process.once("SIGINT", handleShutdownSignal);
process.once("SIGTERM", handleShutdownSignal);

function timeoutSignal(milliseconds) {
  return AbortSignal.any([
    shutdownController.signal,
    AbortSignal.timeout(milliseconds),
  ]);
}

async function loadLocalEnv() {
  try {
    const source = await readFile(path.join(PROJECT_DIRECTORY, ".env.local"), "utf8");
    for (const line of source.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator < 1) continue;
      const key = trimmed.slice(0, separator).trim();
      let value = trimmed.slice(separator + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = value;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function postgresBinary(name) {
  return process.env.POSTGRES_BIN
    ? path.join(process.env.POSTGRES_BIN, name)
    : `/Applications/Postgres.app/Contents/Versions/latest/bin/${name}`;
}

function databaseEnvironment(databaseUrl) {
  return {
    ...process.env,
    PGHOST: normalizedDatabaseHostname(databaseUrl),
    PGPORT: databaseUrl.port || "5432",
    PGUSER: decodeURIComponent(databaseUrl.username),
    PGDATABASE: databaseUrl.pathname.slice(1),
    PGPASSWORD: decodeURIComponent(databaseUrl.password),
  };
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: PROJECT_DIRECTORY,
      env: options.env ?? process.env,
      signal: shutdownController.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(output);
      else {
        reject(
          new Error(
            `${path.basename(command)} failed (${signal ?? code}).\n${output.slice(-4_000)}`,
          ),
        );
      }
    });
  });
}

function quoteIdentifier(value) {
  if (!/^riff_sketchbook_e2e_[a-z0-9_]+$/.test(value)) {
    throw new Error("Unsafe isolated database name.");
  }
  return `"${value}"`;
}

async function findOpenPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve an isolated test port."));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForServer(origin, child, logBuffer, startupError) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (startupError()) {
      throw new Error("Test server failed to start.", { cause: startupError() });
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Test server exited early.\n${logBuffer().slice(-4_000)}`);
    }
    try {
      const response = await fetch(`${origin}/setup`, {
        signal: timeoutSignal(1_000),
      });
      if (response.ok) return;
    } catch (error) {
      if (shutdownController.signal.aborted) throw error;
      // The production server is still warming up.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Test server did not become ready.\n${logBuffer().slice(-4_000)}`);
}

function sessionCookie(response, cookieName) {
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(";", 1)[0] ?? "";
    const separator = pair.indexOf("=");
    if (separator > 0 && pair.slice(0, separator).trim() === cookieName) {
      return pair.trim();
    }
  }
  return null;
}

function assertSessionCookiePolicy(response, cookieName, { cleared = false } = {}) {
  const header = response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${cookieName}=`));
  assert.ok(header, `${cookieName} must be present in Set-Cookie`);
  assert.match(header, /;\s*HttpOnly(?:;|$)/i);
  assert.match(header, /;\s*SameSite=Strict(?:;|$)/i);
  assert.match(header, /;\s*Path=\/(?:;|$)/i);
  assert.doesNotMatch(
    header,
    /;\s*Secure(?:;|$)/i,
    "the isolated HTTP server must not issue an unusable Secure cookie",
  );
  if (cleared) {
    assert.equal(sessionCookie(response, cookieName), `${cookieName}=`);
    assert.match(header, /;\s*Expires=Thu, 01 Jan 1970 00:00:00 GMT(?:;|$)/i);
  }
  return sessionCookie(response, cookieName);
}

function assertNoStore(response, label) {
  assert.match(
    response.headers.get("cache-control") ?? "",
    /(?:^|,)\s*no-store\s*(?:,|$)/i,
    `${label} must prevent response caching`,
  );
}

function waitForChildExit(child, timeoutMs) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let timer;
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.removeListener("exit", handleExit);
      resolve(exited);
    };
    const handleExit = () => {
      finish(true);
    };
    child.once("exit", handleExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      finish(true);
      return;
    }
    timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
  });
}

async function stopChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForChildExit(child, 5_000)) return;
  child.kill("SIGKILL");
  if (!(await waitForChildExit(child, 5_000))) {
    throw new Error("Test server did not exit after SIGKILL.");
  }
}

function tinyWaveFile() {
  const frames = 800;
  const sampleRate = 8_000;
  const channels = 1;
  const bytesPerSample = 2;
  const dataBytes = frames * channels * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(bytesPerSample * 8, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    const value = Math.round(Math.sin((frame / sampleRate) * Math.PI * 2 * 220) * 4_000);
    buffer.writeInt16LE(value, 44 + frame * 2);
  }
  return buffer;
}

await loadLocalEnv();

const sourceUrl = assertLoopbackDatabaseUrl(
  process.env.DATABASE_URL ??
    `postgresql://${APP_ROLE}@127.0.0.1:5432/${SOURCE_DATABASE_NAME}`,
);
if (
  sourceUrl.pathname.slice(1) !== SOURCE_DATABASE_NAME ||
  decodeURIComponent(sourceUrl.username) !== APP_ROLE
) {
  throw new Error("E2E is restricted to the local Riff Sketchbook database configuration.");
}

const testDatabaseName = `riff_sketchbook_e2e_${process.pid}_${randomBytes(5).toString("hex")}`;
const quotedTestDatabaseName = quoteIdentifier(testDatabaseName);
const testUrl = new URL(sourceUrl);
testUrl.pathname = `/${testDatabaseName}`;
const restoreTestDatabaseName = `${testDatabaseName}_restore`;
const quotedRestoreTestDatabaseName = quoteIdentifier(restoreTestDatabaseName);
const restoreTestUrl = new URL(sourceUrl);
restoreTestUrl.pathname = `/${restoreTestDatabaseName}`;
const explicitAdminUrl = process.env.PG_ADMIN_URL;
const adminUrl = explicitAdminUrl
  ? assertLoopbackDatabaseUrl(explicitAdminUrl, "PG_ADMIN_URL")
  : new URL(sourceUrl);
adminUrl.pathname = "/postgres";
if (explicitAdminUrl) {
  if (process.env.PG_ADMIN_USER) adminUrl.username = process.env.PG_ADMIN_USER;
  if (process.env.PG_ADMIN_PASSWORD !== undefined) {
    adminUrl.password = process.env.PG_ADMIN_PASSWORD;
  }
} else {
  adminUrl.username = resolvePostgresAdminUsername(process.env);
  adminUrl.password = process.env.PG_ADMIN_PASSWORD ?? "";
}
if (
  (adminUrl.port || "5432") !== (sourceUrl.port || "5432")
) {
  throw new Error("E2E admin access must use the same local PostgreSQL cluster.");
}

const temporaryDirectory = await mkdtemp(
  path.join(os.tmpdir(), "riff-sketchbook-e2e-"),
);
const isolatedAudioNamespace = testDatabaseName;
const isolatedAudioRoot = path.join(PROJECT_DIRECTORY, "storage", "e2e");
const isolatedAudioDirectory = path.join(isolatedAudioRoot, isolatedAudioNamespace);
const schemaDump = path.join(temporaryDirectory, "schema.dump");
const admin = new Client({ connectionString: adminUrl.toString() });
let server = null;
let serverOutput = "";
let adminConnected = false;
let databaseCreated = false;
let restoreDatabaseCreated = false;
let audioDirectoryCreated = false;
let serverStartupError = null;
let testFailure = null;

try {
  const createdAudioDirectory = await mkdir(isolatedAudioDirectory, {
    recursive: true,
    mode: 0o700,
  });
  if (createdAudioDirectory === undefined) {
    throw new Error("The isolated E2E audio namespace already exists.");
  }
  audioDirectoryCreated = true;
  shutdownController.signal.throwIfAborted();

  await run(
    postgresBinary("pg_dump"),
    [
      "--format=custom",
      "--schema-only",
      "--no-owner",
      "--no-privileges",
      `--file=${schemaDump}`,
    ],
    { env: databaseEnvironment(sourceUrl) },
  );

  await admin.connect();
  adminConnected = true;
  await admin.query(
    `CREATE DATABASE ${quotedTestDatabaseName} OWNER ${APP_ROLE} ENCODING 'UTF8' TEMPLATE template0`,
  );
  databaseCreated = true;
  shutdownController.signal.throwIfAborted();
  await admin.query(`REVOKE ALL ON DATABASE ${quotedTestDatabaseName} FROM PUBLIC`);
  await admin.query(
    `GRANT CONNECT, TEMPORARY ON DATABASE ${quotedTestDatabaseName} TO ${APP_ROLE}`,
  );

  await run(
    postgresBinary("pg_restore"),
    [
      "--exit-on-error",
      "--no-owner",
      "--no-privileges",
      `--dbname=${testDatabaseName}`,
      schemaDump,
    ],
    { env: databaseEnvironment(testUrl) },
  );

  const migrationsDirectory = path.join(PROJECT_DIRECTORY, "scripts", "migrations");
  const migrationFiles = (await readdir(migrationsDirectory, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isFile() && /^\d{8}_[a-z0-9_-]+\.sql$/.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const migrationClient = new Client({ connectionString: testUrl.toString() });
  await migrationClient.connect();
  try {
    await migrationClient.query("BEGIN");
    for (const migrationFile of migrationFiles) {
      const migrationSql = (
        await readFile(path.join(migrationsDirectory, migrationFile), "utf8")
      ).trim();
      if (!migrationSql) throw new Error(`Empty database migration: ${migrationFile}`);
      await migrationClient.query(migrationSql);
    }
    await migrationClient.query("COMMIT");
  } catch (error) {
    await migrationClient.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await migrationClient.end();
  }

  const port = await findOpenPort();
  const origin = `http://127.0.0.1:${port}`;
  const cookieName = `riff_e2e_${process.pid}`;
  server = spawn(
    process.execPath,
    [
      path.join(PROJECT_DIRECTORY, "node_modules", "next", "dist", "bin", "next"),
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: PROJECT_DIRECTORY,
      signal: shutdownController.signal,
      env: {
        ...process.env,
        NODE_ENV: "production",
        NEXT_TELEMETRY_DISABLED: "1",
        DATABASE_URL: testUrl.toString(),
        APP_ORIGIN: origin,
        SESSION_COOKIE_NAME: cookieName,
        AUDIO_STORAGE_NAMESPACE: isolatedAudioNamespace,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.once("error", (error) => {
    serverStartupError = error;
    serverOutput += `\n${error.stack ?? error.message}`;
  });
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk;
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk;
  });
  await waitForServer(
    origin,
    server,
    () => serverOutput,
    () => serverStartupError,
  );

  let cookie = "";
  async function request(pathname, options = {}) {
    const headers = new Headers(options.headers);
    if (cookie) headers.set("cookie", cookie);
    if (options.withOrigin !== false && !headers.has("origin")) {
      headers.set("origin", origin);
    }
    if (options.json !== undefined) headers.set("content-type", "application/json");
    return fetch(`${origin}${pathname}`, {
      method: options.method ?? (options.json === undefined && !options.body ? "GET" : "POST"),
      headers,
      body: options.json === undefined ? options.body : JSON.stringify(options.json),
      redirect: "manual",
      signal: timeoutSignal(15_000),
    });
  }

  function requestTakeDuplicate(takeId, requestId = randomUUID()) {
    return request(`/api/takes/${takeId}/duplicate`, {
      method: "POST",
      json: { requestId },
    });
  }

  let response = await request("/api/albums");
  assert.equal(response.status, 401, "library must reject anonymous access");

  response = await request("/api/auth/setup", {
    json: { displayName: "E2E", username: "e2e", password: "e2e-password" },
    headers: { origin: "http://malicious.invalid" },
  });
  assert.equal(response.status, 403, "setup must reject a foreign Origin");
  assertNoStore(response, "setup origin error");

  response = await request("/api/auth/setup", {
    json: {
      displayName: "격리 테스트",
      username: "e2e",
      password: "e2e-password",
      remember: false,
    },
  });
  assert.equal(response.status, 201, "first setup should succeed");
  assertNoStore(response, "setup success");
  const setupCookie = assertSessionCookiePolicy(response, cookieName) ?? "";
  cookie = setupCookie;
  assert.ok(cookie, "setup must issue a session cookie");
  const setup = await response.json();
  assert.ok(setup.seeded?.riffId && setup.seeded?.albumId);

  response = await request("/api/auth/status", { withOrigin: false });
  assert.equal(response.status, 200);
  assertNoStore(response, "authenticated status");
  const authStatus = await response.json();
  assert.equal(authStatus.configured, true);
  assert.equal(authStatus.authenticated, true);

  response = await request("/api/auth/setup", {
    json: { displayName: "Again", username: "again", password: "e2e-password" },
  });
  assert.equal(response.status, 409, "setup must permanently close after first use");
  assertNoStore(response, "setup conflict");

  const albumCreateRequestId = randomUUID();
  const albumCreateInput = {
    requestId: albumCreateRequestId,
    name: "새벽 세션",
    description: "격리된 E2E 데이터",
    color: "#C4D4C8",
    coverAsset: "/assets/guitars/sonic-blue.avif",
  };
  const concurrentAlbumCreateResponses = await Promise.all([
    request("/api/albums", { method: "POST", json: albumCreateInput }),
    request("/api/albums", { method: "POST", json: albumCreateInput }),
  ]);
  assert.deepEqual(
    concurrentAlbumCreateResponses.map((item) => item.status).sort(),
    [200, 201],
    "concurrent album response-loss retries must create one row",
  );
  const albumCreatePayloads = await Promise.all(
    concurrentAlbumCreateResponses.map((item) => item.json()),
  );
  assert.equal(
    new Set(albumCreatePayloads.map((item) => item.album.id)).size,
    1,
    "concurrent album retries must return the same album",
  );
  assert.deepEqual(
    albumCreatePayloads.map((item) => item.idempotentReplay).sort(),
    [false, true],
  );
  let album = albumCreatePayloads[0].album;
  assert.equal(album.coverAsset, "/assets/guitars/sonic-blue.avif");
  assert.equal(album.revision, 0, "new albums must expose their initial revision");

  response = await request("/api/albums", {
    method: "POST",
    json: albumCreateInput,
  });
  assert.equal(response.status, 200, "a sequential album retry must replay");
  assertNoStore(response, "album create replay");
  const albumCreateReplay = await response.json();
  assert.equal(albumCreateReplay.album.id, album.id);
  assert.equal(albumCreateReplay.idempotentReplay, true);

  response = await request("/api/albums", {
    method: "POST",
    json: { ...albumCreateInput, name: "같은 키의 다른 앨범" },
  });
  assert.equal(response.status, 409, "an album request ID must bind to one payload");
  assertNoStore(response, "album create request conflict");

  response = await request("/api/albums");
  assert.equal(response.status, 200);
  assert.equal(
    (await response.json()).albums.find((item) => item.id === album.id)?.revision,
    0,
    "album lists must expose revisions",
  );

  response = await request(`/api/albums/${album.id}`, {
    method: "PATCH",
    json: { name: "missing revision" },
  });
  assert.equal(response.status, 400, "album PATCH must require an expected revision");

  response = await request(`/api/albums/${album.id}`, {
    method: "PATCH",
    json: {
      name: "새벽 세션 수정",
      color: "#AFC3B4",
      coverAsset: "/assets/guitars/vintage-sunburst.webp",
      expectedRevision: album.revision,
    },
  });
  assert.equal(response.status, 200);
  album = (await response.json()).album;
  assert.equal(album.name, "새벽 세션 수정");
  assert.equal(album.coverAsset, "/assets/guitars/vintage-sunburst.webp");
  assert.equal(album.revision, 1);

  response = await request(`/api/albums/${album.id}`, {
    method: "PATCH",
    json: {
      description: "unknown key must fail",
      expectedRevision: album.revision,
      unexpected: true,
    },
  });
  assert.equal(response.status, 400, "album PATCH bodies must reject unknown fields");

  const albumRevisionForConcurrentEdit = album.revision;
  const tabAAlbumDraft = {
    name: "탭 A 앨범 이름",
    description: album.description,
    color: album.color,
    coverAsset: album.coverAsset,
  };
  const tabBAlbumDraft = {
    name: album.name,
    description: "탭 B 앨범 메모",
    color: album.color,
    coverAsset: album.coverAsset,
  };
  const concurrentAlbumResponses = await Promise.all([
    request(`/api/albums/${album.id}`, {
      method: "PATCH",
      json: { ...tabAAlbumDraft, expectedRevision: albumRevisionForConcurrentEdit },
    }),
    request(`/api/albums/${album.id}`, {
      method: "PATCH",
      json: { ...tabBAlbumDraft, expectedRevision: albumRevisionForConcurrentEdit },
    }),
  ]);
  assert.deepEqual(
    concurrentAlbumResponses.map((item) => item.status).sort(),
    [200, 409],
    "only one stale album tab may commit for a revision",
  );
  const winningAlbumIndex = concurrentAlbumResponses.findIndex(
    (item) => item.status === 200,
  );
  const staleAlbumIndex = concurrentAlbumResponses.findIndex(
    (item) => item.status === 409,
  );
  assert.notEqual(winningAlbumIndex, -1);
  assert.notEqual(staleAlbumIndex, -1);
  album = (await concurrentAlbumResponses[winningAlbumIndex].json()).album;
  const staleAlbumResponse = concurrentAlbumResponses[staleAlbumIndex];
  const staleAlbumPayload = await staleAlbumResponse.json();
  assert.equal(staleAlbumPayload.current.revision, album.revision);
  assert.equal(staleAlbumPayload.current.name, album.name);
  assert.equal(staleAlbumPayload.current.description, album.description);
  assertNoStore(staleAlbumResponse, "stale album conflict");

  const reconciledAlbumDraft =
    winningAlbumIndex === 0
      ? { ...tabBAlbumDraft, name: album.name }
      : { ...tabAAlbumDraft, description: album.description };
  response = await request(`/api/albums/${album.id}`, {
    method: "PATCH",
    json: { ...reconciledAlbumDraft, expectedRevision: album.revision },
  });
  assert.equal(response.status, 200, "a stale album intent must be retryable after rebase");
  album = (await response.json()).album;
  assert.equal(album.name, tabAAlbumDraft.name);
  assert.equal(album.description, tabBAlbumDraft.description);
  assert.equal(album.revision, albumRevisionForConcurrentEdit + 2);

  response = await request(`/api/albums/${album.id}`, {
    method: "PATCH",
    json: {
      coverAsset: "https://untrusted.invalid/guitar.jpg",
      expectedRevision: album.revision,
    },
  });
  assert.equal(response.status, 400, "album covers must come from the local allowlist");

  const riffCreateRequestId = randomUUID();
  const riffCreateInput = {
    requestId: riffCreateRequestId,
    albumId: album.id,
    title: "E2E Midnight Riff",
    bpm: 128,
    musicalKey: "E minor",
    timeSignature: "4/4",
  };
  const concurrentRiffCreateResponses = await Promise.all([
    request("/api/riffs", { method: "POST", json: riffCreateInput }),
    request("/api/riffs", { method: "POST", json: riffCreateInput }),
  ]);
  assert.deepEqual(
    concurrentRiffCreateResponses.map((item) => item.status).sort(),
    [200, 201],
    "concurrent riff response-loss retries must create one row",
  );
  const riffCreatePayloads = await Promise.all(
    concurrentRiffCreateResponses.map((item) => item.json()),
  );
  assert.equal(
    new Set(riffCreatePayloads.map((item) => item.riff.id)).size,
    1,
    "concurrent riff retries must return the same riff",
  );
  assert.deepEqual(
    riffCreatePayloads.map((item) => item.idempotentReplay).sort(),
    [false, true],
  );
  let riff = riffCreatePayloads[0].riff;

  response = await request("/api/riffs", {
    method: "POST",
    json: riffCreateInput,
  });
  assert.equal(response.status, 200, "a sequential riff retry must replay");
  assertNoStore(response, "riff create replay");
  const riffCreateReplay = await response.json();
  assert.equal(riffCreateReplay.riff.id, riff.id);
  assert.equal(riffCreateReplay.idempotentReplay, true);

  response = await request("/api/riffs", {
    method: "POST",
    json: { ...riffCreateInput, title: "같은 키의 다른 리프" },
  });
  assert.equal(response.status, 409, "a riff request ID must bind to one payload");
  assertNoStore(response, "riff create request conflict");

  response = await request(`/api/riffs/${riff.id}`, {
    method: "PATCH",
    json: { notes: "missing revision" },
  });
  assert.equal(response.status, 400, "riff PATCH must require an expected revision");

  response = await request(`/api/riffs/${riff.id}`, {
    method: "PATCH",
    json: {
      notes: "저장 회귀 검사",
      tab: "e|--0--|",
      isFavorite: true,
      expectedRevision: riff.revision,
    },
  });
  assert.equal(response.status, 200);
  riff = (await response.json()).riff;
  assert.equal(riff.isFavorite, true);
  assert.equal(riff.revision, 1);

  const riffRevisionForConcurrentEdit = riff.revision;
  const concurrentRiffResponses = await Promise.all([
    request(`/api/riffs/${riff.id}`, {
      method: "PATCH",
      json: { notes: "tab A", expectedRevision: riffRevisionForConcurrentEdit },
    }),
    request(`/api/riffs/${riff.id}`, {
      method: "PATCH",
      json: { notes: "tab B", expectedRevision: riffRevisionForConcurrentEdit },
    }),
  ]);
  assert.deepEqual(
    concurrentRiffResponses.map((item) => item.status).sort(),
    [200, 409],
    "only one concurrent riff metadata PATCH may commit for a revision",
  );
  const winningRiffResponse = concurrentRiffResponses.find((item) => item.status === 200);
  const staleRiffResponse = concurrentRiffResponses.find((item) => item.status === 409);
  assert.ok(winningRiffResponse && staleRiffResponse);
  riff = (await winningRiffResponse.json()).riff;
  const staleRiffPayload = await staleRiffResponse.json();
  assert.equal(staleRiffPayload.current.revision, riff.revision);
  assert.equal(staleRiffPayload.current.notes, riff.notes);
  assertNoStore(staleRiffResponse, "stale riff metadata conflict");

  response = await request(`/api/riffs/${riff.id}/tags`, {
    method: "POST",
    json: { name: "# Night   Drive" },
  });
  assert.equal(response.status, 201);
  const nightTag = (await response.json()).tag;
  assert.equal(nightTag.name, "Night Drive");
  response = await request(`/api/riffs/${riff.id}/tags`, {
    method: "POST",
    json: { name: "night drive" },
  });
  assert.equal(response.status, 200, "case-insensitive duplicate tags must be idempotent");
  assert.equal((await response.json()).tag.id, nightTag.id);
  response = await request(`/api/riffs/${setup.seeded.riffId}/tags`, {
    method: "POST",
    json: { name: "NIGHT DRIVE" },
  });
  assert.equal(response.status, 201, "the same normalized tag can be shared by riffs");
  assert.equal((await response.json()).tag.id, nightTag.id);
  response = await request("/api/tags?q=night");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).tags[0]?.usageCount, 2);
  response = await request(`/api/riffs/${riff.id}/tags/${nightTag.id}`, {
    method: "DELETE",
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).tags.length, 0);
  response = await request(`/api/riffs/${riff.id}/tags`, {
    method: "POST",
    json: { name: "Night Drive" },
  });
  assert.equal(response.status, 201);
  response = await request(`/api/riffs/${riff.id}/tags`, {
    method: "POST",
    json: { name: "Verse" },
  });
  assert.equal(response.status, 201);
  response = await request(`/api/riffs/${riff.id}/tags`, {
    method: "POST",
    json: { name: "###" },
  });
  assert.equal(response.status, 400, "blank normalized tag names must be rejected");

  const youtubeBackingPath = `/api/riffs/${riff.id}/youtube-backing`;
  const audioFilesBeforeYouTubeBacking = (
    await readdir(isolatedAudioDirectory)
  ).sort();
  response = await request(youtubeBackingPath, { withOrigin: false });
  assert.equal(response.status, 200, "an empty riff must expose no YouTube backing");
  assertNoStore(response, "empty YouTube backing");
  assert.equal((await response.json()).youtubeBacking, null);

  for (const unsafeUrl of [
    "not-a-youtube-url",
    "https://www.youtube.com.evil.invalid/watch?v=dQw4w9WgXcQ",
  ]) {
    response = await request(youtubeBackingPath, {
      method: "PUT",
      json: {
        url: unsafeUrl,
        name: "Unsafe reference",
        sourceStartMs: 0,
        volume: 1,
        syncEnabled: false,
        expectedRevision: null,
      },
    });
    assert.equal(response.status, 400, `${unsafeUrl} must be rejected`);
    assertNoStore(response, "invalid YouTube backing URL");
  }
  assert.deepEqual(
    (await readdir(isolatedAudioDirectory)).sort(),
    audioFilesBeforeYouTubeBacking,
    "YouTube URL validation must not write an audio file",
  );

  const youtubeCreateInput = {
    url: "https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ",
    name: "  Midnight reference  ",
    sourceStartMs: 4_250,
    volume: 0.65,
    syncEnabled: true,
    expectedRevision: null,
  };
  response = await request(youtubeBackingPath, {
    method: "PUT",
    json: youtubeCreateInput,
  });
  assert.equal(response.status, 201, "a YouTube backing must be creatable once");
  assertNoStore(response, "YouTube backing creation");
  let youtubeBacking = (await response.json()).youtubeBacking;
  assert.ok(youtubeBacking.id);
  assert.deepEqual(
    {
      riffId: youtubeBacking.riffId,
      videoId: youtubeBacking.videoId,
      url: youtubeBacking.url,
      name: youtubeBacking.name,
      sourceStartMs: youtubeBacking.sourceStartMs,
      volume: youtubeBacking.volume,
      syncEnabled: youtubeBacking.syncEnabled,
      revision: youtubeBacking.revision,
    },
    {
      riffId: riff.id,
      videoId: "dQw4w9WgXcQ",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      name: "Midnight reference",
      sourceStartMs: 4_250,
      volume: 0.65,
      syncEnabled: true,
      revision: 0,
    },
    "YouTube backing responses must expose normalized authoritative values",
  );

  response = await request(youtubeBackingPath, {
    method: "PUT",
    json: youtubeCreateInput,
  });
  assert.equal(response.status, 200, "a response-loss YouTube PUT must replay");
  assertNoStore(response, "YouTube backing response-loss replay");
  assert.equal((await response.json()).youtubeBacking.id, youtubeBacking.id);

  const youtubeReplayDb = new Client({ connectionString: testUrl.toString() });
  await youtubeReplayDb.connect();
  try {
    assert.equal(
      Number(
        (
          await youtubeReplayDb.query(
            "SELECT count(*) FROM riff_youtube_backing WHERE riff_id = $1",
            [riff.id],
          )
        ).rows[0].count,
      ),
      1,
      "a response-loss YouTube PUT must leave exactly one row",
    );
  } finally {
    await youtubeReplayDb.end();
  }

  response = await request(youtubeBackingPath, {
    method: "PUT",
    json: { ...youtubeCreateInput, name: "Different payload" },
  });
  assert.equal(
    response.status,
    409,
    "a different create payload must not overwrite an existing YouTube backing",
  );
  assertNoStore(response, "YouTube backing create conflict");
  let youtubeConflict = await response.json();
  assert.equal(youtubeConflict.current.id, youtubeBacking.id);
  assert.equal(youtubeConflict.current.name, youtubeBacking.name);
  assert.equal(youtubeConflict.current.revision, youtubeBacking.revision);

  response = await request(youtubeBackingPath, {
    method: "PUT",
    json: {
      url: "https://youtu.be/9bZkp7q19f0?si=e2e",
      name: "  Updated reference  ",
      sourceStartMs: 9_000,
      volume: 0.4,
      syncEnabled: false,
      expectedRevision: youtubeBacking.revision,
    },
  });
  assert.equal(response.status, 200, "a current YouTube revision must update");
  assertNoStore(response, "YouTube backing update");
  youtubeBacking = (await response.json()).youtubeBacking;
  assert.deepEqual(
    {
      id: youtubeBacking.id,
      videoId: youtubeBacking.videoId,
      url: youtubeBacking.url,
      name: youtubeBacking.name,
      sourceStartMs: youtubeBacking.sourceStartMs,
      volume: youtubeBacking.volume,
      syncEnabled: youtubeBacking.syncEnabled,
      revision: youtubeBacking.revision,
    },
    {
      id: youtubeConflict.current.id,
      videoId: "9bZkp7q19f0",
      url: "https://www.youtube.com/watch?v=9bZkp7q19f0",
      name: "Updated reference",
      sourceStartMs: 9_000,
      volume: 0.4,
      syncEnabled: false,
      revision: 1,
    },
  );

  response = await request(youtubeBackingPath, {
    method: "PUT",
    json: {
      ...youtubeCreateInput,
      name: "Stale edit",
      expectedRevision: youtubeBacking.revision - 1,
    },
  });
  assert.equal(response.status, 409, "a stale YouTube PUT must preserve newer settings");
  assertNoStore(response, "stale YouTube backing update");
  youtubeConflict = await response.json();
  assert.equal(youtubeConflict.current.id, youtubeBacking.id);
  assert.equal(youtubeConflict.current.name, youtubeBacking.name);
  assert.equal(youtubeConflict.current.revision, youtubeBacking.revision);

  response = await request(youtubeBackingPath, {
    method: "DELETE",
    json: { expectedRevision: youtubeBacking.revision - 1 },
  });
  assert.equal(response.status, 409, "a stale YouTube DELETE must preserve the reference");
  assertNoStore(response, "stale YouTube backing deletion");
  youtubeConflict = await response.json();
  assert.equal(youtubeConflict.current.id, youtubeBacking.id);
  assert.equal(youtubeConflict.current.revision, youtubeBacking.revision);

  response = await request(youtubeBackingPath, {
    method: "DELETE",
    json: { expectedRevision: youtubeBacking.revision },
  });
  assert.equal(response.status, 200, "the current YouTube revision must delete");
  assertNoStore(response, "YouTube backing deletion");
  assert.deepEqual(await response.json(), { deleted: true, alreadyDeleted: false });
  response = await request(youtubeBackingPath, { withOrigin: false });
  assert.equal(response.status, 200);
  assertNoStore(response, "deleted YouTube backing");
  assert.equal((await response.json()).youtubeBacking, null);
  assert.deepEqual(
    (await readdir(isolatedAudioDirectory)).sort(),
    audioFilesBeforeYouTubeBacking,
    "the complete YouTube backing lifecycle must not touch audio storage",
  );

  response = await request(youtubeBackingPath, {
    method: "PUT",
    json: {
      url: "https://www.youtube.com/shorts/kJQP7kiw5Fk?feature=share",
      name: "  Duplicate reference  ",
      sourceStartMs: 12_345,
      volume: 0.55,
      syncEnabled: true,
      expectedRevision: null,
    },
  });
  assert.equal(response.status, 201, "a deleted YouTube backing must be recreatable");
  const youtubeBackingForDuplicate = (await response.json()).youtubeBacking;
  assert.equal(youtubeBackingForDuplicate.revision, 0);
  assert.deepEqual(
    (await readdir(isolatedAudioDirectory)).sort(),
    audioFilesBeforeYouTubeBacking,
    "a recreated YouTube reference must still leave audio storage untouched",
  );

  const wave = tinyWaveFile();
  const recoveryId = randomUUID();
  const takeForm = new FormData();
  takeForm.set("audio", new File([wave], "take.wav", { type: "audio/wav" }));
  takeForm.set("name", "격리 테이크");
  takeForm.set("durationMs", "2000");
  takeForm.set("recoveryId", recoveryId);
  response = await request(`/api/riffs/${riff.id}/takes`, {
    method: "POST",
    body: takeForm,
  });
  assert.equal(response.status, 201);
  let take = (await response.json()).take;
  assert.equal(take.isPrimary, true);

  const replayForm = new FormData();
  replayForm.set("audio", new File([wave], "take-retry.wav", { type: "audio/wav" }));
  replayForm.set("name", "응답 유실 재시도");
  replayForm.set("durationMs", "2000");
  replayForm.set("recoveryId", recoveryId);
  response = await request(`/api/riffs/${riff.id}/takes`, {
    method: "POST",
    body: replayForm,
  });
  assert.equal(response.status, 200, "a committed recording retry must be idempotent");
  const replayPayload = await response.json();
  assert.equal(replayPayload.take.id, take.id);
  assert.equal(replayPayload.idempotentReplay, true);
  assert.equal((await readdir(isolatedAudioDirectory)).length, 1);

  const invalidRecoveryForm = new FormData();
  invalidRecoveryForm.set(
    "audio",
    new File([wave], "invalid-recovery.wav", { type: "audio/wav" }),
  );
  invalidRecoveryForm.set("durationMs", "2000");
  invalidRecoveryForm.set("recoveryId", "not-a-uuid");
  response = await request(`/api/riffs/${riff.id}/takes`, {
    method: "POST",
    body: invalidRecoveryForm,
  });
  assert.equal(response.status, 400, "recording recovery IDs must be strict UUIDs");
  assert.equal((await readdir(isolatedAudioDirectory)).length, 1);

  const concurrentRecoveryId = randomUUID();
  const concurrentTakeForm = () => {
    const form = new FormData();
    form.set("audio", new File([wave], "concurrent.wav", { type: "audio/wav" }));
    form.set("durationMs", "2000");
    form.set("recoveryId", concurrentRecoveryId);
    return form;
  };
  const concurrentTakeResponses = await Promise.all([
    request(`/api/riffs/${riff.id}/takes`, {
      method: "POST",
      body: concurrentTakeForm(),
    }),
    request(`/api/riffs/${riff.id}/takes`, {
      method: "POST",
      body: concurrentTakeForm(),
    }),
  ]);
  assert.deepEqual(
    concurrentTakeResponses.map((item) => item.status).sort(),
    [200, 201],
    "only one concurrent recording retry may create a take",
  );
  const concurrentTakePayloads = await Promise.all(
    concurrentTakeResponses.map((item) => item.json()),
  );
  assert.equal(
    new Set(concurrentTakePayloads.map((item) => item.take.id)).size,
    1,
    "concurrent retries must return the same take",
  );
  assert.equal(
    (await readdir(isolatedAudioDirectory)).length,
    2,
    "concurrent retries must compensate the losing audio file",
  );
  response = await request(`/api/takes/${concurrentTakePayloads[0].take.id}`, {
    method: "DELETE",
    json: { expectedRevision: concurrentTakePayloads[0].take.revision },
  });
  assert.equal(response.status, 200, "a take outside Comp must remain deletable");
  assert.equal((await readdir(isolatedAudioDirectory)).length, 1);

  const legacyImportForm = new FormData();
  legacyImportForm.set(
    "audio",
    new File([wave], "legacy-import.wav", { type: "audio/wav" }),
  );
  legacyImportForm.set("durationMs", "2000");
  response = await request(`/api/riffs/${riff.id}/takes`, {
    method: "POST",
    body: legacyImportForm,
  });
  assert.equal(response.status, 201, "uploads without a recovery ID must remain compatible");
  const legacyImportTake = (await response.json()).take;
  response = await request(`/api/takes/${legacyImportTake.id}`, {
    method: "DELETE",
    json: { expectedRevision: legacyImportTake.revision },
  });
  assert.equal(response.status, 200);
  assert.equal((await readdir(isolatedAudioDirectory)).length, 1);

  response = await request(`/api/takes/${take.id}`, {
    method: "PATCH",
    json: {
      trimStartMs: 100,
      trimEndMs: 1900,
      offsetMs: 50,
      expectedRevision: take.revision,
    },
  });
  assert.equal(response.status, 200);
  take = (await response.json()).take;

  response = await request(`/api/takes/${take.id}`, {
    method: "PATCH",
    json: { name: "stale take", expectedRevision: take.revision - 1 },
  });
  assert.equal(response.status, 409, "stale take PATCH must not overwrite a newer take");
  const staleTakePayload = await response.json();
  assert.equal(staleTakePayload.current.revision, take.revision);
  assert.equal(staleTakePayload.current.name, take.name);
  assertNoStore(response, "stale take PATCH conflict");

  const takeRevisionForConcurrentEdit = take.revision;
  const concurrentTakePatchResponses = await Promise.all([
    request(`/api/takes/${take.id}`, {
      method: "PATCH",
      json: { name: "Take tab A", expectedRevision: takeRevisionForConcurrentEdit },
    }),
    request(`/api/takes/${take.id}`, {
      method: "PATCH",
      json: { name: "Take tab B", expectedRevision: takeRevisionForConcurrentEdit },
    }),
  ]);
  assert.deepEqual(
    concurrentTakePatchResponses.map((item) => item.status).sort(),
    [200, 409],
    "only one concurrent take PATCH may commit for a revision",
  );
  const winningTakePatch = concurrentTakePatchResponses.find((item) => item.status === 200);
  const staleTakePatch = concurrentTakePatchResponses.find((item) => item.status === 409);
  assert.ok(winningTakePatch && staleTakePatch);
  take = (await winningTakePatch.json()).take;
  const concurrentStaleTakePayload = await staleTakePatch.json();
  assert.equal(concurrentStaleTakePayload.current.revision, take.revision);
  assert.equal(concurrentStaleTakePayload.current.name, take.name);

  response = await request(`/api/takes/${take.id}/duplicate`, {
    method: "POST",
    json: {},
  });
  assert.equal(response.status, 400, "take duplicate must require an operation ID");
  response = await request(`/api/takes/${take.id}/duplicate`, {
    method: "POST",
    json: { requestId: "not-a-uuid" },
  });
  assert.equal(response.status, 400, "take duplicate operation IDs must be strict UUIDs");
  response = await request(`/api/takes/${take.id}/duplicate`, {
    method: "POST",
    json: { requestId: randomUUID(), unexpected: true },
  });
  assert.equal(response.status, 400, "take duplicate bodies must reject unknown fields");

  const takeDuplicateRequestId = randomUUID();
  const duplicateTakeResponses = await Promise.all([
    requestTakeDuplicate(take.id, takeDuplicateRequestId),
    requestTakeDuplicate(take.id, takeDuplicateRequestId),
  ]);
  assert.deepEqual(
    duplicateTakeResponses.map((item) => item.status).sort(),
    [200, 201],
    "concurrent take duplicate retries must create exactly one take",
  );
  const duplicateTakePayloads = await Promise.all(
    duplicateTakeResponses.map((item) => item.json()),
  );
  assert.equal(
    new Set(duplicateTakePayloads.map((item) => item.take.id)).size,
    1,
    "concurrent take duplicate retries must return the same take",
  );
  let duplicateTake = duplicateTakePayloads[0].take;
  response = await requestTakeDuplicate(take.id, takeDuplicateRequestId);
  assert.equal(response.status, 200, "sequential take duplicate retries must replay");
  assert.equal((await response.json()).take.id, duplicateTake.id);
  response = await requestTakeDuplicate(duplicateTake.id, takeDuplicateRequestId);
  assert.equal(
    response.status,
    409,
    "a take duplicate operation ID must not be reused for another source",
  );
  assert.equal(
    (await readdir(isolatedAudioDirectory)).length,
    2,
    "take duplicate retries and key conflicts must not create extra audio files",
  );

  response = await request(`/api/takes/${duplicateTake.id}`, {
    method: "PATCH",
    json: { isPrimary: true, expectedRevision: duplicateTake.revision },
  });
  assert.equal(response.status, 200, "a second take must be promotable without a unique conflict");
  duplicateTake = (await response.json()).take;
  assert.equal(duplicateTake.isPrimary, true);
  response = await request(`/api/riffs/${riff.id}/takes`);
  let currentTakes = (await response.json()).takes;
  take = currentTakes.find((item) => item.id === take.id);
  assert.ok(take);
  assert.equal(take.isPrimary, false);
  response = await request(`/api/takes/${take.id}`, {
    method: "PATCH",
    json: { isPrimary: true, expectedRevision: take.revision },
  });
  assert.equal(response.status, 200, "the original take must be promotable again");
  take = (await response.json()).take;
  response = await request(`/api/riffs/${riff.id}/takes`);
  currentTakes = (await response.json()).takes;
  duplicateTake = currentTakes.find((item) => item.id === duplicateTake.id);
  assert.ok(duplicateTake);
  assert.equal(duplicateTake.isPrimary, false);

  response = await request(`/api/takes/${take.id}/split`, {
    method: "POST",
    json: { splitMs: 1000, expectedRevision: take.revision },
  });
  assert.equal(response.status, 201);
  const splitTakes = (await response.json()).takes;
  assert.equal(splitTakes.length, 2);
  take = splitTakes.find((item) => item.id === take.id);
  assert.ok(take);

  response = await request(`/api/riffs/${riff.id}/comp`, { withOrigin: false });
  assert.equal(response.status, 200);
  let compPayload = await response.json();
  let compRevision = compPayload.revision;
  assert.equal(compRevision, 0);

  response = await request(`/api/riffs/${riff.id}/comp`, {
    method: "PUT",
    json: { segments: [] },
  });
  assert.equal(response.status, 400, "Comp replacement must require an expected revision");

  response = await request(`/api/riffs/${riff.id}/comp`, {
    method: "PUT",
    json: {
      expectedRevision: compRevision,
      segments: [
        { takeId: take.id, startMs: 100, endMs: 900 },
        { takeId: duplicateTake.id, startMs: 1000, endMs: 1700 },
      ],
    },
  });
  assert.equal(response.status, 200);
  compPayload = await response.json();
  assert.equal(compPayload.segments.length, 2);
  compRevision = compPayload.revision;
  assert.equal(compRevision, 1);

  const concurrentCompResponses = await Promise.all([
    request(`/api/riffs/${riff.id}/comp`, {
      method: "PUT",
      json: {
        expectedRevision: compRevision,
        segments: [
          { takeId: take.id, startMs: 100, endMs: 850 },
          { takeId: duplicateTake.id, startMs: 950, endMs: 1700 },
        ],
      },
    }),
    request(`/api/riffs/${riff.id}/comp`, {
      method: "PUT",
      json: {
        expectedRevision: compRevision,
        segments: [
          { takeId: take.id, startMs: 150, endMs: 900 },
          { takeId: duplicateTake.id, startMs: 1000, endMs: 1650 },
        ],
      },
    }),
  ]);
  assert.deepEqual(
    concurrentCompResponses.map((item) => item.status).sort(),
    [200, 409],
    "only one concurrent Comp replacement may commit for a revision",
  );
  const winningCompResponse = concurrentCompResponses.find(
    (item) => item.status === 200,
  );
  assert.ok(winningCompResponse);
  compPayload = await winningCompResponse.json();
  compRevision = compPayload.revision;
  assert.equal(compRevision, 2);

  response = await request(`/api/takes/${take.id}`, {
    method: "DELETE",
    json: { expectedRevision: take.revision },
  });
  assert.equal(response.status, 409, "a take referenced by Comp must not be deleted");
  assertNoStore(response, "Comp-referenced take deletion conflict");
  const referencedTakeDeleteError = await response.json();
  assert.match(referencedTakeDeleteError.error, /Comp.*먼저 제거/);
  assert.equal(
    (await readdir(isolatedAudioDirectory)).length,
    3,
    "a blocked take deletion must keep every audio file",
  );
  response = await request(`/api/riffs/${riff.id}/comp`, { withOrigin: false });
  assert.equal(response.status, 200);
  compPayload = await response.json();
  assert.equal(compPayload.segments.length, 2);
  assert.equal(compPayload.revision, compRevision);

  response = await request(`/api/riffs/${riff.id}/comp`, {
    method: "PUT",
    json: {
      expectedRevision: compRevision,
      segments: [{ takeId: take.id, startMs: 0, endMs: 2500 }],
    },
  });
  assert.equal(response.status, 400, "Comp must stay inside the recorded audio");

  response = await request(`/api/riffs/${riff.id}/markers`, {
    method: "POST",
    json: { positionMs: 500, label: "Missing request ID", color: "sky" },
  });
  assert.equal(response.status, 400, "marker creation must require an operation ID");
  response = await request(`/api/riffs/${riff.id}/markers`, {
    method: "POST",
    json: {
      requestId: randomUUID(),
      positionMs: 500,
      label: "Verse",
      color: "sky",
      unexpected: true,
    },
  });
  assert.equal(response.status, 400, "marker creation must reject unknown fields");
  response = await request(`/api/riffs/${riff.id}/markers`, {
    method: "POST",
    json: {
      requestId: randomUUID(),
      positionMs: 500,
      label: "Unsafe color",
      color: "neon",
    },
  });
  assert.equal(response.status, 400, "marker colors must come from the preset allowlist");
  const markerCreateRequestId = randomUUID();
  const markerCreateInput = {
    requestId: markerCreateRequestId,
    positionMs: 500,
    label: "  Verse  1  ",
    color: "sky",
  };
  const concurrentMarkerCreateResponses = await Promise.all([
    request(`/api/riffs/${riff.id}/markers`, {
      method: "POST",
      json: markerCreateInput,
    }),
    request(`/api/riffs/${riff.id}/markers`, {
      method: "POST",
      json: markerCreateInput,
    }),
  ]);
  assert.deepEqual(
    concurrentMarkerCreateResponses.map((item) => item.status).sort(),
    [200, 201],
    "concurrent marker retries must create exactly one row",
  );
  const concurrentMarkerCreatePayloads = await Promise.all(
    concurrentMarkerCreateResponses.map((item) => item.json()),
  );
  assert.equal(
    new Set(concurrentMarkerCreatePayloads.map((item) => item.marker.id)).size,
    1,
    "concurrent marker retries must return the same marker",
  );
  let marker = concurrentMarkerCreatePayloads[0].marker;
  assert.equal(marker.label, "Verse 1");
  assert.equal(marker.revision, 0);
  assert.equal(marker.clientRequestId, markerCreateRequestId);
  response = await request(`/api/riffs/${riff.id}/markers`, {
    method: "POST",
    json: markerCreateInput,
  });
  assert.equal(response.status, 200, "a sequential marker retry must replay");
  assert.equal((await response.json()).marker.id, marker.id);
  response = await request(`/api/riffs/${riff.id}/markers`, {
    method: "POST",
    json: { ...markerCreateInput, positionMs: 501 },
  });
  assert.equal(
    response.status,
    409,
    "a marker request ID must reject a different payload",
  );
  assertNoStore(response, "marker create request mismatch");
  response = await request(`/api/riffs/${riff.id}/markers`, { withOrigin: false });
  assert.equal(response.status, 200);
  assertNoStore(response, "marker list");
  assert.equal((await response.json()).markers.length, 1);
  const concurrentMarkerResponses = await Promise.all([
    request(`/api/markers/${marker.id}`, {
      method: "PATCH",
      json: { revision: 0, label: "Concurrent A" },
    }),
    request(`/api/markers/${marker.id}`, {
      method: "PATCH",
      json: { revision: 0, label: "Concurrent B" },
    }),
  ]);
  assert.deepEqual(
    concurrentMarkerResponses.map((item) => item.status).sort(),
    [200, 409],
    "only one concurrent marker PATCH may commit for a revision",
  );
  const winningMarkerResponse = concurrentMarkerResponses.find((item) => item.status === 200);
  assert.ok(winningMarkerResponse);
  marker = (await winningMarkerResponse.json()).marker;
  assert.equal(marker.revision, 1);
  response = await request(`/api/markers/${marker.id}`, {
    method: "PATCH",
    json: { revision: marker.revision, positionMs: 750, label: "Intro", color: "amber" },
  });
  assert.equal(response.status, 200);
  marker = (await response.json()).marker;
  assert.equal(marker.revision, 2);
  assert.equal(marker.positionMs, 750);
  response = await request(`/api/markers/${marker.id}`, {
    method: "PATCH",
    json: { revision: 0, label: "Stale edit" },
  });
  assert.equal(response.status, 409, "stale marker revisions must not overwrite newer edits");
  response = await request(`/api/riffs/${riff.id}/markers`, {
    method: "POST",
    json: {
      requestId: randomUUID(),
      positionMs: 1_500,
      label: "Disposable",
      color: "slate",
    },
  });
  assert.equal(response.status, 201);
  let disposableMarker = (await response.json()).marker;
  response = await request(`/api/markers/${disposableMarker.id}`, { method: "DELETE" });
  assert.equal(response.status, 400, "marker DELETE must require an expected revision");
  response = await request(`/api/markers/${disposableMarker.id}`, {
    method: "PATCH",
    json: { revision: disposableMarker.revision, label: "Disposable updated" },
  });
  assert.equal(response.status, 200);
  disposableMarker = (await response.json()).marker;
  response = await request(`/api/markers/${disposableMarker.id}`, {
    method: "DELETE",
    json: { revision: disposableMarker.revision - 1 },
  });
  assert.equal(response.status, 409, "stale marker DELETE must preserve a newer marker");
  assertNoStore(response, "stale marker deletion conflict");
  response = await request(`/api/markers/${disposableMarker.id}`, {
    method: "DELETE",
    json: { revision: disposableMarker.revision },
  });
  assert.equal(response.status, 200);
  response = await request(`/api/markers/${disposableMarker.id}`, {
    method: "DELETE",
    json: { revision: disposableMarker.revision },
  });
  assert.equal(response.status, 404, "a replayed marker DELETE must be safely absent");
  response = await request(`/api/riffs/${riff.id}/markers`, { withOrigin: false });
  assert.equal(response.status, 200);
  assert.equal(
    (await response.json()).markers.some((item) => item.id === disposableMarker.id),
    false,
    "a committed marker DELETE must be visible through immediate list reconciliation",
  );

  const markerCapDb = new Client({ connectionString: testUrl.toString() });
  const capMarkerIds = Array.from({ length: 63 }, () => randomUUID());
  await markerCapDb.connect();
  try {
    await markerCapDb.query(
      `INSERT INTO riff_marker
         (id, riff_id, position_ms, label, color, sort_order)
       SELECT marker_id, $1, 2000 + ordinal::integer,
              'Cap ' || ordinal, 'slate', ordinal::integer
         FROM unnest($2::uuid[]) WITH ORDINALITY AS generated(marker_id, ordinal)`,
      [riff.id, capMarkerIds],
    );
    response = await request(`/api/riffs/${riff.id}/markers`, {
      method: "POST",
      json: {
        requestId: randomUUID(),
        positionMs: 9_000,
        label: "Over limit",
        color: "rose",
      },
    });
    assert.equal(response.status, 409, "a riff must stop at the 64 marker cap");
  } finally {
    await markerCapDb.query("DELETE FROM riff_marker WHERE id = ANY($1::uuid[])", [
      capMarkerIds,
    ]).catch(() => undefined);
    await markerCapDb.end();
  }

  const audioFilesBeforeTrackCreate = (await readdir(isolatedAudioDirectory)).length;
  const missingTrackRequestForm = new FormData();
  missingTrackRequestForm.set(
    "audio",
    new File([wave], "missing-request.wav", { type: "audio/wav" }),
  );
  response = await request(`/api/riffs/${riff.id}/tracks`, {
    method: "POST",
    body: missingTrackRequestForm,
  });
  assert.equal(response.status, 400, "track creation must require an operation ID");
  assert.equal(
    (await readdir(isolatedAudioDirectory)).length,
    audioFilesBeforeTrackCreate,
    "a missing track request ID must not write a file",
  );

  const trackCreateRequestId = randomUUID();
  const trackForm = (audio = wave) => {
    const form = new FormData();
    form.set("audio", new File([audio], "backing.wav", { type: "audio/wav" }));
    form.set("kind", "backing");
    form.set("name", "격리 반주");
    form.set("durationMs", "2000");
    form.set("requestId", trackCreateRequestId);
    return form;
  };
  const concurrentTrackCreateResponses = await Promise.all([
    request(`/api/riffs/${riff.id}/tracks`, {
      method: "POST",
      body: trackForm(),
    }),
    request(`/api/riffs/${riff.id}/tracks`, {
      method: "POST",
      body: trackForm(),
    }),
  ]);
  assert.deepEqual(
    concurrentTrackCreateResponses.map((item) => item.status).sort(),
    [200, 201],
    "concurrent track retries must create exactly one row and file",
  );
  const concurrentTrackCreatePayloads = await Promise.all(
    concurrentTrackCreateResponses.map((item) => item.json()),
  );
  assert.equal(
    new Set(concurrentTrackCreatePayloads.map((item) => item.track.id)).size,
    1,
    "concurrent track retries must return the same track",
  );
  let track = concurrentTrackCreatePayloads[0].track;
  assert.equal(track.clientRequestId, trackCreateRequestId);
  assert.equal(
    (await readdir(isolatedAudioDirectory)).length,
    audioFilesBeforeTrackCreate + 1,
    "concurrent track retries must leave one new audio file",
  );
  response = await request(`/api/riffs/${riff.id}/tracks`, {
    method: "POST",
    body: trackForm(),
  });
  assert.equal(response.status, 200, "a sequential track retry must replay");
  assert.equal((await response.json()).track.id, track.id);

  const differentWave = Buffer.from(wave);
  differentWave[differentWave.length - 1] ^= 0xff;
  response = await request(`/api/riffs/${riff.id}/tracks`, {
    method: "POST",
    body: trackForm(differentWave),
  });
  assert.equal(
    response.status,
    409,
    "a track request ID must reject a different audio source",
  );
  assertNoStore(response, "track create source mismatch");
  assert.equal(
    (await readdir(isolatedAudioDirectory)).length,
    audioFilesBeforeTrackCreate + 1,
    "a source mismatch must not write another audio file",
  );

  response = await request(`/api/tracks/${track.id}`, {
    method: "PATCH",
    json: { volume: 0.5 },
  });
  assert.equal(response.status, 400, "track PATCH must require an expected revision");

  response = await request(`/api/tracks/${track.id}`, {
    method: "PATCH",
    json: {
      volume: 0.7,
      pan: -0.2,
      fadeInMs: 100,
      fadeOutMs: 150,
      offsetMs: 40,
      expectedRevision: track.revision,
    },
  });
  assert.equal(response.status, 200);
  track = (await response.json()).track;
  assert.equal(track.volume, 0.7);

  response = await request(`/api/tracks/${track.id}`, {
    method: "PATCH",
    json: { volume: 0.2, expectedRevision: track.revision - 1 },
  });
  assert.equal(response.status, 409, "stale track PATCH must not overwrite newer settings");
  const staleTrackPayload = await response.json();
  assert.equal(staleTrackPayload.current.revision, track.revision);
  assert.equal(staleTrackPayload.current.volume, track.volume);
  assertNoStore(response, "stale track PATCH conflict");

  const trackRevisionForConcurrentEdit = track.revision;
  const concurrentTrackPatchResponses = await Promise.all([
    request(`/api/tracks/${track.id}`, {
      method: "PATCH",
      json: { muted: true, expectedRevision: trackRevisionForConcurrentEdit },
    }),
    request(`/api/tracks/${track.id}`, {
      method: "PATCH",
      json: { solo: true, expectedRevision: trackRevisionForConcurrentEdit },
    }),
  ]);
  assert.deepEqual(
    concurrentTrackPatchResponses.map((item) => item.status).sort(),
    [200, 409],
    "only one concurrent track PATCH may commit for a revision",
  );
  const winningTrackPatch = concurrentTrackPatchResponses.find((item) => item.status === 200);
  const staleTrackPatch = concurrentTrackPatchResponses.find((item) => item.status === 409);
  assert.ok(winningTrackPatch && staleTrackPatch);
  track = (await winningTrackPatch.json()).track;
  const concurrentStaleTrackPayload = await staleTrackPatch.json();
  assert.equal(concurrentStaleTrackPayload.current.revision, track.revision);

  response = await request(`/api/tracks/${track.id}`, {
    method: "PATCH",
    json: { muted: true, expectedRevision: track.revision },
  });
  assert.equal(response.status, 200);
  track = (await response.json()).track;
  assert.equal(track.muted, true);
  response = await request(`/api/tracks/${track.id}`, {
    method: "PATCH",
    json: { muted: false, solo: true, expectedRevision: track.revision },
  });
  assert.equal(response.status, 200);
  track = (await response.json()).track;
  assert.equal(track.solo, true);
  response = await request(`/api/tracks/${track.id}`, {
    method: "PATCH",
    json: { muted: "true", expectedRevision: track.revision },
  });
  assert.equal(response.status, 400, "mute and solo must remain strict booleans");

  response = await request(take.audioUrl, {
    headers: { range: "bytes=0-15" },
  });
  assert.equal(response.status, 206);
  assert.equal((await response.arrayBuffer()).byteLength, 16);
  assert.match(response.headers.get("content-range") ?? "", /^bytes 0-15\//);

  response = await request(take.audioUrl, {
    headers: { range: "bytes=999999-1000000" },
  });
  assert.equal(response.status, 416);

  const audioFormatBaselineFiles = (await readdir(isolatedAudioDirectory)).sort();
  assert.equal(audioFormatBaselineFiles.length, 4);
  for (const genericMimeType of ["", "application/octet-stream"]) {
    const genericMp3Form = new FormData();
    genericMp3Form.set(
      "audio",
      new File([wave], "sample.mp3", { type: genericMimeType }),
    );
    genericMp3Form.set("kind", "backing");
    genericMp3Form.set("name", "Generic MIME MP3");
    genericMp3Form.set("requestId", randomUUID());
    response = await request(`/api/riffs/${riff.id}/tracks`, {
      method: "POST",
      body: genericMp3Form,
    });
    assert.equal(
      response.status,
      201,
      `${genericMimeType || "empty"} MIME MP3 must be accepted by filename`,
    );
    const genericMp3Track = (await response.json()).track;
    assert.equal(genericMp3Track.mimeType, "audio/mpeg");
    assert.equal(genericMp3Track.byteSize, wave.length);

    const filesWithGenericMp3 = (await readdir(isolatedAudioDirectory)).sort();
    const genericMp3StoragePaths = filesWithGenericMp3.filter(
      (fileName) => !audioFormatBaselineFiles.includes(fileName),
    );
    assert.equal(genericMp3StoragePaths.length, 1);
    assert.match(
      genericMp3StoragePaths[0],
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.mp3$/,
      "generic MIME MP3 storage path must use a strict UUID and canonical extension",
    );

    response = await request(genericMp3Track.audioUrl, {
      headers: { range: "bytes=0-15" },
    });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-type"), "audio/mpeg");
    assert.equal(response.headers.get("content-range"), `bytes 0-15/${wave.length}`);
    assert.equal((await response.arrayBuffer()).byteLength, 16);

    response = await request(`/api/tracks/${genericMp3Track.id}`, {
      method: "DELETE",
      json: { expectedRevision: genericMp3Track.revision },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).cleanupPending, false);
    assert.deepEqual(
      (await readdir(isolatedAudioDirectory)).sort(),
      audioFormatBaselineFiles,
      "generic MIME MP3 cleanup must restore the isolated audio directory",
    );
  }

  for (const mismatch of [
    { fileName: "sample.mp3", mimeType: "text/html" },
    { fileName: "sample.wav", mimeType: "audio/mpeg" },
  ]) {
    const mismatchedAudioForm = new FormData();
    mismatchedAudioForm.set(
      "audio",
      new File([wave], mismatch.fileName, { type: mismatch.mimeType }),
    );
    mismatchedAudioForm.set("kind", "backing");
    mismatchedAudioForm.set("requestId", randomUUID());
    response = await request(`/api/riffs/${riff.id}/tracks`, {
      method: "POST",
      body: mismatchedAudioForm,
    });
    assert.equal(response.status, 415, "unsafe or mismatched MIME must fail closed");
    assertNoStore(response, "track audio format mismatch");
    assert.match((await response.json()).error, new RegExp(mismatch.fileName));
    assert.deepEqual(
      (await readdir(isolatedAudioDirectory)).sort(),
      audioFormatBaselineFiles,
      "rejected audio metadata must not create a file",
    );
  }

  response = await requestTakeDuplicate(take.id);
  assert.equal(response.status, 201);
  const disposableTake = (await response.json()).take;
  assert.equal((await readdir(isolatedAudioDirectory)).length, 5);
  response = await request(`/api/takes/${disposableTake.id}`, {
    method: "DELETE",
    json: {},
  });
  assert.equal(response.status, 400, "take DELETE must require an expected revision");
  response = await request(`/api/takes/${disposableTake.id}`, {
    method: "PATCH",
    json: { name: "Disposable take updated", expectedRevision: disposableTake.revision },
  });
  assert.equal(response.status, 200);
  const updatedDisposableTake = (await response.json()).take;
  response = await request(`/api/takes/${disposableTake.id}`, {
    method: "DELETE",
    json: { expectedRevision: disposableTake.revision },
  });
  assert.equal(response.status, 409, "stale take DELETE must preserve a newer take");
  assert.equal((await response.json()).current.revision, updatedDisposableTake.revision);
  response = await request(`/api/takes/${disposableTake.id}`, {
    method: "DELETE",
    json: { expectedRevision: updatedDisposableTake.revision },
  });
  assert.equal(response.status, 200);
  assert.equal(
    (await response.json()).cleanupPending,
    false,
    "successful take unlink must acknowledge its durable cleanup queue entry",
  );
  assert.equal((await readdir(isolatedAudioDirectory)).length, 4);

  const disposableTrackForm = new FormData();
  disposableTrackForm.set(
    "audio",
    new File([wave], "disposable.wav", { type: "audio/wav" }),
  );
  disposableTrackForm.set("kind", "guitar");
  disposableTrackForm.set("durationMs", "2000");
  disposableTrackForm.set("requestId", randomUUID());
  response = await request(`/api/riffs/${riff.id}/tracks`, {
    method: "POST",
    body: disposableTrackForm,
  });
  assert.equal(response.status, 201);
  const disposableTrack = (await response.json()).track;
  assert.equal((await readdir(isolatedAudioDirectory)).length, 5);
  response = await request(`/api/tracks/${disposableTrack.id}`, {
    method: "DELETE",
    json: {},
  });
  assert.equal(response.status, 400, "track DELETE must require an expected revision");
  response = await request(`/api/tracks/${disposableTrack.id}`, {
    method: "PATCH",
    json: { name: "Disposable updated", expectedRevision: disposableTrack.revision },
  });
  assert.equal(response.status, 200);
  const updatedDisposableTrack = (await response.json()).track;
  response = await request(`/api/tracks/${disposableTrack.id}`, {
    method: "DELETE",
    json: { expectedRevision: disposableTrack.revision },
  });
  assert.equal(response.status, 409, "stale track DELETE must preserve newer settings");
  assert.equal((await response.json()).current.revision, updatedDisposableTrack.revision);
  response = await request(`/api/tracks/${disposableTrack.id}`, {
    method: "DELETE",
    json: { expectedRevision: updatedDisposableTrack.revision },
  });
  assert.equal(response.status, 200);
  assert.equal(
    (await response.json()).cleanupPending,
    false,
    "successful track unlink must acknowledge its durable cleanup queue entry",
  );
  assert.equal((await readdir(isolatedAudioDirectory)).length, 4);

  const cleanupVerificationDb = new Client({ connectionString: testUrl.toString() });
  const crashQueuedPath = `${randomUUID()}.wav`;
  const alreadyMissingQueuedPath = `${randomUUID()}.wav`;
  await cleanupVerificationDb.connect();
  try {
    await writeFile(path.join(isolatedAudioDirectory, crashQueuedPath), wave, {
      flag: "wx",
      mode: 0o600,
    });
    await cleanupVerificationDb.query(
      `INSERT INTO audio_cleanup_queue (storage_path)
       VALUES ($1), ($2)`,
      [crashQueuedPath, alreadyMissingQueuedPath],
    );
    assert.equal(
      Number(
        (await cleanupVerificationDb.query("SELECT count(*) FROM audio_cleanup_queue"))
          .rows[0].count,
      ),
      2,
      "a crash-equivalent must leave durable cleanup work in PostgreSQL",
    );

    await run(
      process.execPath,
      [path.join(PROJECT_DIRECTORY, "scripts", "audio-cleanup.mjs")],
      {
        env: {
          ...process.env,
          DATABASE_URL: testUrl.toString(),
          AUDIO_STORAGE_NAMESPACE: isolatedAudioNamespace,
          RIFF_E2E_AUDIO_CLEANUP: "1",
        },
      },
    );
    assert.equal(
      Number(
        (await cleanupVerificationDb.query("SELECT count(*) FROM audio_cleanup_queue"))
          .rows[0].count,
      ),
      0,
      "the next startup drain must clear removed and ENOENT queue entries",
    );
    assert.equal(
      (await readdir(isolatedAudioDirectory)).includes(crashQueuedPath),
      false,
      "the next startup drain must remove the crash-left audio file",
    );
    assert.equal((await readdir(isolatedAudioDirectory)).length, 4);
  } finally {
    await cleanupVerificationDb.end();
  }

  const missingRiffForm = new FormData();
  missingRiffForm.set(
    "audio",
    new File([wave], "orphan-check.wav", { type: "audio/wav" }),
  );
  missingRiffForm.set("durationMs", "2000");
  response = await request(
    "/api/riffs/00000000-0000-4000-8000-000000000001/takes",
    { method: "POST", body: missingRiffForm },
  );
  assert.equal(response.status, 404);
  assert.equal(
    (await readdir(isolatedAudioDirectory)).length,
    4,
    "failed database writes must compensate the already-saved audio file",
  );

  response = await request(`/api/riffs/${riff.id}/duplicate`, {
    method: "POST",
    headers: { origin: "http://malicious.invalid" },
  });
  assert.equal(response.status, 403, "riff duplication must reject a foreign Origin");

  response = await request(`/api/riffs/${riff.id}`);
  assert.equal(response.status, 200);
  const sourceRiff = (await response.json()).riff;
  response = await request(`/api/riffs/${riff.id}/duplicate`, {
    method: "POST",
    json: { requestId: "not-a-uuid" },
  });
  assert.equal(response.status, 400, "riff duplicate request IDs must be strict UUIDs");
  assertNoStore(response, "invalid riff duplicate request ID");
  response = await request(`/api/riffs/${riff.id}/duplicate`, {
    method: "POST",
    json: { requestId: randomUUID(), unexpected: true },
  });
  assert.equal(response.status, 400, "riff duplicate bodies must reject unknown fields");
  assertNoStore(response, "invalid riff duplicate body");

  const duplicateRequestId = randomUUID();
  const duplicateResponses = await Promise.all([
    request(`/api/riffs/${riff.id}/duplicate`, {
      method: "POST",
      json: { requestId: duplicateRequestId },
    }),
    request(`/api/riffs/${riff.id}/duplicate`, {
      method: "POST",
      json: { requestId: duplicateRequestId },
    }),
  ]);
  assert.deepEqual(
    duplicateResponses.map((item) => item.status).sort(),
    [200, 201],
    "concurrent riff duplicate retries must create exactly one riff",
  );
  for (const duplicateResponse of duplicateResponses) {
    assertNoStore(duplicateResponse, "concurrent riff duplicate response");
  }
  const duplicatePayloads = await Promise.all(
    duplicateResponses.map((item) => item.json()),
  );
  assert.equal(
    new Set(duplicatePayloads.map((item) => item.riff.id)).size,
    1,
    "concurrent duplicate retries must return the same riff",
  );
  const duplicatedRiff = duplicatePayloads[0].riff;
  response = await request(`/api/riffs/${riff.id}/duplicate`, {
    method: "POST",
    json: { requestId: duplicateRequestId },
  });
  assert.equal(response.status, 200, "sequential duplicate retries must replay safely");
  const sequentialReplay = await response.json();
  assert.equal(sequentialReplay.riff.id, duplicatedRiff.id);
  assert.equal(sequentialReplay.idempotentReplay, true);
  response = await request(`/api/riffs/${setup.seeded.riffId}/duplicate`, {
    method: "POST",
    json: { requestId: duplicateRequestId },
  });
  assert.equal(response.status, 409, "a duplicate request ID cannot be reused for another source");
  assertNoStore(response, "cross-source duplicate request conflict");
  response = await request(`/api/riffs/${setup.seeded.riffId}/duplicate`, {
    method: "POST",
  });
  assert.equal(response.status, 201, "legacy duplicate requests without a body must remain compatible");
  assert.equal(duplicatedRiff.title, `${sourceRiff.title} 복사본`);
  assert.equal(duplicatedRiff.albumId, sourceRiff.albumId);
  assert.equal(duplicatedRiff.isFavorite, false);
  assert.equal(duplicatedRiff.deletedAt, null);
  assert.deepEqual(
    {
      bpm: duplicatedRiff.bpm,
      musicalKey: duplicatedRiff.musicalKey,
      tuning: duplicatedRiff.tuning,
      timeSignature: duplicatedRiff.timeSignature,
      notes: duplicatedRiff.notes,
      tab: duplicatedRiff.tab,
      tags: duplicatedRiff.tags.map((tag) => tag.name),
    },
    {
      bpm: sourceRiff.bpm,
      musicalKey: sourceRiff.musicalKey,
      tuning: sourceRiff.tuning,
      timeSignature: sourceRiff.timeSignature,
      notes: sourceRiff.notes,
      tab: sourceRiff.tab,
      tags: sourceRiff.tags.map((tag) => tag.name),
    },
  );

  response = await request(`/api/riffs/${riff.id}/takes`);
  assert.equal(response.status, 200);
  const sourceTakes = (await response.json()).takes.sort(
    (left, right) => left.takeNo - right.takeNo,
  );
  response = await request(`/api/riffs/${duplicatedRiff.id}/takes`);
  assert.equal(response.status, 200);
  const copiedTakes = (await response.json()).takes.sort(
    (left, right) => left.takeNo - right.takeNo,
  );
  assert.equal(copiedTakes.length, sourceTakes.length);
  const takeShape = (value) => ({
    takeNo: value.takeNo,
    name: value.name,
    durationMs: value.durationMs,
    trimStartMs: value.trimStartMs,
    trimEndMs: value.trimEndMs,
    offsetMs: value.offsetMs,
    mimeType: value.mimeType,
    byteSize: value.byteSize,
    isPrimary: value.isPrimary,
  });
  for (const [index, sourceTake] of sourceTakes.entries()) {
    const copiedTake = copiedTakes[index];
    assert.deepEqual(takeShape(copiedTake), takeShape(sourceTake));
    assert.notEqual(copiedTake.id, sourceTake.id);
    response = await request(sourceTake.audioUrl);
    assert.equal(response.status, 200);
    const sourceAudio = Buffer.from(await response.arrayBuffer());
    response = await request(copiedTake.audioUrl);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), sourceAudio);
  }

  response = await request(`/api/riffs/${riff.id}/tracks`);
  assert.equal(response.status, 200);
  const sourceTracks = (await response.json()).tracks;
  response = await request(`/api/riffs/${duplicatedRiff.id}/tracks`);
  assert.equal(response.status, 200);
  const copiedTracks = (await response.json()).tracks;
  assert.equal(copiedTracks.length, sourceTracks.length);
  const trackShape = (value) => ({
    kind: value.kind,
    name: value.name,
    durationMs: value.durationMs,
    offsetMs: value.offsetMs,
    volume: value.volume,
    pan: value.pan,
    muted: value.muted,
    solo: value.solo,
    fadeInMs: value.fadeInMs,
    fadeOutMs: value.fadeOutMs,
    mimeType: value.mimeType,
    byteSize: value.byteSize,
  });
  for (const [index, sourceTrack] of sourceTracks.entries()) {
    const copiedTrack = copiedTracks[index];
    assert.deepEqual(trackShape(copiedTrack), trackShape(sourceTrack));
    assert.notEqual(copiedTrack.id, sourceTrack.id);
    response = await request(sourceTrack.audioUrl);
    assert.equal(response.status, 200);
    const sourceAudio = Buffer.from(await response.arrayBuffer());
    response = await request(copiedTrack.audioUrl);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), sourceAudio);
  }

  response = await request(`/api/riffs/${riff.id}/comp`);
  assert.equal(response.status, 200);
  const sourceCompPayload = await response.json();
  const sourceComp = sourceCompPayload.segments;
  assert.equal(sourceCompPayload.revision, compRevision);
  response = await request(`/api/riffs/${duplicatedRiff.id}/comp`);
  assert.equal(response.status, 200);
  const copiedCompPayload = await response.json();
  const copiedComp = copiedCompPayload.segments;
  assert.equal(copiedCompPayload.revision, 0);
  const sourceTakeNumbers = new Map(sourceTakes.map((value) => [value.id, value.takeNo]));
  const copiedTakeNumbers = new Map(copiedTakes.map((value) => [value.id, value.takeNo]));
  const compShape = (segments, takeNumbers) =>
    segments.map((segment) => ({
      takeNo: takeNumbers.get(segment.takeId),
      startMs: segment.startMs,
      endMs: segment.endMs,
      sortOrder: segment.sortOrder,
    }));
  assert.deepEqual(
    compShape(copiedComp, copiedTakeNumbers),
    compShape(sourceComp, sourceTakeNumbers),
  );

  response = await request(`/api/riffs/${riff.id}/markers`);
  assert.equal(response.status, 200);
  const sourceMarkers = (await response.json()).markers;
  response = await request(`/api/riffs/${duplicatedRiff.id}/markers`);
  assert.equal(response.status, 200);
  const copiedMarkers = (await response.json()).markers;
  const markerShape = (value) => ({
    positionMs: value.positionMs,
    label: value.label,
    color: value.color,
    sortOrder: value.sortOrder,
  });
  assert.deepEqual(copiedMarkers.map(markerShape), sourceMarkers.map(markerShape));
  assert.deepEqual(copiedMarkers.map((value) => value.revision), [0]);

  response = await request(`/api/riffs/${riff.id}/youtube-backing`);
  assert.equal(response.status, 200);
  const sourceYouTubeBacking = (await response.json()).youtubeBacking;
  response = await request(`/api/riffs/${duplicatedRiff.id}/youtube-backing`);
  assert.equal(response.status, 200);
  const copiedYouTubeBacking = (await response.json()).youtubeBacking;
  assert.ok(sourceYouTubeBacking && copiedYouTubeBacking);
  assert.equal(sourceYouTubeBacking.id, youtubeBackingForDuplicate.id);
  assert.notEqual(copiedYouTubeBacking.id, sourceYouTubeBacking.id);
  assert.equal(copiedYouTubeBacking.riffId, duplicatedRiff.id);
  const youtubeBackingShape = (value) => ({
    videoId: value.videoId,
    url: value.url,
    name: value.name,
    sourceStartMs: value.sourceStartMs,
    volume: value.volume,
    syncEnabled: value.syncEnabled,
  });
  assert.deepEqual(
    youtubeBackingShape(copiedYouTubeBacking),
    youtubeBackingShape(sourceYouTubeBacking),
    "riff duplication must copy the YouTube reference settings",
  );
  assert.equal(copiedYouTubeBacking.revision, 0);

  assert.equal((await readdir(isolatedAudioDirectory)).length, 8);
  const duplicateVerificationDb = new Client({ connectionString: testUrl.toString() });
  await duplicateVerificationDb.connect();
  try {
    const lastSourceTake = await duplicateVerificationDb.query(
      `SELECT id, storage_path
         FROM take_recording
        WHERE riff_id = $1
        ORDER BY take_no DESC
        LIMIT 1`,
      [riff.id],
    );
    const sourceTakeRow = lastSourceTake.rows[0];
    assert.ok(sourceTakeRow);
    const missingStoragePath = "00000000-0000-4000-8000-00000000dead.wav";
    await duplicateVerificationDb.query(
      "UPDATE take_recording SET storage_path = $1 WHERE id = $2",
      [missingStoragePath, sourceTakeRow.id],
    );
    try {
      const filesBeforeFailure = (await readdir(isolatedAudioDirectory)).sort();
      const riffCountBeforeFailure = Number(
        (await duplicateVerificationDb.query("SELECT count(*) FROM riff")).rows[0].count,
      );
      response = await request(`/api/riffs/${riff.id}/duplicate`, { method: "POST" });
      assert.equal(response.status, 500);
      assert.deepEqual(
        (await readdir(isolatedAudioDirectory)).sort(),
        filesBeforeFailure,
        "failed riff duplication must remove every file copied by that request",
      );
      assert.equal(
        Number(
          (await duplicateVerificationDb.query("SELECT count(*) FROM riff")).rows[0]
            .count,
        ),
        riffCountBeforeFailure,
        "failed riff duplication must roll back all database rows",
      );
    } finally {
      await duplicateVerificationDb.query(
        "UPDATE take_recording SET storage_path = $1 WHERE id = $2",
        [sourceTakeRow.storage_path, sourceTakeRow.id],
      );
    }

    await duplicateVerificationDb.query(`
      CREATE FUNCTION e2e_reject_marker_copy() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'intentional duplicate transaction failure';
      END
      $$
    `);
    await duplicateVerificationDb.query(`
      CREATE TRIGGER e2e_reject_marker_copy
      BEFORE INSERT ON riff_marker
      FOR EACH ROW EXECUTE FUNCTION e2e_reject_marker_copy()
    `);
    try {
      const filesBeforeRollback = (await readdir(isolatedAudioDirectory)).sort();
      const riffCountBeforeRollback = Number(
        (await duplicateVerificationDb.query("SELECT count(*) FROM riff")).rows[0].count,
      );
      response = await request(`/api/riffs/${riff.id}/duplicate`, { method: "POST" });
      assert.equal(response.status, 500);
      assert.deepEqual(
        (await readdir(isolatedAudioDirectory)).sort(),
        filesBeforeRollback,
        "database failures must compensate all newly copied riff audio",
      );
      assert.equal(
        Number(
          (await duplicateVerificationDb.query("SELECT count(*) FROM riff")).rows[0]
            .count,
        ),
        riffCountBeforeRollback,
        "database failures must roll back the partially inserted duplicate",
      );
    } finally {
      await duplicateVerificationDb.query(
        "DROP TRIGGER IF EXISTS e2e_reject_marker_copy ON riff_marker",
      );
      await duplicateVerificationDb.query(
        "DROP FUNCTION IF EXISTS e2e_reject_marker_copy()",
      );
    }
  } finally {
    await duplicateVerificationDb.end();
  }

  for (const pathname of [
    "/",
    "/albums",
    `/albums/${album.id}`,
    "/recent",
    "/favorites",
    "/trash",
    `/riffs/${riff.id}`,
    "/?q=Night%20Drive",
    "/?tag=night%20drive&view=list",
  ]) {
    response = await request(pathname, { withOrigin: false });
    assert.equal(response.status, 200, `${pathname} should render`);
  }

  const sourceTrackForTrashRace = sourceTracks[0];
  assert.ok(sourceTrackForTrashRace);
  const [trashResponse, racingTrackResponse] = await Promise.all([
    request(`/api/riffs/${riff.id}`, {
      method: "PATCH",
      json: { trashed: true, expectedRevision: sourceRiff.revision },
    }),
    request(`/api/tracks/${sourceTrackForTrashRace.id}`, {
      method: "PATCH",
      json: {
        expectedRevision: sourceTrackForTrashRace.revision,
        volume: sourceTrackForTrashRace.volume,
      },
    }),
  ]);
  assert.equal(trashResponse.status, 200);
  assert.ok(
    racingTrackResponse.status === 200 || racingTrackResponse.status === 404,
    "trash and child mutation must serialize without a deadlock",
  );
  const trashedRiff = (await trashResponse.json()).riff;

  response = await request(`/api/riffs/${riff.id}`, {
    method: "PATCH",
    json: {
      notes: "stale editor must not write",
      expectedRevision: trashedRiff.revision,
    },
  });
  assert.equal(response.status, 409, "trashed riff metadata must be restored before editing");

  const sourceTakeForTrashChecks = sourceTakes.find((item) => item.id === take.id);
  const sourceMarkerForTrashChecks = sourceMarkers[0];
  assert.ok(sourceTakeForTrashChecks && sourceMarkerForTrashChecks);
  const filesBeforeTrashedMutations = (await readdir(isolatedAudioDirectory)).sort();

  const trashedTakeForm = new FormData();
  trashedTakeForm.set(
    "audio",
    new File([wave], "trashed-take.wav", { type: "audio/wav" }),
  );
  trashedTakeForm.set("durationMs", "2000");
  response = await request(`/api/riffs/${riff.id}/takes`, {
    method: "POST",
    body: trashedTakeForm,
  });
  assert.equal(response.status, 404, "a stale recorder must not upload into trash");
  assert.deepEqual(
    (await readdir(isolatedAudioDirectory)).sort(),
    filesBeforeTrashedMutations,
    "a rejected trashed-riff upload must compensate its audio file",
  );

  response = await request(`/api/takes/${sourceTakeForTrashChecks.id}`, {
    method: "PATCH",
    json: {
      expectedRevision: sourceTakeForTrashChecks.revision,
      name: "stale take edit",
    },
  });
  assert.equal(response.status, 404, "take PATCH must reject a trashed parent");
  response = await request(`/api/takes/${sourceTakeForTrashChecks.id}/split`, {
    method: "POST",
    json: {
      splitMs: 500,
      expectedRevision: sourceTakeForTrashChecks.revision,
    },
  });
  assert.equal(response.status, 404, "take split must reject a trashed parent");
  response = await requestTakeDuplicate(sourceTakeForTrashChecks.id);
  assert.equal(response.status, 404, "take duplicate must reject a trashed parent");
  response = await request(`/api/takes/${sourceTakeForTrashChecks.id}`, {
    method: "DELETE",
    json: { expectedRevision: sourceTakeForTrashChecks.revision },
  });
  assert.equal(response.status, 404, "take DELETE must reject a trashed parent");

  const trashedTrackForm = new FormData();
  trashedTrackForm.set(
    "audio",
    new File([wave], "trashed-track.wav", { type: "audio/wav" }),
  );
  trashedTrackForm.set("kind", "backing");
  trashedTrackForm.set("requestId", randomUUID());
  response = await request(`/api/riffs/${riff.id}/tracks`, {
    method: "POST",
    body: trashedTrackForm,
  });
  assert.equal(response.status, 404, "track upload must reject a trashed parent");
  response = await request(`/api/tracks/${sourceTrackForTrashRace.id}`, {
    method: "PATCH",
    json: {
      expectedRevision: sourceTrackForTrashRace.revision,
      pan: sourceTrackForTrashRace.pan,
    },
  });
  assert.equal(response.status, 404, "track PATCH must reject a trashed parent");
  response = await request(`/api/tracks/${sourceTrackForTrashRace.id}`, {
    method: "DELETE",
    json: { expectedRevision: sourceTrackForTrashRace.revision },
  });
  assert.equal(response.status, 404, "track DELETE must reject a trashed parent");

  response = await request(`/api/riffs/${riff.id}/comp`, {
    method: "PUT",
    json: { expectedRevision: compRevision, segments: sourceComp },
  });
  assert.equal(response.status, 404, "Comp replacement must reject a trashed riff");
  response = await request(`/api/markers/${sourceMarkerForTrashChecks.id}`, {
    method: "PATCH",
    json: {
      revision: sourceMarkerForTrashChecks.revision,
      label: "stale marker edit",
    },
  });
  assert.equal(response.status, 404, "marker PATCH must reject a trashed parent");
  response = await request(`/api/markers/${sourceMarkerForTrashChecks.id}`, {
    method: "DELETE",
    json: { revision: sourceMarkerForTrashChecks.revision },
  });
  assert.equal(response.status, 404, "marker DELETE must reject a trashed parent");
  response = await request(`/api/riffs/${riff.id}/markers`, {
    method: "POST",
    json: {
      requestId: randomUUID(),
      positionMs: 10,
      label: "stale marker",
      color: "rose",
    },
  });
  assert.equal(response.status, 404, "marker creation must reject a trashed riff");
  response = await request(`/api/riffs/${riff.id}/tags`, {
    method: "POST",
    json: { name: "stale tag" },
  });
  assert.equal(response.status, 404, "tag creation must reject a trashed riff");

  response = await request(`/api/riffs/${riff.id}/duplicate`, { method: "POST" });
  assert.equal(response.status, 404, "trashed riffs must not be duplicated");
  response = await request(`/api/riffs/${riff.id}`);
  assert.equal(response.status, 404, "trashed riffs must leave the active editor API");
  response = await request(`/api/riffs/${riff.id}/markers`);
  assert.equal(response.status, 404, "trashed riffs must hide their marker editor API");
  response = await request(`/api/riffs/${riff.id}`, {
    method: "PATCH",
    json: { trashed: false, expectedRevision: trashedRiff.revision },
  });
  assert.equal(response.status, 200, "trashed riffs must be restorable");

  response = await request("/api/auth/logout", { method: "POST" });
  assert.equal(response.status, 200);
  assertNoStore(response, "logout success");
  cookie =
    assertSessionCookiePolicy(response, cookieName, { cleared: true }) ?? "";
  response = await request("/api/albums");
  assert.equal(response.status, 401, "logout must revoke the server-side session");

  response = await request("/api/auth/login", {
    json: { password: "incorrect-password", remember: false },
  });
  assert.equal(response.status, 401);
  assertNoStore(response, "login password error");
  response = await request("/api/auth/login", {
    json: { password: "e2e-password", remember: false },
  });
  assert.equal(response.status, 200);
  assertNoStore(response, "login success");
  cookie = assertSessionCookiePolicy(response, cookieName) ?? "";
  assert.ok(cookie, "login must issue a fresh session cookie");
  assert.notEqual(cookie, setupCookie, "login must not reuse the setup session token");

  response = await request("/api/account/profile", {
    method: "PATCH",
    json: { username: "midnight.e2e", displayName: "새벽 격리 테스트" },
  });
  assert.equal(response.status, 200);
  assertNoStore(response, "profile update success");
  assert.equal((await response.json()).user.username, "midnight.e2e");
  response = await request("/settings", { withOrigin: false });
  assert.equal(response.status, 200, "settings should render for the signed-in user");

  const primaryCookie = cookie;
  response = await request("/api/auth/login", {
    json: { password: "e2e-password", remember: false },
  });
  assert.equal(response.status, 200);
  const secondaryCookie = assertSessionCookiePolicy(response, cookieName) ?? "";
  assert.ok(secondaryCookie, "a second login should create a separate session");
  assert.notEqual(secondaryCookie, primaryCookie);

  cookie = primaryCookie;
  const passwordChangeRequestId = randomUUID();
  const passwordChangeInput = {
    requestId: passwordChangeRequestId,
    currentPassword: "e2e-password",
    newPassword: "new-e2e-password-2",
    confirmPassword: "new-e2e-password-2",
  };
  response = await request("/api/account/password", {
    method: "POST",
    json: {
      requestId: passwordChangeRequestId,
      currentPassword: "incorrect-password",
      newPassword: "new-e2e-password-2",
      confirmPassword: "new-e2e-password-2",
    },
  });
  assert.equal(response.status, 401, "password changes must verify the current password");
  assertNoStore(response, "password verification error");
  response = await request("/api/account/password", {
    method: "POST",
    json: passwordChangeInput,
  });
  assert.equal(response.status, 200);
  assertNoStore(response, "password change success");
  assert.equal((await response.json()).idempotentReplay, false);
  const responseLossReplacementCookie =
    assertSessionCookiePolicy(response, cookieName) ?? "";
  assert.ok(
    responseLossReplacementCookie,
    "password change must rotate the current session",
  );
  assert.notEqual(responseLossReplacementCookie, primaryCookie);
  assert.notEqual(responseLossReplacementCookie, secondaryCookie);

  // Deliberately retain the now-revoked primary cookie to simulate a commit whose
  // HTTP response never reached the settings form. Exact concurrent retries must
  // recover the one already-created replacement session instead of issuing more.
  const concurrentPasswordReplayResponses = await Promise.all([
    request("/api/account/password", {
      method: "POST",
      json: passwordChangeInput,
    }),
    request("/api/account/password", {
      method: "POST",
      json: passwordChangeInput,
    }),
  ]);
  assert.deepEqual(
    concurrentPasswordReplayResponses.map((item) => item.status),
    [200, 200],
    "concurrent old-cookie retries must recover a committed password change",
  );
  const concurrentPasswordReplayPayloads = await Promise.all(
    concurrentPasswordReplayResponses.map((item) => item.json()),
  );
  assert.deepEqual(
    concurrentPasswordReplayPayloads.map((item) => item.idempotentReplay),
    [true, true],
  );
  const recoveredPasswordCookies = concurrentPasswordReplayResponses.map(
    (item) => assertSessionCookiePolicy(item, cookieName) ?? "",
  );
  assert.deepEqual(
    recoveredPasswordCookies,
    [responseLossReplacementCookie, responseLossReplacementCookie],
    "every response-loss replay must return the original replacement token",
  );

  response = await request("/api/account/password", {
    method: "POST",
    json: {
      ...passwordChangeInput,
      newPassword: "different-e2e-password-3",
      confirmPassword: "different-e2e-password-3",
    },
  });
  assert.equal(response.status, 409, "a password request ID must bind to one change");
  assertNoStore(response, "password change request conflict");

  const passwordReplayDb = new Client({ connectionString: testUrl.toString() });
  await passwordReplayDb.connect();
  try {
    const replayRows = await passwordReplayDb.query(`
      SELECT
        (SELECT count(*)::integer FROM app_session) AS sessions,
        (SELECT count(*)::integer FROM password_change_request
          WHERE request_id = $1) AS requests
    `, [passwordChangeRequestId]);
    assert.deepEqual(replayRows.rows[0], { sessions: 1, requests: 1 });
  } finally {
    await passwordReplayDb.end();
  }

  cookie = responseLossReplacementCookie;
  response = await request("/api/account/password", {
    method: "POST",
    json: passwordChangeInput,
  });
  assert.equal(response.status, 200, "a current-session retry must replay safely");
  assertNoStore(response, "password change sequential replay");
  assert.equal((await response.json()).idempotentReplay, true);
  assert.equal(
    sessionCookie(response, cookieName),
    null,
    "a current replacement session must not be rotated again",
  );
  const rotatedCookie = cookie;
  assert.notEqual(rotatedCookie, primaryCookie);
  assert.notEqual(rotatedCookie, secondaryCookie);

  cookie = primaryCookie;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    response = await request("/api/account/password", {
      method: "POST",
      json: {
        ...passwordChangeInput,
        newPassword: `replay-oracle-guess-${attempt}`,
        confirmPassword: `replay-oracle-guess-${attempt}`,
      },
    });
    assert.equal(
      response.status,
      409,
      `password replay mismatch ${attempt} must remain payload-confidential`,
    );
    assertNoStore(response, `password replay mismatch ${attempt}`);
  }
  response = await request("/api/account/password", {
    method: "POST",
    json: {
      ...passwordChangeInput,
      newPassword: "replay-oracle-blocked-6",
      confirmPassword: "replay-oracle-blocked-6",
    },
  });
  assert.equal(response.status, 429, "the sixth replay guess must be rate-limited");
  assertNoStore(response, "password replay rate-limit error");
  assert.ok(
    Number(response.headers.get("retry-after")) > 0,
    "password replay rate limits must include Retry-After",
  );

  cookie = secondaryCookie;
  response = await request("/api/albums");
  assert.equal(response.status, 401, "password change must revoke other sessions");

  cookie = rotatedCookie;
  response = await request("/api/auth/login", {
    json: { password: "e2e-password", remember: false },
  });
  assert.equal(response.status, 401, "the previous password must stop working");
  response = await request("/api/auth/login", {
    json: { password: "new-e2e-password-2", remember: false },
  });
  assert.equal(response.status, 200, "the new password must work immediately");
  cookie = assertSessionCookiePolicy(response, cookieName) ?? "";
  assert.ok(cookie, "the new password login must issue a session cookie");
  assert.notEqual(cookie, rotatedCookie);

  const sessionExclusionDump = path.join(
    temporaryDirectory,
    "session-exclusion.dump",
  );
  await run(
    postgresBinary("pg_dump"),
    [
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      ...SESSION_BEARING_BACKUP_EXCLUSIONS,
      `--file=${sessionExclusionDump}`,
    ],
    { env: databaseEnvironment(testUrl) },
  );
  await admin.query(
    `CREATE DATABASE ${quotedRestoreTestDatabaseName} OWNER ${APP_ROLE} ENCODING 'UTF8' TEMPLATE template0`,
  );
  restoreDatabaseCreated = true;
  await admin.query(
    `REVOKE ALL ON DATABASE ${quotedRestoreTestDatabaseName} FROM PUBLIC`,
  );
  await admin.query(
    `GRANT CONNECT, TEMPORARY ON DATABASE ${quotedRestoreTestDatabaseName} TO ${APP_ROLE}`,
  );
  await run(
    postgresBinary("pg_restore"),
    [
      "--exit-on-error",
      "--no-owner",
      "--no-privileges",
      `--dbname=${restoreTestDatabaseName}`,
      sessionExclusionDump,
    ],
    { env: databaseEnvironment(restoreTestUrl) },
  );
  const restoredSessionDb = new Client({
    connectionString: restoreTestUrl.toString(),
  });
  await restoredSessionDb.connect();
  try {
    const restoredSessionRows = await restoredSessionDb.query(`
      SELECT
        (SELECT count(*)::integer FROM app_user) AS users,
        (SELECT count(*)::integer FROM app_session) AS sessions,
        (SELECT count(*)::integer FROM password_change_request) AS password_requests
    `);
    assert.deepEqual(restoredSessionRows.rows[0], {
      users: 1,
      sessions: 0,
      password_requests: 0,
    });
  } finally {
    await restoredSessionDb.end();
  }
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [restoreTestDatabaseName],
  );
  await admin.query(`DROP DATABASE ${quotedRestoreTestDatabaseName}`);
  restoreDatabaseCreated = false;

  const isolatedDb = new Client({ connectionString: testUrl.toString() });
  await isolatedDb.connect();
  let counts;
  try {
    counts = await isolatedDb.query(`
      SELECT
        (SELECT count(*)::integer FROM app_user) AS users,
        (SELECT count(*)::integer FROM album) AS albums,
        (SELECT count(*)::integer FROM riff) AS riffs,
        (SELECT count(*)::integer FROM take_recording) AS takes,
        (SELECT count(*)::integer FROM riff_track) AS tracks,
        (SELECT count(*)::integer FROM riff_youtube_backing) AS youtube_backings,
        (SELECT count(*)::integer FROM comp_segment) AS comp_segments,
        (SELECT count(*)::integer FROM riff_marker) AS markers,
        (SELECT count(*)::integer FROM tag) AS tags,
        (SELECT count(*)::integer FROM riff_tag) AS riff_tags,
        (SELECT count(*)::integer FROM take_recording
          WHERE client_recording_id IS NOT NULL) AS client_recording_ids,
        (SELECT count(*)::integer FROM take_recording
          WHERE duplicate_request_id IS NOT NULL) AS take_duplicate_ids,
        (SELECT count(*)::integer FROM library_create_request) AS library_create_requests,
        (SELECT count(*)::integer FROM password_change_request) AS password_change_requests,
        (SELECT count(*)::integer FROM audio_cleanup_queue) AS pending_audio_cleanup
    `);
  } finally {
    await isolatedDb.end();
  }
  assert.deepEqual(counts.rows[0], {
    users: 1,
    albums: 2,
    riffs: 4,
    takes: 6,
    tracks: 2,
    youtube_backings: 2,
    comp_segments: 4,
    markers: 2,
    tags: 2,
    riff_tags: 6,
    client_recording_ids: 1,
    take_duplicate_ids: 1,
    library_create_requests: 2,
    password_change_requests: 1,
    pending_audio_cleanup: 0,
  });

  const largeLibraryAlbumId = randomUUID();
  const largeLibraryTagId = randomUUID();
  const largeLibraryRiffIds = Array.from({ length: 201 }, () => randomUUID());
  const largeLibraryDb = new Client({ connectionString: testUrl.toString() });
  await largeLibraryDb.connect();
  try {
    await largeLibraryDb.query("BEGIN");
    await largeLibraryDb.query(
      `INSERT INTO album (id, name, description, color, sort_order)
       VALUES ($1, '대형 라이브러리 E2E', '200개 목록 제한 검증', '#D9D2C3', 999)`,
      [largeLibraryAlbumId],
    );
    await largeLibraryDb.query(
      `INSERT INTO tag (id, name, normalized_name)
       VALUES ($1, 'Large Library QA', 'large library qa')`,
      [largeLibraryTagId],
    );
    await largeLibraryDb.query(
      `INSERT INTO riff (id, album_id, title, is_favorite, updated_at)
       SELECT source.id,
              $2,
              format('대형 리프 %s', lpad(source.ordinality::text, 3, '0')),
              true,
              now() - ((source.ordinality - 1) * interval '1 millisecond')
         FROM unnest($1::uuid[]) WITH ORDINALITY AS source(id, ordinality)`,
      [largeLibraryRiffIds, largeLibraryAlbumId],
    );
    await largeLibraryDb.query(
      `INSERT INTO riff_tag (riff_id, tag_id)
       SELECT source.id, $2
         FROM unnest($1::uuid[]) AS source(id)`,
      [largeLibraryRiffIds, largeLibraryTagId],
    );
    await largeLibraryDb.query("COMMIT");
  } catch (error) {
    await largeLibraryDb.query("ROLLBACK");
    throw error;
  } finally {
    await largeLibraryDb.end();
  }

  response = await request(`/albums/${largeLibraryAlbumId}`, {
    withOrigin: false,
  });
  assert.equal(response.status, 200, "large album page must render");
  const largeLibraryHtml = await response.text();
  assert.match(
    largeLibraryHtml,
    /전체 201개 · 최근 200개 표시/,
    "large album page must distinguish the exact total from its 200-item window",
  );
  const renderedLargeLibraryRiffIds = largeLibraryRiffIds.filter((id) =>
    largeLibraryHtml.includes(id),
  );
  assert.equal(
    renderedLargeLibraryRiffIds.length,
    200,
    "large album page must cap the rendered riff window at 200",
  );
  assert.ok(
    renderedLargeLibraryRiffIds.includes(largeLibraryRiffIds[0]),
    "large album page must include the newest riff",
  );
  assert.ok(
    !renderedLargeLibraryRiffIds.includes(largeLibraryRiffIds[200]),
    "large album page must omit the 201st riff from the recent window",
  );

  for (let attempt = 1; attempt <= 8; attempt += 1) {
    response = await request("/api/auth/login", {
      json: { password: `rate-limit-wrong-${attempt}`, remember: false },
    });
    assert.equal(response.status, 401, `login failure ${attempt} must remain allowed`);
    assertNoStore(response, `login failure ${attempt}`);
    await response.json();
  }
  response = await request("/api/auth/login", {
    json: { password: "rate-limit-blocked-attempt", remember: false },
  });
  assert.equal(response.status, 429, "the ninth consecutive login attempt must be throttled");
  assertNoStore(response, "login rate-limit error");
  const retryAfter = Number(response.headers.get("retry-after"));
  assert.ok(
    Number.isFinite(retryAfter) && retryAfter > 0,
    "rate-limit responses must include a positive Retry-After value",
  );

  console.log(
    "격리 E2E 통과: 인증·세션회전, 설정, 앨범, 리프·전체복제·태그·마커·YouTube 백킹, 대형 목록 집계·200개 제한, 테이크, 분할, Comp, 트랙 M/S, Range, 휴지통",
  );
} catch (error) {
  testFailure = error;
  throw error;
} finally {
  const cleanupErrors = [];
  const clean = async (operation) => {
    try {
      await operation();
    } catch (error) {
      cleanupErrors.push(error);
    }
  };

  let serverStopped = true;
  if (server) {
    try {
      await stopChild(server);
    } catch (error) {
      cleanupErrors.push(error);
      serverStopped =
        server.exitCode !== null || server.signalCode !== null;
    }
  }
  if (adminConnected) {
    if (restoreDatabaseCreated) {
      await clean(() =>
        admin.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [restoreTestDatabaseName],
        ),
      );
      await clean(() =>
        admin.query(`DROP DATABASE IF EXISTS ${quotedRestoreTestDatabaseName}`),
      );
    }
    if (databaseCreated && serverStopped) {
      await clean(() =>
        admin.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [testDatabaseName],
        ),
      );
      await clean(() =>
        admin.query(`DROP DATABASE IF EXISTS ${quotedTestDatabaseName}`),
      );
    }
    await clean(() => admin.end());
  }
  if (audioDirectoryCreated && serverStopped) {
    await clean(() =>
      rm(isolatedAudioDirectory, { recursive: true, force: true }),
    );
  }
  if (serverStopped) {
    try {
      await rmdir(isolatedAudioRoot);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY"].includes(error?.code)) {
        cleanupErrors.push(error);
      }
    }
  }
  await clean(() => rm(temporaryDirectory, { recursive: true, force: true }));
  process.removeListener("SIGINT", handleShutdownSignal);
  process.removeListener("SIGTERM", handleShutdownSignal);

  if (cleanupErrors.length > 0) {
    const cleanupError = new AggregateError(
      cleanupErrors,
      "The isolated E2E resources were not fully cleaned up.",
    );
    if (testFailure) console.error(cleanupError);
    else throw cleanupError;
  }
}
