import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcher = await readFile(
  path.join(projectRoot, "scripts", "macos-launcher.swift"),
  "utf8",
);

test("native launcher resolves only packaged or stable local runtime paths", () => {
  assert.doesNotMatch(launcher, /\/Users\//);
  assert.doesNotMatch(launcher, /Documents\/Codex/);
  assert.match(launcher, /Bundle\.main\.resourceURL/);
  assert.match(launcher, /Library\/Application Support\/Riff Sketchbook/);
  assert.match(launcher, /\.runtime-node\/bin\/node/);
  assert.match(launcher, /scripts\/start-app\.mjs/);
});

test("native launcher keeps local logs private and never exposes the server", () => {
  assert.match(launcher, /Library\/Logs\/Riff Sketchbook/);
  assert.match(launcher, /NSNumber\(value: 0o700\)/);
  assert.match(launcher, /NSNumber\(value: 0o600\)/);
  assert.match(launcher, /http:\/\/127\.0\.0\.1/);
  assert.doesNotMatch(launcher, /0\.0\.0\.0/);
  assert.match(launcher, /"RIFF_OPEN_BROWSER": "0"/);
  assert.match(launcher, /"RIFF_SERVER_STATE_PATH": LauncherConstants\.supportDirectory/);
  assert.match(launcher, /appendingPathComponent\("server-process\.json"\)\.path/);
  assert.doesNotMatch(
    launcher,
    /var environment = ProcessInfo\.processInfo\.environment/,
  );
  assert.match(launcher, /process\.standardError = output/);
});

test("native launcher owns lifecycle and provides a Korean status UI", () => {
  assert.match(launcher, /process\.terminate\(\)/);
  assert.match(launcher, /SIGTERM/);
  assert.doesNotMatch(launcher, /SIGKILL|\bkill\s*\(/);
  assert.match(launcher, /reply\(toApplicationShouldTerminate: false\)/);
  assert.match(launcher, /applicationShouldTerminate/);
  assert.match(launcher, /웹 화면 열기/);
  assert.match(launcher, /서버 종료/);
  assert.match(launcher, /준비됐어요/);
  assert.match(launcher, /앱을 시작하지 못했어요/);
  assert.match(launcher, /서버 종료가 지연되고 있어요/);
  assert.match(launcher, /이미 실행 중인 스케치북에 연결했어요/);
});
