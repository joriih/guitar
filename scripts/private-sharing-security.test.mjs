import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_APP_ORIGIN,
  isLoopbackAppOrigin,
} from "../lib/app-origin.mjs";
import { assertLoopbackDatabaseUrl } from "./local-database-url.mjs";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const REMOTE_ORIGIN = "https://quiet-riff-bridge.trycloudflare.com";

async function source(relativePath) {
  return readFile(path.join(PROJECT_ROOT, relativePath), "utf8");
}

async function routeFiles(directory = path.join(PROJECT_ROOT, "app", "api")) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await routeFiles(entryPath)));
    if (entry.isFile() && entry.name === "route.ts") files.push(entryPath);
  }
  return files.sort();
}

test("the Next.js listener remains loopback-only in local and sharing modes", async () => {
  const packageJson = JSON.parse(await source("package.json"));
  assert.match(packageJson.scripts.dev, /--hostname\s+127\.0\.0\.1(?:\s|$)/);

  const startApp = await source("scripts/start-app.mjs");
  assert.match(
    startApp,
    /\[nextBinary,\s*"start",\s*"--hostname",\s*"127\.0\.0\.1"/,
  );
  assert.doesNotMatch(startApp, /--hostname["',\s]+(?:0\.0\.0\.0|::)(?:["',\s]|$)/);
  assert.equal(DEFAULT_APP_ORIGIN, "http://127.0.0.1:3000");
});

test("every API mutation invokes the same-origin guard", async () => {
  const unguarded = [];
  for (const filePath of await routeFiles()) {
    const contents = await readFile(filePath, "utf8");
    const mutations = [
      ...contents.matchAll(
        /export async function (POST|PUT|PATCH|DELETE)\s*\(([^)]*)\)/g,
      ),
    ];
    for (let index = 0; index < mutations.length; index += 1) {
      const mutation = mutations[index];
      const nextExport = contents.indexOf(
        "export async function ",
        mutation.index + mutation[0].length,
      );
      const handler = contents.slice(
        mutation.index,
        nextExport === -1 ? undefined : nextExport,
      );
      if (
        !/\brequest\s*:\s*Request\b/.test(mutation[2]) ||
        !/assertSameOrigin\(request\)/.test(handler)
      ) {
        unguarded.push(
          `${path.relative(PROJECT_ROOT, filePath)}#${mutation[1]}`,
        );
      }
    }
  }
  assert.deepEqual(unguarded, []);

  const http = await source("lib/http.ts");
  assert.match(http, /isAllowedAppOrigin\(origin\)/);
  assert.doesNotMatch(
    http,
    /if\s*\(\s*!origin\s*\)\s*(?:\{\s*)?return\b/,
    "a missing Origin must fail closed, especially while remote access is enabled",
  );
});

test("first setup is restricted to a loopback browser origin before any DB work", async () => {
  assert.equal(isLoopbackAppOrigin(DEFAULT_APP_ORIGIN), true);
  assert.equal(isLoopbackAppOrigin(REMOTE_ORIGIN), false);

  const setup = await source("app/api/auth/setup/route.ts");
  const localOnlyGuard = setup.indexOf(
    'isLoopbackAppOrigin(request.headers.get("origin"))',
  );
  const firstDatabaseUse = setup.indexOf("await db.query");
  assert.notEqual(localOnlyGuard, -1);
  assert.notEqual(firstDatabaseUse, -1);
  assert.ok(
    localOnlyGuard < firstDatabaseUse,
    "remote setup must be rejected before a database read or write",
  );
});

test("authentication JSON is content-typed and bounded before database or password work", async () => {
  for (const [route, firstSensitiveOperation] of [
    ["app/api/auth/login/route.ts", "await withTransaction"],
    ["app/api/auth/setup/route.ts", "await db.query"],
    ["app/api/account/password/route.ts", "await getSessionToken"],
  ]) {
    const contents = await source(route);
    const boundedRead = contents.indexOf("await readJsonWithLimit(request)");
    const sensitiveOperation = contents.indexOf(firstSensitiveOperation);
    assert.ok(boundedRead > 0, route);
    assert.ok(sensitiveOperation > boundedRead, route);
    assert.doesNotMatch(contents, /request\.json\(\)/, route);
  }

  const requestJson = await source("lib/request-json.ts");
  assert.match(requestJson, /AUTH_JSON_BODY_LIMIT_BYTES = 4 \* 1024/);
  assert.match(requestJson, /mediaType !== "application\/json"/);
  assert.match(requestJson, /request\.body\.getReader\(\)/);
  assert.match(requestJson, /totalBytes > maximumBytes/);
  assert.match(requestJson, /await reader\.cancel\(\)/);
});

test("session cookies derive Secure from the validated request origin", async () => {
  const session = await source("lib/session.ts");
  assert.match(session, /secure:\s*isSecureAppRequest\(request\)/);
  assert.match(
    session,
    /export async function clearSessionCookie\(request:\s*Request\)/,
  );

  for (const route of [
    "app/api/auth/setup/route.ts",
    "app/api/auth/login/route.ts",
    "app/api/account/password/route.ts",
  ]) {
    const contents = await source(route);
    assert.match(contents, /setSessionCookie\(\s*request,/s, route);
  }
  assert.match(
    await source("app/api/auth/logout/route.ts"),
    /destroyCurrentSession\(request\)/,
  );
});

test("remote sharing never relaxes the database loopback boundary", async () => {
  for (const databaseUrl of [
    "postgresql://riff_sketchbook_app@quiet-riff-bridge.trycloudflare.com/riff_sketchbook",
    "postgresql://riff_sketchbook_app@192.168.1.40/riff_sketchbook",
    "postgresql://riff_sketchbook_app@0.0.0.0/riff_sketchbook",
  ]) {
    assert.throws(() => assertLoopbackDatabaseUrl(databaseUrl), databaseUrl);
  }
  assert.doesNotThrow(() =>
    assertLoopbackDatabaseUrl(
      "postgresql://riff_sketchbook_app@127.0.0.1:5432/riff_sketchbook",
    ),
  );
  assert.match(await source("lib/db.ts"), /assertLoopbackDatabaseUrl\(/);
});

test("audio routes authenticate before lookup and every stream result is no-store", async () => {
  for (const route of [
    "app/api/takes/[takeId]/audio/route.ts",
    "app/api/tracks/[trackId]/audio/route.ts",
  ]) {
    const contents = await source(route);
    const authentication = contents.indexOf("await requireUser()");
    const databaseLookup = contents.indexOf("await db.query");
    assert.notEqual(authentication, -1, route);
    assert.notEqual(databaseLookup, -1, route);
    assert.ok(authentication < databaseLookup, `${route} must authenticate first`);
  }

  const storage = await source("lib/audio-storage.ts");
  assert.match(storage, /"Cache-Control":\s*"private, no-store"/);
  assert.doesNotMatch(
    storage,
    /status:\s*416,\s*headers:\s*\{[^}]*"Content-Range"/s,
    "invalid and unsatisfiable Range responses must retain no-store headers",
  );

  const http = await source("lib/http.ts");
  assert.match(
    http,
    /error instanceof AuthenticationError[\s\S]*?status:\s*401[\s\S]*?"Cache-Control":\s*"no-store"/,
  );
});

test("shared HTTPS responses receive short HSTS without restricting Next or YouTube scripts", async () => {
  const nextConfig = await source("next.config.ts");
  assert.match(nextConfig, /key:\s*"Strict-Transport-Security"/);
  assert.match(nextConfig, /value:\s*"max-age=86400"/);
  assert.doesNotMatch(nextConfig, /(?:default-src|script-src|style-src)/);
});
