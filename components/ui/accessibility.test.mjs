import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const uiDirectory = path.dirname(fileURLToPath(import.meta.url));
const componentsDirectory = path.dirname(uiDirectory);

function source(...segments) {
  return readFile(path.join(componentsDirectory, ...segments), "utf8");
}

test("authentication and search keep visible labels and focus at accessible contrast", async () => {
  const [authStyles, shellStyles] = await Promise.all([
    source("ui", "GuitarCaseAuth.module.css"),
    source("ui", "AppShell.module.css"),
  ]);

  for (const styles of [authStyles, shellStyles]) {
    assert.match(styles, /input::placeholder\s*\{[^}]*color:\s*var\(--muted\)/s);
    assert.match(styles, /input::placeholder\s*\{[^}]*opacity:\s*1/s);
    assert.match(styles, /:focus-within\s*\{[^}]*outline:\s*2px solid var\(--ink\)/s);
  }
});

test("recording writing tabs use roving focus and arrow-key navigation", async () => {
  const studio = await source("recording", "RecordingStudio.tsx");
  assert.match(studio, /tabIndex=\{writingMode === "tab" \? 0 : -1\}/);
  assert.match(studio, /tabIndex=\{writingMode === "notes" \? 0 : -1\}/);
  assert.equal((studio.match(/onKeyDown=\{handleWritingTabKeyDown\}/g) ?? []).length, 2);
  assert.match(studio, /event\.key === "ArrowLeft"/);
  assert.match(studio, /event\.key === "ArrowRight"/);
  assert.match(studio, /event\.key === "Home"/);
  assert.match(studio, /event\.key === "End"/);
});

test("custom studio controls retain a two-tone keyboard focus indicator", async () => {
  const [recordingStyles, advancedStyles, coverStyles] = await Promise.all([
    source("recording", "RecordingStudio.module.css"),
    source("advanced-studio", "AdvancedStudioTools.module.css"),
    source("library", "AlbumCoverPicker.module.css"),
  ]);

  for (const styles of [recordingStyles, advancedStyles]) {
    assert.match(styles, /outline:\s*2px solid #fff/);
    assert.match(styles, /box-shadow:\s*0 0 0 4px #161616/);
  }
  assert.match(recordingStyles, /\.studio textarea:focus-visible/);
  assert.match(advancedStyles, /\.tools canvas:focus-visible/);
  assert.match(
    coverStyles,
    /\.option input:focus-visible \+ label\s*\{[^}]*outline:\s*2px solid var\(--ink\)/s,
  );
});

test("forms with reset outlines provide a full two-pixel replacement", async () => {
  const stylesheets = await Promise.all([
    source("library", "LibraryPage.module.css"),
    source("library", "RiffTagEditor.module.css"),
    source("settings", "SettingsPage.module.css"),
    source("ui", "HomeContent.module.css"),
    source("ui", "EditorShell.module.css"),
  ]);

  for (const styles of stylesheets) {
    assert.match(styles, /:focus(?:-within)?\s*\{[^}]*outline:\s*2px solid var\(--ink\)/s);
  }
});

test("advanced primary controls and small labels meet text contrast tokens", async () => {
  const styles = await source("advanced-studio", "AdvancedStudioTools.module.css");
  assert.match(styles, /--red:\s*#dc2f4b/);
  assert.match(styles, /--muted:\s*#686a64/);
  assert.doesNotMatch(styles, /color:\s*#92948d/);
  assert.doesNotMatch(styles, /color:\s*#84867f/);
});

test("advanced busy state disables every editable studio control", async () => {
  const studio = await source("advanced-studio", "AdvancedStudioTools.tsx");
  assert.match(studio, /const studioActionBusy = busy !== null \|\| markerBusy !== null/);
  assert.match(studio, /aria-busy=\{studioControlsLocked \|\| undefined\}/);
  assert.match(studio, /value=\{uploadKind\} disabled=\{studioControlsLocked\}/);
  assert.match(studio, /value=\{punchStart\} disabled=\{studioControlsLocked\}/);
  assert.match(studio, /value=\{punchEnd\} disabled=\{studioControlsLocked\}/);
  assert.match(studio, /value=\{preRoll\} disabled=\{studioControlsLocked\}/);
  assert.match(
    studio,
    /onClick=\{discardPendingCompDraft\} disabled=\{studioControlsLocked \|\| !compHydrated\}/,
  );
});

test("track import picker exposes its help and visible keyboard focus at narrow widths", async () => {
  const [studio, styles] = await Promise.all([
    source("advanced-studio", "AdvancedStudioTools.tsx"),
    source("advanced-studio", "AdvancedStudioTools.module.css"),
  ]);

  assert.match(studio, /<label htmlFor=\{fileInputId\} className=\{styles\.uploadButton\}/);
  assert.match(studio, /accept=\{AUDIO_TRACK_IMPORT_ACCEPT\}/);
  assert.match(studio, /aria-describedby=\{`\$\{fileInputId\}-help`\}/);
  assert.match(studio, /className=\{styles\.importHelp\} id=\{`\$\{fileInputId\}-help`\}/);
  assert.match(styles, /\.uploadActions,[\s\S]*?flex-wrap:\s*wrap/);
  assert.match(styles, /@media \(max-width: 680px\)[\s\S]*?\.panelHeader,[\s\S]*?flex-direction:\s*column/);
  assert.match(styles, /\.importHelp\s*\{[^}]*color:\s*var\(--muted\)/s);
  assert.match(
    styles,
    /\.uploadButton:has\(\+ \.hiddenInput:focus-visible\)\s*\{[^}]*outline:\s*2px solid #fff[^}]*box-shadow:\s*0 0 0 4px #161616/s,
  );
});

test("YouTube recording checks the real iframe while official controls stay usable", async () => {
  const [player, section, recording] = await Promise.all([
    source("youtube-backing", "YouTubeBackingPlayer.tsx"),
    source("youtube-backing", "YouTubeBackingSection.tsx"),
    source("recording", "RecordingStudio.tsx"),
  ]);

  assert.match(
    player,
    /isRectMostlyVisible\(player\.getIframe\(\)\.getBoundingClientRect\(\)/,
  );
  assert.match(
    player,
    /onError:[\s\S]*?readyRef\.current = false;[\s\S]*?onControllerChange\?\.\(null\)/,
  );
  const playerUsage = section.match(/<YouTubeBackingPlayer[\s\S]*?\/>/)?.[0] ?? "";
  assert.ok(playerUsage, "YouTube player usage must remain visible in the section");
  assert.doesNotMatch(
    playerUsage,
    /\bdisabled=/,
    "capture locks must not block YouTube's official player controls",
  );
  assert.match(section, /aria-invalid=\{errorField === "url" \|\| undefined\}/);
  assert.match(section, /aria-invalid=\{errorField === "name" \|\| undefined\}/);
  assert.match(section, /aria-invalid=\{errorField === "start" \|\| undefined\}/);
  assert.match(player, /document\.visibilityState !== "visible"/);
  assert.match(section, /onPlaybackInterrupted\?\./);
  assert.match(recording, /onPlaybackInterrupted=\{handleYouTubePlaybackInterrupted\}/);
  assert.match(recording, /onSyncEnabledChange=\{setYouTubeSyncEnabled\}/);
  const recordingStart = recording.slice(recording.indexOf("const startRecording"));
  assert.ok(
    recordingStart.indexOf("recordingTransportRef.current?.prime()") <
      recordingStart.indexOf("prepareMicrophone("),
    "YouTube playback permission must be primed before the first microphone await",
  );
});

test("recording meters and compact mobile options expose their real values without horizontal clipping", async () => {
  const [recording, recordingStyles, advanced] = await Promise.all([
    source("recording", "RecordingStudio.tsx"),
    source("recording", "RecordingStudio.module.css"),
    source("advanced-studio", "AdvancedStudioTools.tsx"),
  ]);

  assert.match(recording, /aria-valuemin=\{-48\}/);
  assert.match(recording, /aria-valuemax=\{0\}/);
  assert.match(recording, /aria-valuenow=\{inputLevelDb\}/);
  assert.match(recording, /aria-valuetext=\{`\$\{inputLevelDb\} dB`\}/);
  assert.match(
    recordingStyles,
    /@media \(max-width: 700px\)[\s\S]*?\.recordSettings\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)[^}]*overflow-x:\s*visible/s,
  );
  assert.doesNotMatch(advanced, /role="table" aria-label="Comp 구간 목록"/);
  assert.doesNotMatch(advanced, /className=\{styles\.compRow\} role="row"/);
});
