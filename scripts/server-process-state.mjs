export const SERVER_PROCESS_STATE_VERSION = 2;
export const SERVER_STARTING_GRACE_MS = 60_000;

const PHASES = new Set(["running", "starting"]);

export function isServerProcessState(value, expectedRuntimePath) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      value.version === SERVER_PROCESS_STATE_VERSION &&
      PHASES.has(value.phase) &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 1 &&
      typeof value.processStart === "string" &&
      value.processStart.length > 0 &&
      value.runtimePath === expectedRuntimePath &&
      typeof value.createdAt === "string" &&
      Number.isFinite(Date.parse(value.createdAt)),
  );
}

export function createServerProcessState({
  phase,
  pid,
  processStart,
  runtimePath,
  createdAt = new Date().toISOString(),
}) {
  const state = {
    version: SERVER_PROCESS_STATE_VERSION,
    phase,
    pid,
    processStart,
    runtimePath,
    createdAt,
  };
  if (!isServerProcessState(state, runtimePath)) {
    throw new TypeError("서버 프로세스 상태 정보가 올바르지 않아요.");
  }
  return state;
}

export function isWithinStartingGrace(state, now = Date.now()) {
  if (!Number.isFinite(now)) {
    throw new TypeError("현재 시각이 올바르지 않아요.");
  }
  return (
    state.phase === "starting" &&
    now - Date.parse(state.createdAt) <= SERVER_STARTING_GRACE_MS
  );
}
