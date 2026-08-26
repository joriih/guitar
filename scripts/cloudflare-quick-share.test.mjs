import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  assertBundledCloudflared,
  CLOUDFLARED_RELATIVE_PATH,
  cloudflaredArguments,
  cloudflaredEnvironment,
  createClosedProxyGate,
  normalizeQuickTunnelOrigin,
  QuickTunnelOriginExtractor,
  remoteAppEnvironment,
  startQuickTunnel,
  terminateManaged,
  throwIfAborted,
  waitForAbort,
  waitForAuthStatus,
} from "./cloudflare-quick-share-core.mjs";

const roots = new Set();

async function tempRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "riff-cloudflare-share-"));
  roots.add(root);
  return root;
}

function fakeManagedProcess() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter();
  child.stdout = stdout;
  child.stderr = stderr;
  let running = true;
  let finish;
  const completion = new Promise((resolve) => {
    finish = resolve;
  });
  child.kill = (signal) => {
    if (!running) return false;
    running = false;
    finish({ code: null, signal, error: null });
    return true;
  };
  return {
    child,
    completion,
    get running() {
      return running;
    },
    exit(code = 0) {
      if (!running) return;
      running = false;
      finish({ code, signal: null, error: null });
    },
  };
}

test.after(async () => {
  await Promise.all(
    [...roots].map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("only an exact canonical single-label trycloudflare HTTPS origin is accepted", () => {
  const origin = "https://quiet-guitar-demo.trycloudflare.com";
  assert.equal(normalizeQuickTunnelOrigin(origin), origin);

  for (const value of [
    "http://quiet-guitar-demo.trycloudflare.com",
    "https://quiet-guitar-demo.trycloudflare.com/",
    "https://quiet-guitar-demo.trycloudflare.com/login",
    "https://quiet-guitar-demo.trycloudflare.com?friend=1",
    "https://quiet-guitar-demo.trycloudflare.com#share",
    "https://quiet-guitar-demo.trycloudflare.com:443",
    "https://user@quiet-guitar-demo.trycloudflare.com",
    "https://trycloudflare.com",
    "https://nested.quiet-guitar-demo.trycloudflare.com",
    "https://quiet-guitar-demo.trycloudflare.com.evil.example",
    "https://quiet-guitar-demo.trycloudflare.com\\@evil.example",
    "https://QUIET-GUITAR-DEMO.trycloudflare.com",
    " https://quiet-guitar-demo.trycloudflare.com",
    "https://-quiet.trycloudflare.com",
    "https://quiet-.trycloudflare.com",
  ]) {
    assert.throws(() => normalizeQuickTunnelOrigin(value), value);
  }
});

test("the log extractor handles split output and ignores lookalike URLs", () => {
  const extractor = new QuickTunnelOriginExtractor();
  assert.equal(
    extractor.push("INF docs=https://fake.trycloudflare.com.evil.example\n"),
    null,
  );
  assert.equal(
    extractor.push("\u001b[32mINF\u001b[0m | https://split-guitar"),
    null,
  );
  assert.equal(
    extractor.push("-demo.trycloudflare.com"),
    null,
    "an incomplete line must never be trusted at a chunk boundary",
  );
  assert.equal(
    extractor.push(".evil.example\n│ https://actual-guitar-demo.trycloudflare.com │\n"),
    "https://actual-guitar-demo.trycloudflare.com",
  );

  const finalLine = new QuickTunnelOriginExtractor();
  finalLine.push("https://last-line-demo.trycloudflare.com");
  assert.equal(
    finalLine.finish(),
    "https://last-line-demo.trycloudflare.com",
  );
});

test("cloudflared receives only a fixed local gate and a credential-free environment", () => {
  const root = path.join(path.sep, "private", "riff sketchbook");
  assert.deepEqual(cloudflaredArguments("http://127.0.0.1:43127"), [
    "tunnel",
    "--config",
    "/dev/null",
    "--no-autoupdate",
    "--loglevel",
    "info",
    "--protocol",
    "http2",
    "--url",
    "http://127.0.0.1:43127",
  ]);
  for (const origin of [
    "http://localhost:43127",
    "http://0.0.0.0:43127",
    "http://127.0.0.1:3000/path",
    "https://127.0.0.1:43127",
    "http://127.0.0.1",
  ]) {
    assert.throws(() => cloudflaredArguments(origin), origin);
  }

  const environment = cloudflaredEnvironment(root);
  assert.deepEqual(Object.keys(environment).sort(), [
    "HOME",
    "NO_AUTOUPDATE",
    "PATH",
  ]);
  assert.equal(environment.HOME, path.join(root, ".local-tools"));
  for (const secretName of [
    "DATABASE_URL",
    "PG_ADMIN_PASSWORD",
    "SESSION_SECRET",
    "TUNNEL_TOKEN",
    "CF_API_TOKEN",
  ]) {
    assert.equal(secretName in environment, false);
  }
});

test("the app child gets the exact public origin and nested runtime token", () => {
  const parent = {
    DATABASE_URL: "postgresql://local-only",
    APP_ORIGIN: "https://stale.example",
    RIFF_REMOTE_ACCESS: "0",
    RIFF_OPEN_BROWSER: "1",
  };
  const origin = "https://exact-share-origin.trycloudflare.com";
  const token = randomUUID();
  const environment = remoteAppEnvironment(parent, origin, token);
  assert.equal(environment.DATABASE_URL, parent.DATABASE_URL);
  assert.equal(environment.APP_ORIGIN, origin);
  assert.equal(environment.RIFF_REMOTE_ACCESS, "1");
  assert.equal(environment.RIFF_RUNTIME_PARENT_TOKEN, token);
  assert.equal(environment.RIFF_OPEN_BROWSER, "0");
  assert.throws(
    () => remoteAppEnvironment(parent, `${origin}/`, token),
    /trycloudflare/,
  );
  assert.throws(
    () => remoteAppEnvironment(parent, origin, "not-a-token"),
    /토큰/,
  );
});

test("the bundled binary must be executable, non-symlinked, and digest-matched", async () => {
  const root = await tempRoot();
  const binaryPath = path.join(root, CLOUDFLARED_RELATIVE_PATH);
  await mkdir(path.dirname(binaryPath), { recursive: true, mode: 0o700 });
  const contents = Buffer.from("verified fake cloudflared for an isolated unit test\n");
  const digest = createHash("sha256").update(contents).digest("hex");
  await writeFile(binaryPath, contents, { mode: 0o700 });
  await chmod(binaryPath, 0o700);
  assert.equal(
    await assertBundledCloudflared(root, {
      platform: "darwin",
      architecture: "arm64",
      expectedDigest: digest,
    }),
    binaryPath,
  );
  await assert.rejects(
    assertBundledCloudflared(root, {
      platform: "darwin",
      architecture: "arm64",
      expectedDigest: "0".repeat(64),
    }),
    /무결성/,
  );
  await assert.rejects(
    assertBundledCloudflared(root, {
      platform: "linux",
      architecture: "arm64",
      expectedDigest: digest,
    }),
    /Apple Silicon/,
  );

  const symlinkRoot = await tempRoot();
  const symlinkPath = path.join(symlinkRoot, CLOUDFLARED_RELATIVE_PATH);
  await mkdir(path.dirname(symlinkPath), { recursive: true, mode: 0o700 });
  await symlink(binaryPath, symlinkPath);
  await assert.rejects(
    assertBundledCloudflared(symlinkRoot, {
      platform: "darwin",
      architecture: "arm64",
      expectedDigest: digest,
    }),
    /일반 파일/,
  );
});

test("a newly-created gate exposes no app before it is explicitly opened", async () => {
  const gate = await createClosedProxyGate();
  try {
    const response = await fetch(gate.origin, { redirect: "error" });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(await response.text(), /준비 중/);
  } finally {
    await gate.close();
  }
  await assert.rejects(fetch(gate.origin));
});

test("quick tunnel startup extracts an exact URL without echoing child logs", async () => {
  const managed = fakeManagedProcess();
  let invocation = null;
  const startedPromise = startQuickTunnel({
    binaryPath: "/private/cloudflared",
    gateOrigin: "http://127.0.0.1:43127",
    projectRoot: "/private/project",
    timeoutMs: 2_000,
    spawnProcess(command, args, options) {
      invocation = { command, args, options };
      return managed;
    },
  });
  managed.child.stderr.write("INF credential=must-not-be-printed\n");
  managed.child.stderr.write("│ https://safe-random-host.trycloudflare.com │\n");
  const started = await startedPromise;
  assert.equal(started.origin, "https://safe-random-host.trycloudflare.com");
  assert.equal(invocation.command, "/private/cloudflared");
  assert.deepEqual(invocation.options.env, {
    HOME: "/private/project/.local-tools",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    NO_AUTOUPDATE: "true",
  });
  await terminateManaged(started.managed, { graceMs: 10 });
});

test("quick tunnel failure is generic and never includes captured credentials", async () => {
  const managed = fakeManagedProcess();
  const startedPromise = startQuickTunnel({
    binaryPath: "/private/cloudflared",
    gateOrigin: "http://127.0.0.1:43127",
    projectRoot: "/private/project",
    timeoutMs: 2_000,
    spawnProcess() {
      return managed;
    },
  });
  managed.child.stderr.write("ERR token=super-secret-value\n");
  managed.exit(1);
  await assert.rejects(startedPromise, (error) => {
    assert.doesNotMatch(error.message, /super-secret-value/);
    assert.match(error.message, /주소를 발급하기 전/);
    return true;
  });
});

test("auth readiness requires a structurally valid status and live children", async () => {
  const live = { running: true };
  let attempts = 0;
  const status = await waitForAuthStatus({
    origin: "http://127.0.0.1:3000",
    appProcess: live,
    tunnelProcess: live,
    timeoutMs: 2_000,
    requestTimeoutMs: 100,
    async fetchImpl() {
      attempts += 1;
      if (attempts === 1) {
        return { ok: true, async json() { return { configured: true }; } };
      }
      return {
        ok: true,
        async json() {
          return { configured: false, authenticated: false, user: null };
        },
      };
    },
  });
  assert.equal(attempts, 2);
  assert.equal(status.configured, false);

  await assert.rejects(
    waitForAuthStatus({
      origin: "http://127.0.0.1:3000",
      appProcess: { running: false },
      tunnelProcess: live,
      timeoutMs: 100,
      async fetchImpl() {
        throw new Error("must not fetch");
      },
    }),
    /준비되기 전에 종료/,
  );
});

test("an already-delivered termination signal cannot be missed or reopen the gate", async () => {
  const cancellation = new AbortController();
  const reason = new Error("stop sharing now");
  cancellation.abort(reason);
  assert.throws(() => throwIfAborted(cancellation.signal), reason);
  assert.deepEqual(
    await waitForAbort(cancellation.signal, { source: "signal" }),
    { source: "signal" },
  );

  const runner = await readFile(
    new URL("./cloudflare-quick-share.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    runner,
    /throwIfCancelled\(\);\s*gate\.open\(startedTunnel\.origin\)/,
    "the synchronous cancellation check must immediately precede gate opening",
  );
  assert.match(
    runner,
    /await openBrowser\(startedTunnel\.origin\);\s*throwIfCancelled\(\);/,
    "a signal delivered while opening the browser must reach final cleanup",
  );
  assert.match(
    runner,
    /Promise\.race\(\[[\s\S]*?waitForCancellation\(\),\s*\]\)/,
    "the final wait must include the already-aborted-aware cancellation promise",
  );
});
