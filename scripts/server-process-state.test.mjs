import assert from "node:assert/strict";
import test from "node:test";

import {
  createServerProcessState,
  isServerProcessState,
  isWithinStartingGrace,
  SERVER_PROCESS_STATE_VERSION,
  SERVER_STARTING_GRACE_MS,
} from "./server-process-state.mjs";

const RUNTIME_PATH = "/Users/test/Library/Application Support/Riff Sketchbook/runtime";
const CREATED_AT = "2026-08-27T03:00:00.000Z";

function state(overrides = {}) {
  return createServerProcessState({
    phase: "running",
    pid: 42,
    processStart: "Wed Aug 27 12:00:00 2026",
    runtimePath: RUNTIME_PATH,
    createdAt: CREATED_AT,
    ...overrides,
  });
}

test("server state records its phase and exact process identity", () => {
  const value = state();
  assert.equal(value.version, SERVER_PROCESS_STATE_VERSION);
  assert.equal(value.phase, "running");
  assert.equal(value.pid, 42);
  assert.equal(value.processStart, "Wed Aug 27 12:00:00 2026");
  assert.equal(isServerProcessState(value, RUNTIME_PATH), true);
  assert.equal(isServerProcessState({ ...value, processStart: "" }, RUNTIME_PATH), false);
  assert.equal(
    isServerProcessState(value, `${RUNTIME_PATH}-different`),
    false,
  );
});

test("a stale starting intent remains fail-closed only for the startup grace", () => {
  const value = state({ phase: "starting" });
  const createdAt = Date.parse(CREATED_AT);
  assert.equal(isWithinStartingGrace(value, createdAt), true);
  assert.equal(
    isWithinStartingGrace(value, createdAt + SERVER_STARTING_GRACE_MS),
    true,
  );
  assert.equal(
    isWithinStartingGrace(value, createdAt + SERVER_STARTING_GRACE_MS + 1),
    false,
  );
  assert.equal(isWithinStartingGrace(state(), createdAt), false);
});
