import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

const RUNNER_PATH = fileURLToPath(
  new URL("./operation-child.mjs", import.meta.url),
);

export function operationChildInvocation(
  command,
  args,
  { leases, commandLease, environment = process.env } = {},
) {
  if (typeof command !== "string" || command.length === 0) {
    throw new TypeError("중첩 명령의 실행 파일이 올바르지 않아요.");
  }
  if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) {
    throw new TypeError("중첩 명령의 인자가 올바르지 않아요.");
  }
  if (
    !Array.isArray(leases) ||
    leases.length === 0 ||
    leases.some(
      (lease) =>
        !lease ||
        typeof lease !== "object" ||
        typeof lease.root !== "string" ||
        lease.root.length === 0 ||
        typeof lease.token !== "string" ||
        lease.token.length === 0,
    )
  ) {
    throw new TypeError("중첩 명령의 작업 lease가 올바르지 않아요.");
  }
  if (
    commandLease !== undefined &&
    (!commandLease ||
      typeof commandLease !== "object" ||
      typeof commandLease.root !== "string" ||
      commandLease.root.length === 0 ||
      typeof commandLease.token !== "string" ||
      commandLease.token.length === 0)
  ) {
    throw new TypeError("실제 명령이 사용할 작업 lease가 올바르지 않아요.");
  }

  const normalizedLeases = leases.map((lease) => ({
    root: path.resolve(lease.root),
    token: lease.token,
  }));
  const normalizedCommandLease = commandLease
    ? {
        root: path.resolve(commandLease.root),
        token: commandLease.token,
      }
    : normalizedLeases[0];
  const commandLeaseIndex = normalizedLeases.findIndex(
    (lease) =>
      lease.root === normalizedCommandLease.root &&
      lease.token === normalizedCommandLease.token,
  );
  if (commandLeaseIndex === -1) {
    throw new TypeError("실제 명령이 사용할 작업 lease가 목록에 없어요.");
  }

  const [firstLease, ...remainingLeases] = normalizedLeases;
  const childEnvironment = {
    ...environment,
    RIFF_OPERATION_PARENT_TOKEN: firstLease.token,
    RIFF_OPERATION_ROOT: firstLease.root,
    RIFF_OPERATION_COMMAND_LEASE_INDEX: String(commandLeaseIndex),
  };
  delete childEnvironment.RIFF_OPERATION_COMMAND_PARENT_TOKEN;
  delete childEnvironment.RIFF_OPERATION_COMMAND_ROOT;
  if (remainingLeases.length > 0) {
    childEnvironment.RIFF_OPERATION_CHAIN = JSON.stringify(remainingLeases);
  } else {
    delete childEnvironment.RIFF_OPERATION_CHAIN;
  }

  return {
    command: process.execPath,
    args: [RUNNER_PATH, command, ...args],
    environment: childEnvironment,
  };
}
