import process from "node:process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  assertBundledCloudflared,
  createClosedProxyGate,
  LOCAL_APP_ORIGIN,
  remoteAppEnvironment,
  spawnManaged,
  startQuickTunnel,
  terminateManaged,
  throwIfAborted,
  waitForAbort,
  waitForAuthStatus,
} from "./cloudflare-quick-share-core.mjs";
import {
  acquireOperationLock,
  OperationLockConflictError,
} from "./operation-lock.mjs";
import { assertNoIncompleteRestoreState } from "./restore-state.mjs";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const SIGNAL_EXIT_CODES = new Map([
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143],
]);

let gate = null;
let requestedSignal = null;
const cancellation = new AbortController();

function handleSignal(signal) {
  if (requestedSignal) return;
  requestedSignal = signal;
  gate?.disable();
  cancellation.abort(new Error(`${signal} 신호로 공유를 종료했어요.`));
}

function throwIfCancelled() {
  throwIfAborted(cancellation.signal);
}

function waitForCancellation() {
  return waitForAbort(cancellation.signal, { source: "signal", result: null });
}

const signalHandlers = new Map(
  ["SIGHUP", "SIGINT", "SIGTERM"].map((signal) => [
    signal,
    () => handleSignal(signal),
  ]),
);
for (const [signal, handler] of signalHandlers) process.on(signal, handler);

async function openBrowser(origin) {
  throwIfCancelled();
  const opener = spawnManaged("/usr/bin/open", [origin], {
    cwd: PROJECT_ROOT,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    stdio: "ignore",
  });
  const ending = await Promise.race([
    opener.completion.then(() => "opened"),
    waitForCancellation().then(() => "cancelled"),
  ]);
  if (ending === "cancelled") {
    await terminateManaged(opener, { graceMs: 1_000 }).catch(() => undefined);
    throwIfCancelled();
  }
}

async function main() {
  const cloudflaredBinary = await assertBundledCloudflared(PROJECT_ROOT);
  await assertNoIncompleteRestoreState(PROJECT_ROOT);

  let runtimeLock = null;
  let tunnel = null;
  let appProcess = null;
  try {
    try {
      runtimeLock = await acquireOperationLock("runtime", { root: PROJECT_ROOT });
    } catch (error) {
      if (error instanceof OperationLockConflictError) {
        throw new Error(
          "이미 실행 중인 Riff Sketchbook 또는 다른 점검 작업을 먼저 종료한 뒤 공유를 다시 시작해주세요.",
          { cause: error },
        );
      }
      throw error;
    }
    await assertNoIncompleteRestoreState(PROJECT_ROOT);

    gate = await createClosedProxyGate();
    console.log("Cloudflare 임시 공유 주소를 안전하게 준비하고 있어요…");
    const startedTunnel = await startQuickTunnel({
      binaryPath: cloudflaredBinary,
      gateOrigin: gate.origin,
      projectRoot: PROJECT_ROOT,
      signal: cancellation.signal,
    });
    tunnel = startedTunnel.managed;

    appProcess = spawnManaged(
      process.execPath,
      [path.join(PROJECT_ROOT, "scripts", "start-app.mjs")],
      {
        cwd: PROJECT_ROOT,
        env: remoteAppEnvironment(
          process.env,
          startedTunnel.origin,
          runtimeLock.token,
        ),
        stdio: "inherit",
      },
    );

    const localStatus = await waitForAuthStatus({
      origin: LOCAL_APP_ORIGIN,
      appProcess,
      tunnelProcess: tunnel,
      signal: cancellation.signal,
    });
    if (!localStatus.configured) {
      throw new Error(
        "아직 계정이 없어서 인터넷 공유를 열지 않았어요. Start Riff Sketchbook으로 로컬 설정을 먼저 끝내주세요.",
      );
    }

    // A termination signal must never race a previously-completed readiness
    // check and reopen the public gate after the signal handler closed it.
    throwIfCancelled();
    gate.open(startedTunnel.origin);
    const publicStatus = await waitForAuthStatus({
      origin: startedTunnel.origin,
      appProcess,
      tunnelProcess: tunnel,
      signal: cancellation.signal,
      timeoutMs: 90_000,
      requestTimeoutMs: 5_000,
    });
    if (!publicStatus.configured) {
      throw new Error("Cloudflare 공유 상태를 안전하게 확인하지 못했어요.");
    }
    throwIfCancelled();

    console.log("");
    console.log("친구에게 아래 주소를 보내주세요:");
    console.log(startedTunnel.origin);
    console.log("");
    console.log(
      "이 주소는 링크를 아는 누구나 열 수 있어요. 친구에게만 보내고, 로그인 정보는 다른 곳에 공개하지 마세요.",
    );
    console.log(
      "공유를 끝내려면 이 창에서 Control + C를 누르세요. 종료하면 이 주소로는 더 이상 접속할 수 없어요.",
    );
    await openBrowser(startedTunnel.origin);
    throwIfCancelled();

    const ending = await Promise.race([
      appProcess.completion.then((result) => ({ source: "app", result })),
      tunnel.completion.then((result) => ({ source: "tunnel", result })),
      waitForCancellation(),
    ]);
    if (ending.source !== "signal") {
      throw new Error(
        ending.source === "tunnel"
          ? "Cloudflare 공유 연결이 종료됐어요. 이제 외부에서 접속할 수 없어요."
          : "Riff Sketchbook 앱이 종료되어 Cloudflare 공유도 닫았어요.",
      );
    }
  } finally {
    gate?.disable();
    await gate?.close().catch(() => undefined);
    await Promise.all([
      terminateManaged(tunnel).catch(() => undefined),
      terminateManaged(appProcess).catch(() => undefined),
    ]);
    await runtimeLock?.release().catch(() => undefined);
  }
}

try {
  await main();
  if (requestedSignal) {
    console.log("공유를 종료했어요. 임시 주소는 더 이상 접속되지 않아요.");
    process.exitCode = SIGNAL_EXIT_CODES.get(requestedSignal) ?? 1;
  }
} catch (error) {
  if (requestedSignal) {
    console.log("공유를 종료했어요. 임시 주소는 더 이상 접속되지 않아요.");
    process.exitCode = SIGNAL_EXIT_CODES.get(requestedSignal) ?? 1;
  } else {
    console.error(
      error instanceof Error ? error.message : "Cloudflare 공유를 시작하지 못했어요.",
    );
    process.exitCode = 1;
  }
} finally {
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
}
