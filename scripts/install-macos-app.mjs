import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { acquireOperationLock } from "./operation-lock.mjs";
import { operationChildInvocation } from "./operation-child-invocation.mjs";
import {
  inspectProcessIdentity,
  PROCESS_IDENTITY_STATUS,
} from "./process-identity.mjs";
import { assertNoIncompleteRestoreState } from "./restore-state.mjs";
import {
  isServerProcessState,
  isWithinStartingGrace,
} from "./server-process-state.mjs";

const BUNDLE_ID = "com.joriih.riff-sketchbook.launcher";
const PACKAGED_APP_PORT = 43_117;
const RUNTIME_MARKER_KIND = "riff-sketchbook-local-runtime";
const SWIFT_SOURCE_ROOT = "/RiffSketchbookSource";
const INSTALL_UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const APP_TRANSIENT_PATTERN = new RegExp(
  `^\\.Riff Sketchbook\\.app\\.(install|previous)-[1-9][0-9]*-${INSTALL_UUID_PATTERN}$`,
);
const RUNTIME_TRANSIENT_PATTERN = new RegExp(
  `^\\.runtime\\.(install|previous)-[1-9][0-9]*-${INSTALL_UUID_PATTERN}$`,
);
const PROJECT_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const APPLICATIONS_DIRECTORY = path.join(os.homedir(), "Applications");
const APP_PATH = path.join(APPLICATIONS_DIRECTORY, "Riff Sketchbook.app");
const SUPPORT_DIRECTORY = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Riff Sketchbook",
);
const RUNTIME_PATH = path.join(SUPPORT_DIRECTORY, "runtime");
const RUNTIME_COMMAND = path.join(RUNTIME_PATH, "Run Riff Sketchbook.command");
const SERVER_STATE_PATH = path.join(SUPPORT_DIRECTORY, "server-process.json");
const INSTALL_ID = randomUUID();
const TEMP_APP_PATH = path.join(
  APPLICATIONS_DIRECTORY,
  `.Riff Sketchbook.app.install-${process.pid}-${INSTALL_ID}`,
);
const BACKUP_APP_PATH = path.join(
  APPLICATIONS_DIRECTORY,
  `.Riff Sketchbook.app.previous-${process.pid}-${INSTALL_ID}`,
);
const TEMP_RUNTIME_PATH = path.join(
  SUPPORT_DIRECTORY,
  `.runtime.install-${process.pid}-${INSTALL_ID}`,
);
const BACKUP_RUNTIME_PATH = path.join(
  SUPPORT_DIRECTORY,
  `.runtime.previous-${process.pid}-${INSTALL_ID}`,
);
const RUNTIME_DIRECTORIES = ["app", "components", "lib", "public", "scripts", "types"];
const RUNTIME_FILES = [
  "next-env.d.ts",
  "next.config.ts",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "README.md",
  "LOCAL-RUNBOOK.md",
];

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function pathStatOrNull(targetPath) {
  return lstat(targetPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
}

async function assertOwnedDirectory(targetPath) {
  const targetStat = await lstat(targetPath);
  if (
    !targetStat.isDirectory() ||
    targetStat.isSymbolicLink() ||
    (typeof process.getuid === "function" && targetStat.uid !== process.getuid())
  ) {
    throw new Error(`안전하지 않은 설치 잔여 폴더가 있어 자동으로 처리하지 않았어요: ${targetPath}`);
  }
}

async function listTransientDirectories(directory, pattern) {
  const matches = { install: [], previous: [] };
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const match = pattern.exec(entry.name);
    if (!match) continue;
    const targetPath = path.join(directory, entry.name);
    await assertOwnedDirectory(targetPath);
    matches[match[1]].push(targetPath);
  }
  matches.install.sort();
  matches.previous.sort();
  return matches;
}

async function copyEntry(source, destination, filter) {
  const sourceStat = await lstat(source);
  if (sourceStat.isSymbolicLink() && !source.includes(`${path.sep}node_modules${path.sep}`)) {
    throw new Error(`안전하지 않은 심볼릭 링크는 설치하지 않았어요: ${source}`);
  }
  await cp(source, destination, {
    recursive: sourceStat.isDirectory(),
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
    // Preserve npm/Next's relative links. Resolving them while copying would
    // turn them into absolute links back to the source checkout.
    verbatimSymlinks: true,
    filter,
  });
}

export async function assertRuntimeSymlinksStayInside(runtimeRoot) {
  const absoluteRoot = path.resolve(runtimeRoot);

  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const entryStat = await lstat(entryPath);
      if (entryStat.isSymbolicLink()) {
        const linkTarget = await readlink(entryPath);
        const resolvedTarget = path.resolve(directory, linkTarget);
        const relativeTarget = path.relative(absoluteRoot, resolvedTarget);
        if (
          relativeTarget === ".." ||
          relativeTarget.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relativeTarget)
        ) {
          throw new Error(`실행 폴더 밖을 가리키는 링크가 있어요: ${entryPath}`);
        }
        continue;
      }
      if (entryStat.isDirectory()) await visit(entryPath);
    }
  }

  await visit(absoluteRoot);
}

function infoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>ko</string>
  <key>CFBundleDisplayName</key>
  <string>Riff Sketchbook</string>
  <key>CFBundleExecutable</key>
  <string>Riff Sketchbook</string>
  <key>CFBundleIdentifier</key>
  <string>${BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Riff Sketchbook</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;
}

function runtimeLauncherScript() {
  const bundledNode = path.join(RUNTIME_PATH, ".runtime-node", "bin", "node");
  return `#!/bin/zsh
set -e

APP_DIRECTORY=${shellQuote(RUNTIME_PATH)}
BUNDLED_NODE=${shellQuote(bundledNode)}

if [[ ! -x "$BUNDLED_NODE" ]]; then
  print -u2 "설치된 Node 실행 파일을 찾을 수 없어요. 원본 프로젝트의 설치기를 다시 실행해 주세요."
  exit 1
fi

cd "$APP_DIRECTORY"
export PATH="$APP_DIRECTORY/.runtime-node/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export RIFF_OPEN_BROWSER=1
export RIFF_PACKAGED_APP=1
export RIFF_INSTALL_LOCK_ROOT=${shellQuote(SUPPORT_DIRECTORY)}
export RIFF_LOCAL_APP_PORT=${String(PACKAGED_APP_PORT)}
export RIFF_SERVER_STATE_PATH=${shellQuote(SERVER_STATE_PATH)}
export APP_ORIGIN=http://127.0.0.1:${String(PACKAGED_APP_PORT)}
exec "$BUNDLED_NODE" "$APP_DIRECTORY/scripts/start-app.mjs"
`;
}

async function runBuild(sourceLeaseToken) {
  const nextBinary = path.join(
    PROJECT_DIRECTORY,
    "node_modules",
    "next",
    "dist",
    "bin",
    "next",
  );
  console.log("독립 실행용 앱을 준비하고 있어요…");
  await new Promise((resolve, reject) => {
    const invocation = operationChildInvocation(
      process.execPath,
      [nextBinary, "build"],
      {
        leases: [{ root: PROJECT_DIRECTORY, token: sourceLeaseToken }],
        environment: process.env,
      },
    );
    const child = spawn(invocation.command, invocation.args, {
      cwd: PROJECT_DIRECTORY,
      env: invocation.environment,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`앱 빌드에 실패했어요 (${signal ?? code}).`));
    });
  });
}

async function assertInstallPrerequisites() {
  if (process.platform !== "darwin") {
    throw new Error("이 설치기는 macOS에서만 사용할 수 있어요.");
  }
  await access(
    path.join(PROJECT_DIRECTORY, "node_modules", "next", "dist", "bin", "next"),
    fsConstants.R_OK,
  ).catch(() => {
    throw new Error("앱 패키지가 설치되지 않았어요. 프로젝트 폴더에서 npm ci를 먼저 실행해 주세요.");
  });
  await access(
    "/Applications/Postgres.app/Contents/Versions/latest/bin/pg_isready",
    fsConstants.X_OK,
  ).catch(() => {
    throw new Error("Postgres.app을 Applications 폴더에서 찾을 수 없어요.");
  });
  await access("/usr/bin/swiftc", fsConstants.X_OK).catch(() => {
    throw new Error(
      "Mac 앱 시작 화면을 만들 도구가 없어요. 먼저 Apple Command Line Tools를 설치해 주세요.",
    );
  });
}

async function appIsManagedAt(targetPath) {
  const targetStat = await pathStatOrNull(targetPath);
  if (!targetStat) return false;
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    throw new Error(`${targetPath}에 다른 파일이 있어 자동으로 바꾸지 않았어요.`);
  }
  const [plist, marker] = await Promise.all([
    readFile(path.join(targetPath, "Contents", "Info.plist"), "utf8").catch(() => ""),
    readFile(
      path.join(targetPath, "Contents", "Resources", "riff-sketchbook-project.txt"),
      "utf8",
    ).catch(() => ""),
  ]);
  if (!plist.includes(BUNDLE_ID) || marker.trim().length === 0) {
    throw new Error(`${targetPath}은 이 설치기가 만든 앱이 아니어서 바꾸지 않았어요.`);
  }
  return true;
}

async function runtimeIsManagedAt(targetPath) {
  const runtimeStat = await pathStatOrNull(targetPath);
  if (!runtimeStat) return false;
  if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink()) {
    throw new Error(`${targetPath}에 안전하지 않은 파일이 있어 자동으로 바꾸지 않았어요.`);
  }
  const marker = await readFile(
    path.join(targetPath, ".riff-sketchbook-runtime.json"),
    "utf8",
  ).catch(() => "");
  let parsed;
  try {
    parsed = JSON.parse(marker);
  } catch {
    parsed = null;
  }
  if (parsed?.kind !== RUNTIME_MARKER_KIND) {
    throw new Error(`${targetPath}은 이 설치기가 만든 실행 폴더가 아니어서 바꾸지 않았어요.`);
  }
  return true;
}

async function recoverInterruptedTarget({
  targetPath,
  transientDirectory,
  transientPattern,
  isManagedAt,
}) {
  const leftovers = await listTransientDirectories(
    transientDirectory,
    transientPattern,
  );
  const targetExists = Boolean(await pathStatOrNull(targetPath));

  if (!targetExists && leftovers.previous.length > 1) {
    throw new Error(
      `${targetPath}의 복구 후보가 여러 개라 자동으로 선택하지 않았어요. LOCAL-RUNBOOK.md를 확인해 주세요.`,
    );
  }
  if (!targetExists && leftovers.previous.length === 1) {
    const backupPath = leftovers.previous[0];
    await isManagedAt(backupPath);
    await rename(backupPath, targetPath);
    leftovers.previous.length = 0;
  }

  if (await pathStatOrNull(targetPath)) {
    await isManagedAt(targetPath);
    for (const backupPath of leftovers.previous) {
      await isManagedAt(backupPath);
      await rm(backupPath, { recursive: true });
    }
  }
  for (const installPath of leftovers.install) {
    await rm(installPath, { recursive: true });
  }
}

async function recoverInterruptedInstall() {
  await recoverInterruptedTarget({
    targetPath: RUNTIME_PATH,
    transientDirectory: SUPPORT_DIRECTORY,
    transientPattern: RUNTIME_TRANSIENT_PATTERN,
    isManagedAt: runtimeIsManagedAt,
  });
  await recoverInterruptedTarget({
    targetPath: APP_PATH,
    transientDirectory: APPLICATIONS_DIRECTORY,
    transientPattern: APP_TRANSIENT_PATTERN,
    isManagedAt: appIsManagedAt,
  });
}

async function localRiffStatus(port) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 750);
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/api/auth/status`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const value = await response.json();
    return Boolean(
      value &&
      typeof value === "object" &&
      typeof value.configured === "boolean" &&
      typeof value.authenticated === "boolean" &&
      "user" in value,
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function assertRiffSketchbookStopped() {
  const serverStateStat = await pathStatOrNull(SERVER_STATE_PATH);
  if (serverStateStat) {
    if (!serverStateStat.isFile() || serverStateStat.isSymbolicLink()) {
      throw new Error("설치 앱의 서버 상태 파일이 안전하지 않아 설치를 중단했어요.");
    }
    let state;
    try {
      state = JSON.parse(await readFile(SERVER_STATE_PATH, "utf8"));
    } catch {
      throw new Error("설치 앱의 서버 상태 파일이 손상돼 설치를 중단했어요.");
    }
    if (!isServerProcessState(state, RUNTIME_PATH)) {
      throw new Error("설치 앱의 서버 상태 파일 내용이 올바르지 않아요.");
    }
    const identityStatus = await inspectProcessIdentity(
      state.pid,
      state.processStart,
    );
    if (identityStatus === PROCESS_IDENTITY_STATUS.INDETERMINATE) {
      throw new Error(
        "Riff Sketchbook 서버 상태를 안전하게 확인할 수 없어 설치를 중단했어요. Mac을 재시작한 뒤 다시 시도해 주세요.",
      );
    }
    if (identityStatus === PROCESS_IDENTITY_STATUS.LIVE) {
      throw new Error(
        "Riff Sketchbook 서버가 아직 실행 중이에요. 앱 창에서 종료한 뒤 설치기를 다시 실행해 주세요.",
      );
    }
    if (isWithinStartingGrace(state)) {
      throw new Error(
        "Riff Sketchbook 서버가 시작 중이었어요. 잠시 기다린 뒤 설치기를 다시 실행해 주세요.",
      );
    }
    await rm(SERVER_STATE_PATH, { force: true });
  }
  if (
    (await localRiffStatus(PACKAGED_APP_PORT)) ||
    (await localRiffStatus(3_000))
  ) {
    throw new Error(
      "Riff Sketchbook이 실행 중이에요. 앱 창에서 서버를 종료한 뒤 설치기를 다시 실행해 주세요.",
    );
  }
}

function buildFilter(sourcePath) {
  const relative = path.relative(path.join(PROJECT_DIRECTORY, ".next"), sourcePath);
  if (!relative || relative.startsWith("..")) return true;
  const topLevel = relative.split(path.sep)[0];
  return topLevel !== "cache" && topLevel !== "dev";
}

function storageFilter(storageRoot, sourcePath) {
  const relative = path.relative(storageRoot, sourcePath);
  if (!relative) return true;
  const topLevel = relative.split(path.sep)[0];
  if (topLevel === ".operation-lock" || topLevel === "e2e") return false;
  return !topLevel.startsWith(".restore-") && !topLevel.startsWith(".operation-");
}

function assertOwnedRegularEntry(targetPath, targetStat, expectedKind) {
  const isExpectedKind =
    expectedKind === "directory"
      ? targetStat.isDirectory()
      : targetStat.isFile();
  if (
    !isExpectedKind ||
    targetStat.isSymbolicLink() ||
    (typeof process.getuid === "function" && targetStat.uid !== process.getuid())
  ) {
    throw new Error(
      `개인 참고자료에 안전하지 않은 ${expectedKind === "directory" ? "폴더" : "파일"}이 있어 설치를 중단했어요: ${targetPath}`,
    );
  }
}

async function readOwnedRegularFile(targetPath) {
  const pathStat = await lstat(targetPath);
  assertOwnedRegularEntry(targetPath, pathStat, "file");

  const handle = await open(
    targetPath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const openedStat = await handle.stat();
    assertOwnedRegularEntry(targetPath, openedStat, "file");
    if (openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
      throw new Error(`개인 참고자료 파일이 확인 중 바뀌어 설치를 중단했어요: ${targetPath}`);
    }
    return {
      contents: await handle.readFile(),
      mode: pathStat.mode & 0o777,
    };
  } finally {
    await handle.close();
  }
}

async function ensureOwnedDirectory(targetPath, sourceMode = 0o700) {
  const existingStat = await pathStatOrNull(targetPath);
  if (existingStat) {
    assertOwnedRegularEntry(targetPath, existingStat, "directory");
    return false;
  }

  try {
    await mkdir(targetPath, { mode: sourceMode & 0o777 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const createdStat = await lstat(targetPath);
  assertOwnedRegularEntry(targetPath, createdStat, "directory");
  return true;
}

export async function mergeOwnedDirectoryAdditively(sourceRoot, destinationRoot) {
  const sourceRootStat = await pathStatOrNull(sourceRoot);
  if (!sourceRootStat) return { addedFiles: 0, identicalFiles: 0 };
  assertOwnedRegularEntry(sourceRoot, sourceRootStat, "directory");

  const destinationParent = path.dirname(destinationRoot);
  const destinationParentStat = await lstat(destinationParent);
  assertOwnedRegularEntry(destinationParent, destinationParentStat, "directory");
  await ensureOwnedDirectory(destinationRoot, sourceRootStat.mode);

  let addedFiles = 0;
  let identicalFiles = 0;

  async function mergeDirectory(sourceDirectory, destinationDirectory) {
    const entries = await readdir(sourceDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));

    for (const entry of entries) {
      const sourcePath = path.join(sourceDirectory, entry.name);
      const destinationPath = path.join(destinationDirectory, entry.name);
      const sourceStat = await lstat(sourcePath);

      if (sourceStat.isDirectory() && !sourceStat.isSymbolicLink()) {
        assertOwnedRegularEntry(sourcePath, sourceStat, "directory");
        await ensureOwnedDirectory(destinationPath, sourceStat.mode);
        await mergeDirectory(sourcePath, destinationPath);
        continue;
      }

      assertOwnedRegularEntry(sourcePath, sourceStat, "file");
      const sourceFile = await readOwnedRegularFile(sourcePath);
      const destinationStat = await pathStatOrNull(destinationPath);
      if (!destinationStat) {
        try {
          await writeFile(destinationPath, sourceFile.contents, {
            flag: "wx",
            mode: sourceFile.mode,
          });
          addedFiles += 1;
          continue;
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
        }
      }

      const destinationFile = await readOwnedRegularFile(destinationPath);
      if (!sourceFile.contents.equals(destinationFile.contents)) {
        throw new Error(
          `기존 개인 참고자료와 내용이 다른 파일이 있어 덮어쓰지 않았어요: ${path.relative(destinationRoot, destinationPath)}`,
        );
      }
      identicalFiles += 1;
    }
  }

  await mergeDirectory(sourceRoot, destinationRoot);
  return { addedFiles, identicalFiles };
}

async function copyMutableData(dataSourceRoot) {
  const envSource = path.join(dataSourceRoot, ".env.local");
  await copyEntry(envSource, path.join(TEMP_RUNTIME_PATH, ".env.local"));

  const storageSource = path.join(dataSourceRoot, "storage");
  if (await pathStatOrNull(storageSource)) {
    await copyEntry(
      storageSource,
      path.join(TEMP_RUNTIME_PATH, "storage"),
      (sourcePath) => storageFilter(storageSource, sourcePath),
    );
  } else {
    await mkdir(path.join(TEMP_RUNTIME_PATH, "storage", "audio"), {
      recursive: true,
      mode: 0o700,
    });
  }

  const backupsSource = path.join(dataSourceRoot, "backups");
  if (await pathStatOrNull(backupsSource)) {
    await copyEntry(backupsSource, path.join(TEMP_RUNTIME_PATH, "backups"));
  }
}

async function createRuntime(replacingExistingRuntime) {
  await mkdir(TEMP_RUNTIME_PATH, { recursive: true, mode: 0o700 });
  for (const directory of RUNTIME_DIRECTORIES) {
    await copyEntry(
      path.join(PROJECT_DIRECTORY, directory),
      path.join(TEMP_RUNTIME_PATH, directory),
    );
  }
  for (const fileName of RUNTIME_FILES) {
    await copyEntry(
      path.join(PROJECT_DIRECTORY, fileName),
      path.join(TEMP_RUNTIME_PATH, fileName),
    );
  }
  await copyEntry(
    path.join(PROJECT_DIRECTORY, ".next"),
    path.join(TEMP_RUNTIME_PATH, ".next"),
    buildFilter,
  );
  await rewriteBuildPaths(path.join(TEMP_RUNTIME_PATH, ".next"));
  await copyEntry(
    path.join(PROJECT_DIRECTORY, "node_modules"),
    path.join(TEMP_RUNTIME_PATH, "node_modules"),
  );

  const nodeDirectory = path.join(TEMP_RUNTIME_PATH, ".runtime-node");
  await mkdir(path.join(nodeDirectory, "bin"), { recursive: true, mode: 0o755 });
  await copyEntry(process.execPath, path.join(nodeDirectory, "bin", "node"));
  await chmod(path.join(nodeDirectory, "bin", "node"), 0o755);
  const nodeLicense = path.resolve(path.dirname(process.execPath), "..", "LICENSE");
  if (await pathStatOrNull(nodeLicense)) {
    await copyEntry(nodeLicense, path.join(nodeDirectory, "LICENSE"));
  }

  await copyMutableData(replacingExistingRuntime ? RUNTIME_PATH : PROJECT_DIRECTORY);
  await mergeOwnedDirectoryAdditively(
    path.join(PROJECT_DIRECTORY, "storage", "reference-library"),
    path.join(TEMP_RUNTIME_PATH, "storage", "reference-library"),
  );
  await assertRuntimeSymlinksStayInside(TEMP_RUNTIME_PATH);
  await writeFile(RUNTIME_COMMAND.replace(RUNTIME_PATH, TEMP_RUNTIME_PATH), runtimeLauncherScript(), {
    mode: 0o755,
  });
  await chmod(RUNTIME_COMMAND.replace(RUNTIME_PATH, TEMP_RUNTIME_PATH), 0o755);
  await writeFile(
    path.join(TEMP_RUNTIME_PATH, ".riff-sketchbook-runtime.json"),
    `${JSON.stringify({
      kind: RUNTIME_MARKER_KIND,
      installedAt: new Date().toISOString(),
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

async function rewriteBuildPaths(nextDirectory) {
  const sourceBytes = Buffer.from(PROJECT_DIRECTORY);

  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const linkTarget = await readlink(entryPath);
        const resolvedTarget = path.resolve(directory, linkTarget);
        const relativeTarget = path.relative(TEMP_RUNTIME_PATH, resolvedTarget);
        if (
          !relativeTarget ||
          relativeTarget === ".." ||
          relativeTarget.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relativeTarget)
        ) {
          throw new Error(`빌드에 실행 폴더 밖을 가리키는 링크가 있어요: ${entryPath}`);
        }
        continue;
      }
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const contents = await readFile(entryPath);
      if (!contents.includes(sourceBytes)) continue;
      if (contents.includes(0)) {
        throw new Error(`빌드의 이진 파일에 원본 경로가 남아 설치를 중단했어요: ${entryPath}`);
      }
      await writeFile(
        entryPath,
        contents.toString("utf8").replaceAll(PROJECT_DIRECTORY, RUNTIME_PATH),
      );
    }
  }

  await visit(nextDirectory);
}

async function createBundle(installLeaseToken) {
  await mkdir(path.join(TEMP_APP_PATH, "Contents", "MacOS"), {
    recursive: true,
    mode: 0o755,
  });
  await mkdir(path.join(TEMP_APP_PATH, "Contents", "Resources"), {
    recursive: true,
    mode: 0o755,
  });
  await Promise.all([
    writeFile(path.join(TEMP_APP_PATH, "Contents", "Info.plist"), infoPlist(), {
      mode: 0o644,
    }),
    writeFile(
      path.join(
        TEMP_APP_PATH,
        "Contents",
        "Resources",
        "riff-sketchbook-project.txt",
      ),
      `${RUNTIME_PATH}\n`,
      { mode: 0o600 },
    ),
  ]);
  const executablePath = path.join(
    TEMP_APP_PATH,
    "Contents",
    "MacOS",
    "Riff Sketchbook",
  );
  const swiftTarget = `${process.arch === "x64" ? "x86_64" : "arm64"}-apple-macosx13.0`;
  const swiftSourcePrefixMap = `${PROJECT_DIRECTORY}=${SWIFT_SOURCE_ROOT}`;
  await new Promise((resolve, reject) => {
    const invocation = operationChildInvocation(
      "/usr/bin/swiftc",
      [
        path.join(PROJECT_DIRECTORY, "scripts", "macos-launcher.swift"),
        "-target",
        swiftTarget,
        "-O",
        "-warnings-as-errors",
        "-debug-prefix-map",
        swiftSourcePrefixMap,
        "-file-prefix-map",
        swiftSourcePrefixMap,
        "-framework",
        "AppKit",
        "-o",
        executablePath,
      ],
      {
        leases: [{ root: SUPPORT_DIRECTORY, token: installLeaseToken }],
        environment: process.env,
      },
    );
    const child = spawn(invocation.command, invocation.args, {
      cwd: PROJECT_DIRECTORY,
      env: invocation.environment,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Mac 시작 화면을 만들지 못했어요 (${signal ?? code}).`));
    });
  });
  const executableContents = await readFile(executablePath);
  if (executableContents.includes(Buffer.from(PROJECT_DIRECTORY))) {
    throw new Error("Mac 앱 실행 파일에 원본 프로젝트 경로가 남아 설치를 중단했어요.");
  }
  await chmod(executablePath, 0o755);
}

async function swapManagedDirectory(target, replacement, backup, replacingExisting) {
  if (replacingExisting) await rename(target, backup);
  try {
    await rename(replacement, target);
  } catch (error) {
    if (replacingExisting) {
      try {
        await rename(backup, target);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `${target} 교체와 원래 버전 복구가 모두 실패했어요. 백업은 삭제하지 않았습니다.`,
        );
      }
    }
    throw error;
  }
}

async function rollbackManagedDirectory(
  target,
  backup,
  displaced,
  replacingExisting,
) {
  if (!replacingExisting) {
    await rm(target, { recursive: true, force: true });
    return;
  }

  const targetExists = Boolean(await pathStatOrNull(target));
  if (targetExists) await rename(target, displaced);
  try {
    await rename(backup, target);
  } catch (error) {
    if (targetExists) {
      try {
        await rename(displaced, target);
      } catch (restoreNewError) {
        throw new AggregateError(
          [error, restoreNewError],
          `${target}의 이전 버전과 새 버전을 모두 복구하지 못했어요. 파일은 삭제하지 않았습니다.`,
        );
      }
    }
    throw error;
  }
  if (targetExists) await rm(displaced, { recursive: true, force: true });
}

async function install() {
  await assertInstallPrerequisites();
  await mkdir(APPLICATIONS_DIRECTORY, { recursive: true, mode: 0o755 });
  await mkdir(SUPPORT_DIRECTORY, { recursive: true, mode: 0o700 });

  const installLease = await acquireOperationLock("doctor", { root: SUPPORT_DIRECTORY });
  let sourceLease = null;
  try {
    await assertRiffSketchbookStopped();
    await recoverInterruptedInstall();
    const replacingExistingApp = await appIsManagedAt(APP_PATH);
    const replacingExistingRuntime = await runtimeIsManagedAt(RUNTIME_PATH);
    sourceLease = await acquireOperationLock("doctor", { root: PROJECT_DIRECTORY });
    await assertNoIncompleteRestoreState(
      replacingExistingRuntime ? RUNTIME_PATH : PROJECT_DIRECTORY,
    );
    await runBuild(sourceLease.token);
    await createRuntime(replacingExistingRuntime);
    await createBundle(installLease.token);
    await assertRiffSketchbookStopped();

    await swapManagedDirectory(
      RUNTIME_PATH,
      TEMP_RUNTIME_PATH,
      BACKUP_RUNTIME_PATH,
      replacingExistingRuntime,
    );
    try {
      await swapManagedDirectory(
        APP_PATH,
        TEMP_APP_PATH,
        BACKUP_APP_PATH,
        replacingExistingApp,
      );
    } catch (error) {
      try {
        await rollbackManagedDirectory(
          RUNTIME_PATH,
          BACKUP_RUNTIME_PATH,
          TEMP_RUNTIME_PATH,
          replacingExistingRuntime,
        );
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "앱 설치와 실행 파일 복구가 모두 실패했어요. 남은 백업은 삭제하지 않았습니다.",
        );
      }
      throw error;
    }

    await Promise.all([
      rm(BACKUP_APP_PATH, { recursive: true, force: true }),
      rm(BACKUP_RUNTIME_PATH, { recursive: true, force: true }),
    ]);
  } finally {
    try {
      await sourceLease?.release();
    } finally {
      await installLease.release();
    }
  }

  console.log(`설치 완료: ${APP_PATH}`);
  console.log(`독립 실행 파일: ${RUNTIME_PATH}`);
  console.log("이제 Finder의 응용 프로그램에서 Riff Sketchbook을 더블클릭하세요.");
  console.log("앱을 끝낼 때는 시작 창의 ‘서버 종료’를 누르거나 앱을 종료하세요.");
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await install();
  } finally {
    const recoveryArtifactExists = Boolean(
      (await pathStatOrNull(BACKUP_APP_PATH)) ||
      (await pathStatOrNull(BACKUP_RUNTIME_PATH)),
    );
    if (recoveryArtifactExists) {
      console.error(
        "복구에 필요한 설치 백업을 보존했습니다. 삭제하지 말고 LOCAL-RUNBOOK.md를 확인해 주세요.",
      );
    } else {
      await Promise.all([
        rm(TEMP_APP_PATH, { recursive: true, force: true }),
        rm(TEMP_RUNTIME_PATH, { recursive: true, force: true }),
      ]);
    }
  }
}
