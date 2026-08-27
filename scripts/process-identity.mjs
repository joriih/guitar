import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const PROCESS_IDENTITY_STATUS = Object.freeze({
  INDETERMINATE: "indeterminate",
  LIVE: "live",
  STALE: "stale",
});

function assertPid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new TypeError("프로세스 PID는 1보다 큰 안전한 정수여야 해요.");
  }
}

function assertExpectedSignature(signature) {
  if (typeof signature !== "string" || signature.length === 0) {
    throw new TypeError("프로세스 시작 시각 서명이 올바르지 않아요.");
  }
}

export async function readProcessStartSignature(
  pid,
  { required = false, execute = execFileAsync } = {},
) {
  assertPid(pid);
  if (typeof execute !== "function") {
    throw new TypeError("프로세스 확인 함수가 올바르지 않아요.");
  }

  try {
    const { stdout } = await execute(
      "/bin/ps",
      ["-p", String(pid), "-o", "lstart="],
      { encoding: "utf8", maxBuffer: 4_096 },
    );
    const signature = typeof stdout === "string" ? stdout.trim() : "";
    if (signature) return signature;
    if (required) {
      throw new Error("프로세스의 시작 시각을 확인할 수 없어요.");
    }
    return null;
  } catch (error) {
    if (error?.code === 1 || error?.code === "1") {
      if (required) {
        throw new Error("프로세스가 이미 종료되어 시작 시각을 확인할 수 없어요.", {
          cause: error,
        });
      }
      return null;
    }
    if (required) {
      throw new Error("프로세스의 시작 시각을 안전하게 확인할 수 없어요.", {
        cause: error,
      });
    }
    // A transient ps failure must never make a possibly-live process look stale.
    return undefined;
  }
}

export function classifyProcessIdentity(expectedSignature, observedSignature) {
  assertExpectedSignature(expectedSignature);
  if (observedSignature === undefined) {
    return PROCESS_IDENTITY_STATUS.INDETERMINATE;
  }
  if (observedSignature === null || observedSignature !== expectedSignature) {
    return PROCESS_IDENTITY_STATUS.STALE;
  }
  return PROCESS_IDENTITY_STATUS.LIVE;
}

export async function inspectProcessIdentity(
  pid,
  expectedSignature,
  options,
) {
  const observedSignature = await readProcessStartSignature(pid, options);
  return classifyProcessIdentity(expectedSignature, observedSignature);
}
