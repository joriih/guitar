import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertRuntimeSymlinksStayInside,
  mergeOwnedDirectoryAdditively,
} from "./install-macos-app.mjs";

const projectDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function projectFile(...segments) {
  return readFile(path.join(projectDirectory, ...segments), "utf8");
}

test("the macOS launcher opens only its independent local runtime", async () => {
  const [installer, launcher, runbook, startApp] = await Promise.all([
    projectFile("scripts", "install-macos-app.mjs"),
    projectFile("Install Riff Sketchbook App.command"),
    projectFile("LOCAL-RUNBOOK.md"),
    projectFile("scripts", "start-app.mjs"),
  ]);

  assert.match(installer, /path\.join\(os\.homedir\(\), "Applications"\)/);
  assert.match(installer, /"Application Support",\s*"Riff Sketchbook"/);
  assert.match(installer, /RUNTIME_COMMAND = path\.join\(RUNTIME_PATH, "Run Riff Sketchbook\.command"\)/);
  assert.match(installer, /scripts", "macos-launcher\.swift"/);
  assert.match(installer, /"\/usr\/bin\/swiftc"/);
  assert.match(installer, /"-framework",\s*"AppKit"/);
  assert.match(installer, /const SWIFT_SOURCE_ROOT = "\/RiffSketchbookSource"/);
  assert.match(installer, /"-debug-prefix-map",\s*swiftSourcePrefixMap/);
  assert.match(installer, /"-file-prefix-map",\s*swiftSourcePrefixMap/);
  assert.match(installer, /executableContents\.includes\(Buffer\.from\(PROJECT_DIRECTORY\)\)/);
  assert.match(installer, /const bundledNode = path\.join\(RUNTIME_PATH, "\.runtime-node", "bin", "node"\)/);
  assert.match(installer, /BUNDLED_NODE=\$\{shellQuote\(bundledNode\)\}/);
  assert.match(installer, /export RIFF_PACKAGED_APP=1/);
  assert.match(installer, /export RIFF_INSTALL_LOCK_ROOT=\$\{shellQuote\(SUPPORT_DIRECTORY\)\}/);
  assert.match(installer, /const PACKAGED_APP_PORT = 43_117/);
  assert.match(installer, /export RIFF_LOCAL_APP_PORT=\$\{String\(PACKAGED_APP_PORT\)\}/);
  assert.match(installer, /export RIFF_SERVER_STATE_PATH=\$\{shellQuote\(SERVER_STATE_PATH\)\}/);
  assert.match(installer, /export APP_ORIGIN=http:\/\/127\.0\.0\.1:\$\{String\(PACKAGED_APP_PORT\)\}/);
  assert.match(installer, /\/Applications\/Postgres\.app\/Contents\/Versions\/latest\/bin\/pg_isready/);
  assert.doesNotMatch(installer, /trycloudflare|RIFF_REMOTE_ACCESS/);
  assert.match(launcher, /node scripts\/install-macos-app\.mjs/);
  assert.match(runbook, /http:\/\/127\.0\.0\.1:43117/);
  assert.match(runbook, /Codex나\s+Python은 실행에 관여하지 않습니다/);
  assert.match(runbook, /Application Support\/Riff Sketchbook\/runtime/);
  assert.match(startApp, /process\.env\.RIFF_PACKAGED_APP === "1"/);
  assert.match(startApp, /process\.env\.RIFF_LOCAL_APP_PORT/);
  assert.match(startApp, /process\.env\.RIFF_SERVER_STATE_PATH/);
  assert.match(startApp, /writeStartingServerState\(\)/);
  assert.match(startApp, /writeRunningServerState\(child\)/);
  assert.match(startApp, /readProcessStartSignature\(child\.pid/);
  assert.match(startApp, /clearServerState\(runningState\)/);
  assert.match(startApp, /PROCESS_IDENTITY_STATUS\.INDETERMINATE/);
  assert.match(startApp, /isWithinStartingGrace\(state\)/);
  assert.match(startApp, /if \(!fileStat\.isDirectory\(\) \|\| fileStat\.isSymbolicLink\(\)\) return fileStat\.mtimeMs/);
  assert.match(startApp, /Directory mtimes are not\s*\n\s*\/\/ build inputs/);
});

test("launcher replacement is managed, atomic, and rollback-safe", async () => {
  const [installer, startApp] = await Promise.all([
    projectFile("scripts", "install-macos-app.mjs"),
    projectFile("scripts", "start-app.mjs"),
  ]);

  assert.match(installer, /targetStat\.isSymbolicLink\(\)/);
  assert.match(installer, /plist\.includes\(BUNDLE_ID\)/);
  assert.match(installer, /riff-sketchbook-project\.txt/);
  assert.match(installer, /parsed\?\.kind !== RUNTIME_MARKER_KIND/);
  assert.match(installer, /acquireOperationLock\("doctor", \{ root: PROJECT_DIRECTORY \}\)/);
  assert.match(installer, /acquireOperationLock\("doctor", \{ root: SUPPORT_DIRECTORY \}\)/);
  assert.match(installer, /recoverInterruptedInstall\(\)/);
  assert.match(installer, /RUNTIME_TRANSIENT_PATTERN/);
  assert.match(installer, /APP_TRANSIENT_PATTERN/);
  assert.match(installer, /assertNoIncompleteRestoreState\(/);
  assert.match(installer, /rewriteBuildPaths\(path\.join\(TEMP_RUNTIME_PATH, "\.next"\)\)/);
  assert.match(installer, /replaceAll\(PROJECT_DIRECTORY, RUNTIME_PATH\)/);
  assert.match(installer, /const linkTarget = await readlink\(entryPath\)/);
  assert.match(installer, /path\.relative\(TEMP_RUNTIME_PATH, resolvedTarget\)/);
  assert.match(installer, /relativeTarget\.startsWith\(`\.\.\$\{path\.sep\}`\)/);
  assert.match(installer, /assertRiffSketchbookStopped\(\)/);
  assert.match(installer, /server-process\.json/);
  assert.match(installer, /inspectProcessIdentity\(/);
  assert.match(installer, /PROCESS_IDENTITY_STATUS\.INDETERMINATE/);
  assert.match(installer, /isWithinStartingGrace\(state\)/);
  assert.match(installer, /new AggregateError\(/);
  assert.match(installer, /rollbackManagedDirectory\(/);
  assert.match(installer, /swapManagedDirectory\([\s\S]*?RUNTIME_PATH,[\s\S]*?TEMP_RUNTIME_PATH/);
  assert.match(installer, /swapManagedDirectory\([\s\S]*?APP_PATH,[\s\S]*?TEMP_APP_PATH/);
  assert.match(installer, /copyMutableData\(replacingExistingRuntime \? RUNTIME_PATH : PROJECT_DIRECTORY\)/);
  assert.match(installer, /verbatimSymlinks: true/);
  assert.match(installer, /assertRuntimeSymlinksStayInside\(TEMP_RUNTIME_PATH\)/);
  assert.match(installer, /topLevel === "\.operation-lock" \|\| topLevel === "e2e"/);
  assert.match(installer, /rm\(TEMP_APP_PATH, \{ recursive: true, force: true \}\)/);
  assert.match(installer, /rm\(TEMP_RUNTIME_PATH, \{ recursive: true, force: true \}\)/);
  assert.match(installer, /recoveryArtifactExists/);
  assert.match(installer, /mergeOwnedDirectoryAdditively\([\s\S]*?"storage", "reference-library"/);
  assert.match(installer, /fsConstants\.O_NOFOLLOW/);
  assert.match(installer, /flag: "wx"/);
  assert.match(installer, /sourceFile\.contents\.equals\(destinationFile\.contents\)/);
  assert.match(installer, /내용이 다른 파일이 있어 덮어쓰지 않았어요/);
  assert.doesNotMatch(installer, /Terminal 창에서 Control \+ C/);
  assert.match(installer, /시작 창의 ‘서버 종료’를 누르거나 앱을 종료하세요/);
  assert.match(startApp, /acquireOperationLock\("runtime", \{[\s\S]*?root: installLockRoot/);
});

test("personal reference files merge additively without replacing installed data", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riff-reference-merge-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const source = path.join(root, "source-reference-library");
  const destinationParent = path.join(root, "runtime", "storage");
  const destination = path.join(destinationParent, "reference-library");
  await Promise.all([
    mkdir(path.join(source, "arpeggios"), { recursive: true }),
    mkdir(path.join(destination, "arpeggios"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(source, "arpeggios", "same.png"), "same-bytes"),
    writeFile(path.join(source, "arpeggios", "new.png"), "new-bytes"),
    writeFile(path.join(destination, "arpeggios", "same.png"), "same-bytes"),
    writeFile(path.join(destination, "personal-note.txt"), "keep-me"),
  ]);

  assert.deepEqual(
    await mergeOwnedDirectoryAdditively(source, destination),
    { addedFiles: 1, identicalFiles: 1 },
  );
  assert.equal(
    await readFile(path.join(destination, "arpeggios", "new.png"), "utf8"),
    "new-bytes",
  );
  assert.equal(
    await readFile(path.join(destination, "personal-note.txt"), "utf8"),
    "keep-me",
  );

  await writeFile(path.join(source, "arpeggios", "same.png"), "changed-source");
  await assert.rejects(
    mergeOwnedDirectoryAdditively(source, destination),
    /내용이 다른 파일이 있어 덮어쓰지 않았어요/,
  );
  assert.equal(
    await readFile(path.join(destination, "arpeggios", "same.png"), "utf8"),
    "same-bytes",
  );
});

test("personal reference merge rejects symlinks and allows an absent source", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riff-reference-safety-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const destinationParent = path.join(root, "runtime", "storage");
  await mkdir(destinationParent, { recursive: true });
  assert.deepEqual(
    await mergeOwnedDirectoryAdditively(
      path.join(root, "missing-reference-library"),
      path.join(destinationParent, "reference-library"),
    ),
    { addedFiles: 0, identicalFiles: 0 },
  );

  const source = path.join(root, "source-reference-library");
  const outside = path.join(root, "outside.png");
  await mkdir(source);
  await writeFile(outside, "outside");
  await symlink(outside, path.join(source, "unsafe.png"));

  await assert.rejects(
    mergeOwnedDirectoryAdditively(
      source,
      path.join(destinationParent, "reference-library"),
    ),
    /안전하지 않은 파일/,
  );
});

test("runtime copying preserves internal links and rejects links back to the source", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riff-runtime-links-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const runtime = path.join(root, "runtime");
  await mkdir(path.join(runtime, ".next", "node_modules"), { recursive: true });
  await mkdir(path.join(runtime, "node_modules", "pg"), { recursive: true });
  await symlink(
    "../../node_modules/pg",
    path.join(runtime, ".next", "node_modules", "pg-bundled"),
  );
  await assert.doesNotReject(assertRuntimeSymlinksStayInside(runtime));

  await symlink(
    projectDirectory,
    path.join(runtime, ".next", "node_modules", "source-checkout"),
  );
  await assert.rejects(
    assertRuntimeSymlinksStayInside(runtime),
    /실행 폴더 밖을 가리키는 링크/,
  );
});
