import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import { access, lstat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import {
  assertSupportedCloudflaredPlatform,
  CLOUDFLARED_DARWIN_ARM64_SHA256,
  CLOUDFLARED_RELATIVE_PATH,
} from "./cloudflared-install-core.mjs";

export {
  CLOUDFLARED_DARWIN_ARM64_SHA256,
  CLOUDFLARED_RELATIVE_PATH,
  CLOUDFLARED_VERSION,
} from "./cloudflared-install-core.mjs";

export const LOCAL_APP_ORIGIN = "http://127.0.0.1:3000";

const QUICK_TUNNEL_LABEL_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const QUICK_TUNNEL_CANDIDATE_PATTERN =
  /https:\/\/[^\s"'<>|\u2502\u2503}]+/g;
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const MAX_PENDING_LOG_CHARACTERS = 128 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("작업이 취소됐어요.");
  }
}

export function waitForAbort(signal, value) {
  if (signal?.aborted) return Promise.resolve(value);
  return new Promise((resolve) => {
    signal?.addEventListener("abort", () => resolve(value), { once: true });
  });
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("작업이 취소됐어요."));
      return;
    }
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("작업이 취소됐어요."));
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export function normalizeQuickTunnelOrigin(value) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error("Cloudflare 공유 주소가 정확하지 않아요.");
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Cloudflare 공유 주소가 올바른 URL이 아니에요.");
  }

  const hostname = url.hostname.toLowerCase();
  const labels = hostname.split(".");
  const validHostname =
    labels.length === 3 &&
    labels[1] === "trycloudflare" &&
    labels[2] === "com" &&
    QUICK_TUNNEL_LABEL_PATTERN.test(labels[0]);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    value !== url.origin ||
    !validHostname
  ) {
    throw new Error(
      "Cloudflare가 발급한 정확한 https://*.trycloudflare.com 주소가 필요해요.",
    );
  }
  return url.origin;
}

function quickTunnelOriginFromLine(line) {
  const cleanLine = line.replace(ANSI_ESCAPE_PATTERN, "");
  for (const match of cleanLine.matchAll(QUICK_TUNNEL_CANDIDATE_PATTERN)) {
    try {
      return normalizeQuickTunnelOrigin(match[0]);
    } catch {
      // Ignore lookalike, path-bearing, or otherwise non-canonical URLs.
    }
  }
  return null;
}

export class QuickTunnelOriginExtractor {
  #pending = "";
  #decoder = new StringDecoder("utf8");

  push(chunk) {
    this.#pending += Buffer.isBuffer(chunk)
      ? this.#decoder.write(chunk)
      : String(chunk);
    const lines = this.#pending.split(/\r?\n/);
    this.#pending = lines.pop() ?? "";
    if (this.#pending.length > MAX_PENDING_LOG_CHARACTERS) {
      this.#pending = this.#pending.slice(-MAX_PENDING_LOG_CHARACTERS);
    }
    for (const line of lines) {
      const origin = quickTunnelOriginFromLine(line);
      if (origin) return origin;
    }
    return null;
  }

  finish() {
    this.#pending += this.#decoder.end();
    const origin = quickTunnelOriginFromLine(this.#pending);
    this.#pending = "";
    return origin;
  }
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function assertBundledCloudflared(
  projectRoot,
  {
    platform = process.platform,
    architecture = process.arch,
    expectedDigest = CLOUDFLARED_DARWIN_ARM64_SHA256,
  } = {},
) {
  assertSupportedCloudflaredPlatform(platform, architecture);
  const binaryPath = path.join(path.resolve(projectRoot), CLOUDFLARED_RELATIVE_PATH);
  const toolsDirectory = path.dirname(binaryPath);
  const directoryStat = await lstat(toolsDirectory).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (
    directoryStat &&
    (!directoryStat.isDirectory() ||
      directoryStat.isSymbolicLink() ||
      (directoryStat.mode & 0o077) !== 0)
  ) {
    throw new Error("Cloudflare 공유 도구 폴더가 비공개 로컬 폴더가 아니에요.");
  }
  const fileStat = await lstat(binaryPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!fileStat) {
    throw new Error(
      "검증된 Cloudflare 공유 도구가 아직 준비되지 않았어요. npm run setup:share를 먼저 실행해주세요.",
    );
  }
  if (
    !fileStat.isFile() ||
    fileStat.isSymbolicLink() ||
    (fileStat.mode & 0o022) !== 0
  ) {
    throw new Error("Cloudflare 공유 도구 경로가 안전한 일반 파일이 아니에요.");
  }
  await access(binaryPath, fsConstants.X_OK).catch(() => {
    throw new Error("Cloudflare 공유 도구를 실행할 수 없어요.");
  });
  const actualDigest = await sha256File(binaryPath);
  if (actualDigest !== expectedDigest) {
    throw new Error(
      "Cloudflare 공유 도구의 무결성 검사에 실패했어요. 실행하지 않았어요.",
    );
  }
  return binaryPath;
}

export function cloudflaredEnvironment(projectRoot) {
  return Object.freeze({
    HOME: path.join(path.resolve(projectRoot), ".local-tools"),
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    NO_AUTOUPDATE: "true",
  });
}

export function cloudflaredArguments(gateOrigin) {
  const gateUrl = new URL(gateOrigin);
  if (
    gateUrl.protocol !== "http:" ||
    gateUrl.hostname !== "127.0.0.1" ||
    !gateUrl.port ||
    gateUrl.pathname !== "/" ||
    gateUrl.search ||
    gateUrl.hash ||
    gateOrigin !== gateUrl.origin
  ) {
    throw new Error("Cloudflare tunnel upstream은 임시 127.0.0.1 gate여야 해요.");
  }
  return [
    "tunnel",
    "--config",
    "/dev/null",
    "--no-autoupdate",
    "--loglevel",
    "info",
    "--protocol",
    "http2",
    "--url",
    gateUrl.origin,
  ];
}

export function remoteAppEnvironment(parentEnvironment, origin, runtimeToken) {
  const appOrigin = normalizeQuickTunnelOrigin(origin);
  if (
    typeof runtimeToken !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      runtimeToken,
    )
  ) {
    throw new Error("공유 작업 토큰이 올바르지 않아요.");
  }
  return {
    ...parentEnvironment,
    APP_ORIGIN: appOrigin,
    RIFF_REMOTE_ACCESS: "1",
    RIFF_RUNTIME_PARENT_TOKEN: runtimeToken,
    RIFF_OPEN_BROWSER: "0",
  };
}

function filteredProxyHeaders(headers, publicOrigin) {
  const connectionTokens = new Set(
    String(headers.connection ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (
      value === undefined ||
      HOP_BY_HOP_HEADERS.has(lowerName) ||
      connectionTokens.has(lowerName) ||
      lowerName === "x-forwarded-host" ||
      lowerName === "x-forwarded-proto"
    ) {
      continue;
    }
    result[lowerName] = value;
  }
  const publicUrl = new URL(publicOrigin);
  result.host = publicUrl.host;
  result["x-forwarded-host"] = publicUrl.host;
  result["x-forwarded-proto"] = "https";
  result.connection = "close";
  return result;
}

function unavailable(response) {
  response.writeHead(503, {
    "cache-control": "no-store",
    connection: "close",
    "content-type": "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end("공유 준비 중이에요.\n");
}

export async function createClosedProxyGate({
  upstreamOrigin = LOCAL_APP_ORIGIN,
} = {}) {
  if (upstreamOrigin !== LOCAL_APP_ORIGIN) {
    throw new Error("share gate upstream은 127.0.0.1:3000으로 고정되어야 해요.");
  }
  const upstreamUrl = new URL(upstreamOrigin);
  let publicOrigin = null;
  let enabled = false;
  let closed = false;
  const sockets = new Set();
  const proxyRequests = new Set();

  const server = http.createServer((request, response) => {
    if (
      !enabled ||
      !publicOrigin ||
      request.headers.host !== new URL(publicOrigin).host ||
      typeof request.url !== "string" ||
      !request.url.startsWith("/") ||
      request.url.startsWith("//")
    ) {
      unavailable(response);
      return;
    }

    const proxyRequest = http.request({
      hostname: upstreamUrl.hostname,
      port: Number(upstreamUrl.port),
      method: request.method,
      path: request.url,
      headers: filteredProxyHeaders(request.headers, publicOrigin),
    });
    proxyRequests.add(proxyRequest);
    proxyRequest.once("close", () => proxyRequests.delete(proxyRequest));
    proxyRequest.once("response", (proxyResponse) => {
      const responseHeaders = {};
      for (const [name, value] of Object.entries(proxyResponse.headers)) {
        if (value !== undefined && !HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
          responseHeaders[name] = value;
        }
      }
      responseHeaders.connection = "close";
      response.writeHead(proxyResponse.statusCode ?? 502, responseHeaders);
      proxyResponse.pipe(response);
    });
    proxyRequest.once("error", () => {
      if (!response.headersSent) unavailable(response);
      else response.destroy();
    });
    request.once("aborted", () => proxyRequest.destroy());
    request.pipe(proxyRequest);
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.on("clientError", (_error, socket) => socket.destroy());

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("로컬 공유 gate 포트를 열지 못했어요.");
  }

  function disable() {
    enabled = false;
    for (const proxyRequest of proxyRequests) proxyRequest.destroy();
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    open(origin) {
      if (closed) throw new Error("이미 닫힌 공유 gate예요.");
      publicOrigin = normalizeQuickTunnelOrigin(origin);
      enabled = true;
    },
    disable,
    async close() {
      if (closed) return;
      closed = true;
      disable();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export function spawnManaged(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
  let settled = false;
  const completion = new Promise((resolve) => {
    child.once("error", (error) => {
      settled = true;
      resolve({ code: null, signal: null, error });
    });
    child.once("exit", (code, signal) => {
      settled = true;
      resolve({ code, signal, error: null });
    });
  });
  return {
    child,
    completion,
    get running() {
      return !settled;
    },
  };
}

export async function terminateManaged(managed, { graceMs = 5_000 } = {}) {
  if (!managed) return null;
  if (!managed.running) return managed.completion;
  managed.child.kill("SIGTERM");
  const completed = await Promise.race([
    managed.completion.then((result) => ({ completed: true, result })),
    delay(graceMs).then(() => ({ completed: false, result: null })),
  ]);
  if (completed.completed) return completed.result;
  if (managed.running) managed.child.kill("SIGKILL");
  return managed.completion;
}

export async function startQuickTunnel({
  binaryPath,
  gateOrigin,
  projectRoot,
  signal,
  timeoutMs = 30_000,
  spawnProcess = spawnManaged,
}) {
  const managed = spawnProcess(binaryPath, cloudflaredArguments(gateOrigin), {
    cwd: projectRoot,
    env: cloudflaredEnvironment(projectRoot),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutExtractor = new QuickTunnelOriginExtractor();
  const stderrExtractor = new QuickTunnelOriginExtractor();
  let resolveOrigin;
  const originPromise = new Promise((resolve) => {
    resolveOrigin = resolve;
  });
  let foundOrigin = null;
  const inspect = (extractor, chunk) => {
    if (foundOrigin) return;
    const origin = extractor.push(chunk);
    if (origin) {
      foundOrigin = origin;
      resolveOrigin(origin);
    }
  };
  managed.child.stdout?.on("data", (chunk) => inspect(stdoutExtractor, chunk));
  managed.child.stderr?.on("data", (chunk) => inspect(stderrExtractor, chunk));

  let timeout;
  const abort = () => rejectWait(signal?.reason ?? new Error("작업이 취소됐어요."));
  let rejectWait;
  const timeoutPromise = new Promise((_resolve, reject) => {
    rejectWait = reject;
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("작업이 취소됐어요."));
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    timeout = setTimeout(() => {
      reject(
        new Error(
          `Cloudflare가 ${Math.ceil(timeoutMs / 1_000)}초 안에 임시 공유 주소를 발급하지 못했어요.`,
        ),
      );
    }, timeoutMs);
  });
  const exitPromise = managed.completion.then(() => {
    const finalOrigin = stdoutExtractor.finish() ?? stderrExtractor.finish();
    if (finalOrigin) return finalOrigin;
    throw new Error("Cloudflare 임시 공유 연결이 주소를 발급하기 전에 종료됐어요.");
  });

  try {
    const origin = await Promise.race([originPromise, timeoutPromise, exitPromise]);
    return { origin: normalizeQuickTunnelOrigin(origin), managed };
  } catch (error) {
    await terminateManaged(managed);
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

async function fetchAuthStatus(origin, { fetchImpl, signal, timeoutMs }) {
  const timeoutController = new AbortController();
  const abort = () => timeoutController.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${origin}/api/auth/status`, {
      cache: "no-store",
      redirect: "error",
      signal: timeoutController.signal,
    });
    if (!response.ok) return null;
    const value = await response.json();
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.configured !== "boolean" ||
      typeof value.authenticated !== "boolean" ||
      !("user" in value)
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

export async function waitForAuthStatus({
  origin,
  appProcess,
  tunnelProcess,
  signal,
  timeoutMs = 60_000,
  requestTimeoutMs = 1_500,
  fetchImpl = fetch,
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason ?? new Error("작업이 취소됐어요.");
    if (appProcess && !appProcess.running) {
      throw new Error("Riff Sketchbook 앱이 준비되기 전에 종료됐어요.");
    }
    if (tunnelProcess && !tunnelProcess.running) {
      throw new Error("Cloudflare 공유 연결이 준비되기 전에 종료됐어요.");
    }
    const status = await fetchAuthStatus(origin, {
      fetchImpl,
      signal,
      timeoutMs: requestTimeoutMs,
    });
    if (status) return status;
    await delay(250, signal);
  }
  throw new Error("Riff Sketchbook이 공유용으로 준비되는 데 시간이 너무 오래 걸렸어요.");
}
