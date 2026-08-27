import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error Node's type-stripping test runner requires the .ts extension.
import { degreeName, formatMusicXmlChordSymbol, getCapoMappings, getFretPositionWindows, getMatchingCapoShapes, getMusicXmlChordNotes, getNoteIndex, getPatternDegreeName, getPatternIntervals, getPatternNotes, modulo12, musicXmlPitchToNoteName, noteName, resolveMusicXmlChordKind, transposeNote } from "./music-theory.ts";

test("note helpers normalize octaves and enharmonic names", () => {
  assert.equal(modulo12(-1), 11);
  assert.equal(noteName(13), "C#");
  assert.equal(noteName(13, "flat"), "Db");
  assert.equal(getNoteIndex("C#"), getNoteIndex("Db"));
  assert.equal(getNoteIndex("H"), null);
  assert.equal(transposeNote("Bb", 2), "C");
  assert.equal(transposeNote("C", -1), "B");
});

test("scale and chord patterns return reusable notes without changing the catalogs", () => {
  assert.deepEqual(getPatternIntervals("scale", "Pentatonic Minor"), [0, 3, 5, 7, 10]);
  assert.deepEqual(getPatternNotes("C", "chord", "Major 7th"), ["C", "E", "G", "B"]);
  assert.deepEqual(getPatternNotes("Bb", "scale", "Major"), ["Bb", "C", "D", "Eb", "F", "G", "A"]);
  assert.deepEqual(getPatternIntervals("scale", "not-a-pattern"), []);
  assert.equal(degreeName(10), "♭7");
});

test("chord extensions keep compound degree labels while pitch classes stay normalized", () => {
  assert.equal(getPatternDegreeName("scale", "Major", 2), "2");
  assert.equal(getPatternDegreeName("chord", "Add9", 2), "9");
  assert.equal(getPatternDegreeName("chord", "Dominant 11th", 5), "11");
  assert.equal(getPatternDegreeName("chord", "Dominant 13th", 9), "13");
  assert.equal(getPatternDegreeName("chord", "Major 6th", 9), "6");
});

test("MusicXML chord kinds map to reusable chord-tone patterns", () => {
  assert.deepEqual(resolveMusicXmlChordKind("major-seventh"), {
    patternName: "Major 7th",
    suffix: "maj7",
  });
  assert.equal(resolveMusicXmlChordKind("half-diminished")?.patternName, "Minor 7th b5");
  assert.equal(resolveMusicXmlChordKind("other", "m11")?.patternName, "Minor 11th");
  assert.equal(resolveMusicXmlChordKind("other", "not-known"), null);
  assert.deepEqual(getPatternNotes("C", "chord", "Dominant 9th"), ["C", "E", "G", "Bb", "D"]);
  assert.deepEqual(getPatternNotes("F#", "chord", "Major 7th"), ["F#", "A#", "C#", "E#"]);
  assert.equal(getPatternDegreeName("chord", "Diminished 7th", 6), "♭5");
  assert.deepEqual(getPatternNotes("Eb", "chord", "Diminished 7th"), ["Eb", "Gb", "Bbb", "Dbb"]);
});

test("MusicXML accidentals and slash bass symbols stay readable", () => {
  assert.equal(musicXmlPitchToNoteName("B", -1), "Bb");
  assert.equal(musicXmlPitchToNoteName("F", 1), "F#");
  assert.equal(musicXmlPitchToNoteName("H", 0), null);
  assert.equal(formatMusicXmlChordSymbol({
    rootStep: "B",
    rootAlter: -1,
    kindValue: "minor-seventh",
    bassStep: "E",
    bassAlter: -1,
  }), "B♭m7/E♭");
  assert.deepEqual(
    getMusicXmlChordNotes("C", -1, "Major 7th"),
    ["Cb", "Eb", "Gb", "Bb"],
  );
  assert.deepEqual(
    getMusicXmlChordNotes("B", 1, "Dominant 7th"),
    ["B#", "D##", "F##", "A#"],
  );
});

test("fret windows cover the requested fretboard without claiming fingering shapes", () => {
  const windows = getFretPositionWindows(24);
  assert.equal(windows.length, 5);
  assert.deepEqual(windows[0], {
    name: "0–4프렛",
    startFret: 0,
    endFret: 4,
  });
  assert.ok(windows.every(({ startFret, endFret }) => startFret >= 0 && endFret <= 24));
  assert.deepEqual(getFretPositionWindows(2, 0), [
    { name: "0–0프렛", startFret: 0, endFret: 0 },
    { name: "1–1프렛", startFret: 1, endFret: 1 },
    { name: "2–2프렛", startFret: 2, endFret: 2 },
  ]);
});

test("capo mappings preserve the open shape and calculate its sounding root", () => {
  const capoTwo = getCapoMappings(2);
  assert.deepEqual(capoTwo.find(({ shape }) => shape === "C 폼"), {
    shape: "C 폼",
    quality: "major",
    soundingNote: "D",
  });
  assert.deepEqual(capoTwo.find(({ shape }) => shape === "A 폼"), {
    shape: "A 폼",
    quality: "major",
    soundingNote: "B",
  });
  assert.deepEqual(capoTwo.find(({ shape }) => shape === "Dm 폼"), {
    shape: "Dm 폼",
    quality: "minor",
    soundingNote: "E",
  });
  assert.notEqual(
    capoTwo.find(({ shape }) => shape === "D 폼")?.quality,
    capoTwo.find(({ shape }) => shape === "Dm 폼")?.quality,
  );
  assert.deepEqual(
    getMatchingCapoShapes("D", "major", 0).map(({ shape }) => shape),
    ["D 폼"],
  );
  assert.deepEqual(
    getMatchingCapoShapes("D", "minor", 0).map(({ shape }) => shape),
    ["Dm 폼"],
  );
  assert.equal(getCapoMappings(99)[0].soundingNote, "C");
});
