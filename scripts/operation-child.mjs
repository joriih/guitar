import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { acquireOperationLock } from "./operation-lock.mjs";

const SIGNAL_EXIT_CODES = new Map([
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143],
]);

let activeChild = null;
let requestedSignal = null;

function handleSignal(signal) {
  requestedSignal ??= signal;
  activeChild?.kill(signal);
}

const signalHandlers = new Map(
  [...SIGNAL_EXIT_CODES.keys()].map((signal) => [
    signal,
    () => handleSignal(signal),
  ]),
);
for (const [signal, handler] of signalHandlers) process.on(signal, handler);

function throwIfInterrupted() {
  if (requestedSignal) {
    throw new Error(`${requestedSignal} 신호로 중첩 명령을 취소했어요.`);
  }
}

async function run() {
  const parentToken = process.env.RIFF_OPERATION_PARENT_TOKEN;
  const operationRoot = process.env.RIFF_OPERATION_ROOT ?? process.cwd();
  const chainSource = process.env.RIFF_OPERATION_CHAIN;
  const commandLeaseIndexSource =
    process.env.RIFF_OPERATION_COMMAND_LEASE_INDEX;
  const inheritedCommandToken =
    process.env.RIFF_OPERATION_COMMAND_PARENT_TOKEN;
  const inheritedCommandRoot = process.env.RIFF_OPERATION_COMMAND_ROOT;
  delete process.env.RIFF_OPERATION_PARENT_TOKEN;
  delete process.env.RIFF_OPERATION_ROOT;
  delete process.env.RIFF_OPERATION_CHAIN;
  delete process.env.RIFF_OPERATION_COMMAND_LEASE_INDEX;
  delete process.env.RIFF_OPERATION_COMMAND_PARENT_TOKEN;
  delete process.env.RIFF_OPERATION_COMMAND_ROOT;

  const command = process.argv[2];
  const args = process.argv.slice(3);
  if (!parentToken || !command) {
    throw new Error("중첩 명령의 부모 작업 토큰과 실행 파일이 필요해요.");
  }
  let remainingChain = [];
  if (chainSource) {
    try {
      remainingChain = JSON.parse(chainSource);
    } catch {
      throw new Error("중첩 명령의 추가 작업 토큰 정보가 올바르지 않아요.");
    }
    if (
      !Array.isArray(remainingChain) ||
      remainingChain.some(
        (item) =>
          !item ||
          typeof item !== "object" ||
          typeof item.root !== "string" ||
          item.root.length === 0 ||
          typeof item.token !== "string" ||
          item.token.length === 0,
      )
    ) {
      throw new Error("중첩 명령의 추가 작업 토큰 정보가 올바르지 않아요.");
    }
  }
  const hasInheritedCommandLease =
    inheritedCommandToken !== undefined || inheritedCommandRoot !== undefined;
  if (
    (hasInheritedCommandLease &&
      (typeof inheritedCommandToken !== "string" ||
        inheritedCommandToken.length === 0 ||
        typeof inheritedCommandRoot !== "string" ||
        inheritedCommandRoot.length === 0 ||
        commandLeaseIndexSource !== undefined)) ||
    (!hasInheritedCommandLease &&
      (typeof commandLeaseIndexSource !== "string" ||
        !/^\d+$/.test(commandLeaseIndexSource) ||
        Number(commandLeaseIndexSource) > remainingChain.length))
  ) {
    throw new Error("실제 명령이 사용할 작업 lease 정보가 올바르지 않아요.");
  }

  // A physical child lease keeps the parent's exclusion semantics alive if
  // the parent is killed while pg_dump, psql, a build, or another child is
  // still using the protected generation.
  const operationLock = await acquireOperationLock("doctor", {
    root: operationRoot,
    parentToken,
  });
  try {
    throwIfInterrupted();
    let childCommand = command;
    let childArguments = args;
    const childEnvironment = { ...process.env };
    let commandToken = inheritedCommandToken;
    let commandRoot = inheritedCommandRoot;
    let commandLeaseIndex = hasInheritedCommandLease
      ? null
      : Number(commandLeaseIndexSource);
    if (commandLeaseIndex === 0) {
      commandToken = operationLock.token;
      commandRoot = operationRoot;
      commandLeaseIndex = null;
    }
    if (remainingChain.length > 0) {
      const [nextLease, ...followingLeases] = remainingChain;
      childCommand = process.execPath;
      childArguments = [fileURLToPath(import.meta.url), command, ...args];
      childEnvironment.RIFF_OPERATION_PARENT_TOKEN = nextLease.token;
      childEnvironment.RIFF_OPERATION_ROOT = nextLease.root;
      if (commandToken && commandRoot) {
        childEnvironment.RIFF_OPERATION_COMMAND_PARENT_TOKEN = commandToken;
        childEnvironment.RIFF_OPERATION_COMMAND_ROOT = commandRoot;
      } else {
        childEnvironment.RIFF_OPERATION_COMMAND_LEASE_INDEX = String(
          commandLeaseIndex - 1,
        );
      }
      if (followingLeases.length > 0) {
        childEnvironment.RIFF_OPERATION_CHAIN = JSON.stringify(followingLeases);
      }
    } else {
      if (!commandToken || !commandRoot) {
        throw new Error("실제 명령이 사용할 작업 lease를 선택하지 못했어요.");
      }
      childEnvironment.RIFF_OPERATION_PARENT_TOKEN = commandToken;
    }
    const result = await new Promise((resolve, reject) => {
      const child = spawn(childCommand, childArguments, {
        cwd: process.cwd(),
        env: childEnvironment,
        stdio: "inherit",
      });
      activeChild = child;
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    activeChild = null;
    if (requestedSignal) {
      process.exitCode = SIGNAL_EXIT_CODES.get(requestedSignal) ?? 1;
      return;
    }
    if (result.code !== 0) {
      throw new Error(
        `${path.basename(command)} 실행에 실패했어요 (${result.signal ?? result.code}).`,
      );
    }
  } finally {
    await operationLock.release();
  }
}

try {
  await run();
} catch (error) {
  if (!requestedSignal) {
    console.error(
      error instanceof Error ? error.message : "중첩 명령을 실행하지 못했어요.",
    );
  }
  process.exitCode = requestedSignal
    ? (SIGNAL_EXIT_CODES.get(requestedSignal) ?? 1)
    : 1;
} finally {
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
}
