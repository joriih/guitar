import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import nextEnv from "@next/env";

import {
  allowedAppOrigins,
  DEFAULT_APP_ORIGIN,
  normalizeAppOrigin,
} from "../lib/app-origin.mjs";
import {
  acquireOperationLock,
  OperationLockConflictError,
} from "./operation-lock.mjs";
import {
  inspectProcessIdentity,
  PROCESS_IDENTITY_STATUS,
  readProcessStartSignature,
} from "./process-identity.mjs";
import { assertNoIncompleteRestoreState } from "./restore-state.mjs";
import {
  createServerProcessState,
  isServerProcessState,
  isWithinStartingGrace,
} from "./server-process-state.mjs";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd(), false);

// Validate the two-part remote-access opt-in before touching the database or
// starting a listener. The returned list is also deliberately evaluated here
// even though the server validates every mutation independently.
allowedAppOrigins(process.env.APP_ORIGIN, process.env.RIFF_REMOTE_ACCESS);
const localPortValue = process.env.RIFF_LOCAL_APP_PORT;
if (
  localPortValue !== undefined &&
  (!/^[0-9]{1,5}$/.test(localPortValue) ||
    Number(localPortValue) < 1024 ||
    Number(localPortValue) > 65_535)
) {
  throw new Error("RIFF_LOCAL_APP_PORT는 1024~65535 사이의 포트여야 해요.");
}
const APP_PORT = localPortValue === undefined ? 3000 : Number(localPortValue);
const LOCAL_APP_URL =
  APP_PORT === 3000
    ? DEFAULT_APP_ORIGIN
    : `http://127.0.0.1:${String(APP_PORT)}`;
const BROWSER_URL = process.env.APP_ORIGIN
  ? normalizeAppOrigin(process.env.APP_ORIGIN)
  : LOCAL_APP_URL;
const POSTGRES_BIN =
  process.env.POSTGRES_BIN ?? "/Applications/Postgres.app/Contents/Versions/latest/bin";
const SERVER_STATE_PATH = process.env.RIFF_SERVER_STATE_PATH;
if (SERVER_STATE_PATH !== undefined) {
  delete process.env.RIFF_SERVER_STATE_PATH;
  if (
    !path.isAbsolute(SERVER_STATE_PATH) ||
    path.basename(SERVER_STATE_PATH) !== "server-process.json"
  ) {
    throw new Error("설치 앱의 서버 상태 파일 경로가 올바르지 않아요.");
  }
}
const BUILD_INPUTS = [
  "app",
  "components",
  "lib",
  "public",
  "types",
  "next.config.ts",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  ".env.local",
];

let activeChild = null;
let requestedSignal = null;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function throwIfInterrupted() {
  if (requestedSignal) {
    throw new Error(`${requestedSignal} 신호로 앱 시작을 취소했어요.`);
  }
}

function handleSignal(signal) {
  requestedSignal = signal;
  activeChild?.kill(signal);
}

const onSigint = () => handleSignal("SIGINT");
const onSigterm = () => handleSignal("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: options.quiet ? "ignore" : "inherit",
    });
    activeChild = child;
    child.once("error", (error) => {
      if (activeChild === child) activeChild = null;
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (activeChild === child) activeChild = null;
      if (code === 0) resolve({ code, signal });
      else if (options.allowFailure) resolve({ code, signal });
      else reject(new Error(`${path.basename(command)} 실행에 실패했어요 (${signal ?? code}).`));
    });
  });
}

async function isPostgresReady() {
  const result = await run(
    path.join(POSTGRES_BIN, "pg_isready"),
    ["-h", "127.0.0.1", "-p", "5432", "-t", "1"],
    { quiet: true, allowFailure: true },
  );
  return result.code === 0;
}

async function ensurePostgres() {
  const readyBinary = path.join(POSTGRES_BIN, "pg_isready");
  try {
    await access(readyBinary, fsConstants.X_OK);
  } catch {
    throw new Error("Postgres.app을 찾을 수 없어요. Applications 폴더를 확인해주세요.");
  }

  if (await isPostgresReady()) return;
  await run("/usr/bin/open", ["-a", "Postgres"]);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    throwIfInterrupted();
    if (await isPostgresReady()) return;
    await delay(1_000);
  }
  throw new Error("PostgreSQL이 준비되지 않았어요. Postgres.app을 확인해주세요.");
}

async function newestMtime(filePath) {
  const fileStat = await lstat(filePath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!fileStat) return 0;
  if (!fileStat.isDirectory() || fileStat.isSymbolicLink()) return fileStat.mtimeMs;

  // Copying a built app necessarily gives its destination directories a new
  // mtime even when every source file is unchanged. Directory mtimes are not
  // build inputs; only the files beneath them are.
  let newest = 0;

  for (const entry of await readdir(filePath)) {
    newest = Math.max(newest, await newestMtime(path.join(filePath, entry)));
  }
  return newest;
}

async function buildIsRequired() {
  const buildIdPath = path.join(process.cwd(), ".next", "BUILD_ID");
  const buildStat = await lstat(buildIdPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!buildStat?.isFile()) return true;

  for (const input of BUILD_INPUTS) {
    if ((await newestMtime(path.join(process.cwd(), input))) > buildStat.mtimeMs) {
      return true;
    }
  }
  return false;
}

async function portHasListener() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: APP_PORT });
    const finish = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(750, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function readServerState() {
  if (SERVER_STATE_PATH === undefined) return null;
  const stateStat = await lstat(SERVER_STATE_PATH).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!stateStat) return null;
  if (!stateStat.isFile() || stateStat.isSymbolicLink()) {
    throw new Error("설치 앱의 서버 상태 파일이 안전하지 않아요.");
  }
  let value;
  try {
    value = JSON.parse(await readFile(SERVER_STATE_PATH, "utf8"));
  } catch {
    throw new Error("설치 앱의 서버 상태 파일이 손상됐어요.");
  }
  if (!isServerProcessState(value, process.cwd())) {
    throw new Error("설치 앱의 서버 상태 파일 내용이 올바르지 않아요.");
  }
  return value;
}

async function assertNoOrphanServer() {
  const state = await readServerState();
  if (!state) return;
  const identityStatus = await inspectProcessIdentity(
    state.pid,
    state.processStart,
  );
  if (identityStatus === PROCESS_IDENTITY_STATUS.INDETERMINATE) {
    throw new Error(
      "이전 Riff Sketchbook 서버 상태를 안전하게 확인할 수 없어요. Mac을 재시작한 뒤 다시 열어 주세요.",
    );
  }
  if (identityStatus === PROCESS_IDENTITY_STATUS.LIVE) {
    throw new Error(
      "이전 Riff Sketchbook 서버가 아직 실행 중이에요. Mac을 재시작한 뒤 다시 열어 주세요.",
    );
  }
  if (isWithinStartingGrace(state)) {
    throw new Error(
      "이전 Riff Sketchbook 서버가 시작 중이었어요. 잠시 기다린 뒤 다시 열어 주세요.",
    );
  }
  await unlink(SERVER_STATE_PATH);
}

async function writeServerState(state) {
  if (SERVER_STATE_PATH === undefined) return;
  const directory = path.dirname(SERVER_STATE_PATH);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("설치 앱의 상태 폴더가 안전하지 않아요.");
  }
  const temporaryPath = `${SERVER_STATE_PATH}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, SERVER_STATE_PATH);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function writeStartingServerState() {
  if (SERVER_STATE_PATH === undefined) return null;
  const state = createServerProcessState({
    phase: "starting",
    pid: process.pid,
    processStart: await readProcessStartSignature(process.pid, {
      required: true,
    }),
    runtimePath: process.cwd(),
  });
  await writeServerState(state);
  return state;
}

async function writeRunningServerState(child) {
  if (SERVER_STATE_PATH === undefined) return null;
  const state = createServerProcessState({
    phase: "running",
    pid: child.pid,
    processStart: await readProcessStartSignature(child.pid, {
      required: true,
    }),
    runtimePath: process.cwd(),
  });
  await writeServerState(state);
  return state;
}

async function clearServerState(expectedState) {
  if (!expectedState) return;
  const state = await readServerState();
  if (
    !state ||
    state.phase !== expectedState.phase ||
    state.pid !== expectedState.pid ||
    state.processStart !== expectedState.processStart ||
    state.createdAt !== expectedState.createdAt
  ) {
    return;
  }
  await unlink(SERVER_STATE_PATH);
}

async function getAppStatus() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(`${LOCAL_APP_URL}/api/auth/status`, {
      cache: "no-store",
      signal: controller.signal,
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
  }
}

async function openBrowser() {
  if (process.env.RIFF_OPEN_BROWSER !== "1") return;
  await run("/usr/bin/open", [BROWSER_URL], { quiet: true, allowFailure: true });
}

async function handleExistingProcess(needsBuild, lockConflict = false) {
  const status = await getAppStatus();
  if (status) {
    if (needsBuild) {
      throw new Error(
        "앱 파일이 바뀌었어요. 기존 Riff Sketchbook 터미널에서 Control + C를 누른 뒤 다시 열어주세요.",
      );
    }
    await openBrowser();
    console.log(`Riff Sketchbook이 이미 실행 중이에요: ${BROWSER_URL}`);
    return true;
  }

  if (lockConflict || (await portHasListener())) {
    throw new Error(
      "Riff Sketchbook 시작 포트를 다른 프로세스가 사용 중이거나 기존 앱이 응답하지 않아요. 실행 중인 터미널을 종료한 뒤 다시 시도해주세요.",
    );
  }
  return false;
}

async function waitForBrowser(child) {
  if (process.env.RIFF_OPEN_BROWSER !== "1") return;
  for (let attempt = 0; attempt < 60 && child.exitCode === null; attempt += 1) {
    if (await getAppStatus()) {
      await openBrowser();
      return;
    }
    await delay(500);
  }
  if (child.exitCode === null) {
    console.error("앱이 30초 안에 열리지 않았어요. 이 터미널의 오류 내용을 확인해주세요.");
  }
}

async function startServer() {
  const startingState = await writeStartingServerState();
  const nextBinary = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
  let child;
  try {
    child = spawn(
      process.execPath,
      [nextBinary, "start", "--hostname", "127.0.0.1", "--port", String(APP_PORT)],
      {
        env: {
          ...process.env,
          PORT: String(APP_PORT),
        },
        stdio: "inherit",
      },
    );
  } catch (error) {
    await clearServerState(startingState).catch(() => undefined);
    throw error;
  }
  activeChild = child;
  const exitPromise = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  let runningState;
  try {
    runningState = await writeRunningServerState(child);
  } catch (error) {
    child.kill("SIGTERM");
    await exitPromise.catch(() => undefined);
    await clearServerState(startingState).catch(() => undefined);
    if (activeChild === child) activeChild = null;
    throw error;
  }
  let result;
  try {
    await waitForBrowser(child);
    result = await exitPromise;
  } finally {
    await clearServerState(runningState);
    if (activeChild === child) activeChild = null;
  }
  if (requestedSignal) return;
  if (result.code !== 0) {
    throw new Error(`Riff Sketchbook 서버가 종료됐어요 (${result.signal ?? result.code}).`);
  }
}

async function main() {
  // Determine staleness before trusting an already-running server.
  const needsBuild = await buildIsRequired();
  await assertNoIncompleteRestoreState();
  const runtimeParentToken = process.env.RIFF_RUNTIME_PARENT_TOKEN;
  let operationLock;
  try {
    operationLock = await acquireOperationLock(
      "runtime",
      runtimeParentToken === undefined
        ? undefined
        : { parentToken: runtimeParentToken },
    );
    // The wrapper capability is needed only to acquire this in-memory nested
    // lease. Do not forward it to builds, maintenance commands, or Next.js.
    if (runtimeParentToken !== undefined) {
      delete process.env.RIFF_RUNTIME_PARENT_TOKEN;
    }
  } catch (error) {
    if (
      runtimeParentToken === undefined &&
      error instanceof OperationLockConflictError
    ) {
      if (await handleExistingProcess(needsBuild, true)) return;
    }
    throw error;
  }
  try {
    // This is the authoritative generation check. A restore can race the fast
    // preflight above and then crash; once the runtime lease exists, no new
    // restore can create artifacts between this check and server startup.
    await assertNoIncompleteRestoreState();
  } catch (error) {
    await operationLock.release();
    throw error;
  }

  const installLockRoot = process.env.RIFF_INSTALL_LOCK_ROOT;
  let installOperationLock = null;
  try {
    if (installLockRoot !== undefined) {
      delete process.env.RIFF_INSTALL_LOCK_ROOT;
      try {
        installOperationLock = await acquireOperationLock("runtime", {
          root: installLockRoot,
        });
      } catch (error) {
        if (
          error instanceof OperationLockConflictError &&
          (await handleExistingProcess(needsBuild, true))
        ) {
          return;
        }
        throw error;
      }
    }
    if (await handleExistingProcess(needsBuild)) return;
    await assertNoOrphanServer();
    throwIfInterrupted();
    await ensurePostgres();
    throwIfInterrupted();
    await run(process.execPath, [path.join(process.cwd(), "scripts", "db-init.mjs")], {
      env: { ...process.env, RIFF_OPERATION_PARENT_TOKEN: operationLock.token },
    });
    throwIfInterrupted();
    await run(
      process.execPath,
      [path.join(process.cwd(), "scripts", "audio-cleanup.mjs")],
      {
        env: {
          ...process.env,
          RIFF_AUDIO_CLEANUP_PARENT_TOKEN: operationLock.token,
        },
      },
    );
    throwIfInterrupted();
    if (needsBuild) {
      if (process.env.RIFF_PACKAGED_APP === "1") {
        throw new Error(
          "설치된 앱 실행 파일이 불완전해요. 원본 프로젝트의 Install Riff Sketchbook App.command를 다시 실행해 주세요.",
        );
      }
      console.log("더 빠르고 안정적인 실행을 위해 앱을 준비하고 있어요…");
      await run("npm", ["run", "build"]);
    }
    throwIfInterrupted();
    await startServer();
  } finally {
    try {
      await installOperationLock?.release();
    } finally {
      await operationLock.release();
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Riff Sketchbook을 시작하지 못했어요.");
  process.exitCode = 1;
} finally {
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
}
