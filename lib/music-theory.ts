export const NOTES_SHARP = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
] as const;

export const NOTES_FLAT = [
  "C",
  "Db",
  "D",
  "Eb",
  "E",
  "F",
  "Gb",
  "G",
  "Ab",
  "A",
  "Bb",
  "B",
] as const;

export type NoteName = (typeof NOTES_SHARP)[number] | (typeof NOTES_FLAT)[number];
export type AccidentalPreference = "sharp" | "flat" | "auto";
export type PatternKind = "scale" | "chord";
export type ChordQuality = "major" | "minor";

const NOTE_INDEX: Readonly<Record<NoteName, number>> = {
  C: 0,
  "C#": 1,
  Db: 1,
  D: 2,
  "D#": 3,
  Eb: 3,
  E: 4,
  F: 5,
  "F#": 6,
  Gb: 6,
  G: 7,
  "G#": 8,
  Ab: 8,
  A: 9,
  "A#": 10,
  Bb: 10,
  B: 11,
};

const FLAT_ROOTS = new Set<NoteName>(["F", "Bb", "Eb", "Ab", "Db", "Gb"]);

export const STANDARD_GUITAR_STRINGS = [
  { label: "6번 E", pitchClass: 4 },
  { label: "5번 A", pitchClass: 9 },
  { label: "4번 D", pitchClass: 2 },
  { label: "3번 G", pitchClass: 7 },
  { label: "2번 B", pitchClass: 11 },
  { label: "1번 e", pitchClass: 4 },
] as const;

export const SCALE_PATTERNS = {
  Major: [0, 2, 4, 5, 7, 9, 11],
  "Natural Minor": [0, 2, 3, 5, 7, 8, 10],
  "Harmonic Minor": [0, 2, 3, 5, 7, 8, 11],
  "Melodic Minor": [0, 2, 3, 5, 7, 9, 11],
  "Pentatonic Major": [0, 2, 4, 7, 9],
  "Pentatonic Minor": [0, 3, 5, 7, 10],
  Blues: [0, 3, 5, 6, 7, 10],
  Ionian: [0, 2, 4, 5, 7, 9, 11],
  Dorian: [0, 2, 3, 5, 7, 9, 10],
  Phrygian: [0, 1, 3, 5, 7, 8, 10],
  Lydian: [0, 2, 4, 6, 7, 9, 11],
  Mixolydian: [0, 2, 4, 5, 7, 9, 10],
  Aeolian: [0, 2, 3, 5, 7, 8, 10],
  Locrian: [0, 1, 3, 5, 6, 8, 10],
  "Whole Tone": [0, 2, 4, 6, 8, 10],
  Diminished: [0, 2, 3, 5, 6, 8, 9, 11],
  "Hungarian Minor": [0, 2, 3, 6, 7, 8, 11],
  Persian: [0, 1, 4, 5, 6, 8, 11],
  "Arpeggio Major": [0, 4, 7],
  "Arpeggio Minor": [0, 3, 7],
  "Arpeggio Dom7": [0, 4, 7, 10],
  "Arpeggio Maj7": [0, 4, 7, 11],
  "Arpeggio Min7": [0, 3, 7, 10],
  "Arpeggio Dim7": [0, 3, 6, 9],
} as const satisfies Readonly<Record<string, readonly number[]>>;

export const CHORD_PATTERNS = {
  Major: [0, 4, 7],
  Minor: [0, 3, 7],
  "Power 5": [0, 7],
  "Major 6th": [0, 4, 7, 9],
  "Minor 6th": [0, 3, 7, 9],
  "Dominant 7th": [0, 4, 7, 10],
  "Major 7th": [0, 4, 7, 11],
  "Minor 7th": [0, 3, 7, 10],
  "Minor Major 7th": [0, 3, 7, 11],
  Diminished: [0, 3, 6],
  "Diminished 7th": [0, 3, 6, 9],
  "Minor 7th b5": [0, 3, 6, 10],
  Augmented: [0, 4, 8],
  "Augmented 7th": [0, 4, 8, 10],
  Sus2: [0, 2, 7],
  Sus4: [0, 5, 7],
  Add9: [0, 4, 7, 2],
  "Minor Add 9": [0, 3, 7, 2],
  "Major 6/9": [0, 4, 7, 9, 2],
  "Minor 6/9": [0, 3, 7, 9, 2],
  "Major 9th": [0, 4, 7, 11, 2],
  "Minor 9th": [0, 3, 7, 10, 2],
  "Dominant 9th": [0, 4, 7, 10, 2],
  "Dominant 11th": [0, 4, 7, 10, 2, 5],
  "Major 11th": [0, 4, 7, 11, 2, 5],
  "Minor 11th": [0, 3, 7, 10, 2, 5],
  "Dominant 13th": [0, 4, 7, 10, 2, 5, 9],
  "Major 13th": [0, 4, 7, 11, 2, 5, 9],
  "Minor 13th": [0, 3, 7, 10, 2, 5, 9],
} as const satisfies Readonly<Record<string, readonly number[]>>;

export const SCALE_LABELS: Readonly<Record<keyof typeof SCALE_PATTERNS, string>> = {
  Major: "메이저",
  "Natural Minor": "내추럴 마이너",
  "Harmonic Minor": "하모닉 마이너",
  "Melodic Minor": "멜로딕 마이너",
  "Pentatonic Major": "메이저 펜타토닉",
  "Pentatonic Minor": "마이너 펜타토닉",
  Blues: "블루스",
  Ionian: "아이오니안",
  Dorian: "도리안",
  Phrygian: "프리지안",
  Lydian: "리디안",
  Mixolydian: "믹솔리디안",
  Aeolian: "에올리안",
  Locrian: "로크리안",
  "Whole Tone": "온음음계",
  Diminished: "디미니시드",
  "Hungarian Minor": "헝가리안 마이너",
  Persian: "페르시안",
  "Arpeggio Major": "메이저 아르페지오",
  "Arpeggio Minor": "마이너 아르페지오",
  "Arpeggio Dom7": "도미넌트 7 아르페지오",
  "Arpeggio Maj7": "메이저 7 아르페지오",
  "Arpeggio Min7": "마이너 7 아르페지오",
  "Arpeggio Dim7": "디미니시드 7 아르페지오",
};

export const CHORD_LABELS: Readonly<Record<keyof typeof CHORD_PATTERNS, string>> = {
  Major: "메이저",
  Minor: "마이너",
  "Power 5": "파워 5",
  "Major 6th": "메이저 6",
  "Minor 6th": "마이너 6",
  "Dominant 7th": "도미넌트 7",
  "Major 7th": "메이저 7",
  "Minor 7th": "마이너 7",
  "Minor Major 7th": "마이너 메이저 7",
  Diminished: "디미니시드",
  "Diminished 7th": "디미니시드 7",
  "Minor 7th b5": "마이너 7 플랫 5",
  Augmented: "어그먼티드",
  "Augmented 7th": "어그먼티드 7",
  Sus2: "서스 2",
  Sus4: "서스 4",
  Add9: "애드 9",
  "Minor Add 9": "마이너 애드 9",
  "Major 6/9": "메이저 6/9",
  "Minor 6/9": "마이너 6/9",
  "Major 9th": "메이저 9",
  "Minor 9th": "마이너 9",
  "Dominant 9th": "도미넌트 9",
  "Dominant 11th": "도미넌트 11",
  "Major 11th": "메이저 11",
  "Minor 11th": "마이너 11",
  "Dominant 13th": "도미넌트 13",
  "Major 13th": "메이저 13",
  "Minor 13th": "마이너 13",
};

export type ScalePatternName = keyof typeof SCALE_PATTERNS;
export type ChordPatternName = keyof typeof CHORD_PATTERNS;

const EMPTY_INTERVALS: readonly number[] = Object.freeze([]);
const FUNCTIONAL_DEGREES: Readonly<Record<number, string>> = {
  0: "R",
  1: "♭2",
  2: "2",
  3: "♭3",
  4: "3",
  5: "4",
  6: "♯4/♭5",
  7: "5",
  8: "♭6",
  9: "6",
  10: "♭7",
  11: "7",
};

const CHORD_EXTENSION_DEGREES: Readonly<
  Partial<Record<ChordPatternName, Readonly<Record<number, string>>>>
> = {
  Diminished: { 6: "♭5" },
  "Diminished 7th": { 6: "♭5", 9: "𝄫7" },
  "Minor 7th b5": { 6: "♭5" },
  Augmented: { 8: "♯5" },
  "Augmented 7th": { 8: "♯5" },
  Add9: { 2: "9" },
  "Minor Add 9": { 2: "9" },
  "Major 6/9": { 2: "9" },
  "Minor 6/9": { 2: "9" },
  "Major 9th": { 2: "9" },
  "Minor 9th": { 2: "9" },
  "Dominant 9th": { 2: "9" },
  "Dominant 11th": { 2: "9", 5: "11" },
  "Major 11th": { 2: "9", 5: "11" },
  "Minor 11th": { 2: "9", 5: "11" },
  "Dominant 13th": { 2: "9", 5: "11", 9: "13" },
  "Major 13th": { 2: "9", 5: "11", 9: "13" },
  "Minor 13th": { 2: "9", 5: "11", 9: "13" },
};

export type MusicXmlChordKind = {
  patternName: ChordPatternName;
  suffix: string;
};

const MUSIC_XML_CHORD_KINDS: Readonly<Record<string, MusicXmlChordKind>> = {
  major: { patternName: "Major", suffix: "" },
  minor: { patternName: "Minor", suffix: "m" },
  power: { patternName: "Power 5", suffix: "5" },
  augmented: { patternName: "Augmented", suffix: "aug" },
  diminished: { patternName: "Diminished", suffix: "dim" },
  dominant: { patternName: "Dominant 7th", suffix: "7" },
  "major-seventh": { patternName: "Major 7th", suffix: "maj7" },
  "minor-seventh": { patternName: "Minor 7th", suffix: "m7" },
  "major-minor": { patternName: "Minor Major 7th", suffix: "m(maj7)" },
  "augmented-seventh": { patternName: "Augmented 7th", suffix: "aug7" },
  "diminished-seventh": { patternName: "Diminished 7th", suffix: "dim7" },
  "half-diminished": { patternName: "Minor 7th b5", suffix: "m7♭5" },
  "major-sixth": { patternName: "Major 6th", suffix: "6" },
  "minor-sixth": { patternName: "Minor 6th", suffix: "m6" },
  "dominant-ninth": { patternName: "Dominant 9th", suffix: "9" },
  "major-ninth": { patternName: "Major 9th", suffix: "maj9" },
  "minor-ninth": { patternName: "Minor 9th", suffix: "m9" },
  "dominant-11th": { patternName: "Dominant 11th", suffix: "11" },
  "major-11th": { patternName: "Major 11th", suffix: "maj11" },
  "minor-11th": { patternName: "Minor 11th", suffix: "m11" },
  "dominant-13th": { patternName: "Dominant 13th", suffix: "13" },
  "major-13th": { patternName: "Major 13th", suffix: "maj13" },
  "minor-13th": { patternName: "Minor 13th", suffix: "m13" },
  "suspended-second": { patternName: "Sus2", suffix: "sus2" },
  "suspended-fourth": { patternName: "Sus4", suffix: "sus4" },
};

const MUSIC_XML_KIND_TEXT_ALIASES: Readonly<Record<string, MusicXmlChordKind>> = {
  "5": MUSIC_XML_CHORD_KINDS.power,
  m: MUSIC_XML_CHORD_KINDS.minor,
  min: MUSIC_XML_CHORD_KINDS.minor,
  "6": MUSIC_XML_CHORD_KINDS["major-sixth"],
  m6: MUSIC_XML_CHORD_KINDS["minor-sixth"],
  min6: MUSIC_XML_CHORD_KINDS["minor-sixth"],
  "7": MUSIC_XML_CHORD_KINDS.dominant,
  maj7: MUSIC_XML_CHORD_KINDS["major-seventh"],
  ma7: MUSIC_XML_CHORD_KINDS["major-seventh"],
  "Δ7": MUSIC_XML_CHORD_KINDS["major-seventh"],
  m7: MUSIC_XML_CHORD_KINDS["minor-seventh"],
  min7: MUSIC_XML_CHORD_KINDS["minor-seventh"],
  "m(maj7)": MUSIC_XML_CHORD_KINDS["major-minor"],
  mmaj7: MUSIC_XML_CHORD_KINDS["major-minor"],
  dim: MUSIC_XML_CHORD_KINDS.diminished,
  "°": MUSIC_XML_CHORD_KINDS.diminished,
  dim7: MUSIC_XML_CHORD_KINDS["diminished-seventh"],
  "°7": MUSIC_XML_CHORD_KINDS["diminished-seventh"],
  "m7b5": MUSIC_XML_CHORD_KINDS["half-diminished"],
  "ø": MUSIC_XML_CHORD_KINDS["half-diminished"],
  "ø7": MUSIC_XML_CHORD_KINDS["half-diminished"],
  aug: MUSIC_XML_CHORD_KINDS.augmented,
  "+": MUSIC_XML_CHORD_KINDS.augmented,
  aug7: MUSIC_XML_CHORD_KINDS["augmented-seventh"],
  "+7": MUSIC_XML_CHORD_KINDS["augmented-seventh"],
  sus2: MUSIC_XML_CHORD_KINDS["suspended-second"],
  sus4: MUSIC_XML_CHORD_KINDS["suspended-fourth"],
  sus: MUSIC_XML_CHORD_KINDS["suspended-fourth"],
  "9": MUSIC_XML_CHORD_KINDS["dominant-ninth"],
  maj9: MUSIC_XML_CHORD_KINDS["major-ninth"],
  m9: MUSIC_XML_CHORD_KINDS["minor-ninth"],
  "11": MUSIC_XML_CHORD_KINDS["dominant-11th"],
  maj11: MUSIC_XML_CHORD_KINDS["major-11th"],
  m11: MUSIC_XML_CHORD_KINDS["minor-11th"],
  "13": MUSIC_XML_CHORD_KINDS["dominant-13th"],
  maj13: MUSIC_XML_CHORD_KINDS["major-13th"],
  m13: MUSIC_XML_CHORD_KINDS["minor-13th"],
};

export type FretPositionWindow = {
  name: string;
  startFret: number;
  endFret: number;
};

export const OPEN_CHORD_SHAPES = [
  { name: "C 폼", pitchClass: 0, quality: "major" },
  { name: "D 폼", pitchClass: 2, quality: "major" },
  { name: "E 폼", pitchClass: 4, quality: "major" },
  { name: "G 폼", pitchClass: 7, quality: "major" },
  { name: "A 폼", pitchClass: 9, quality: "major" },
  { name: "Dm 폼", pitchClass: 2, quality: "minor" },
  { name: "Em 폼", pitchClass: 4, quality: "minor" },
  { name: "Am 폼", pitchClass: 9, quality: "minor" },
] as const satisfies readonly {
  name: string;
  pitchClass: number;
  quality: ChordQuality;
}[];

export function modulo12(value: number): number {
  return ((value % 12) + 12) % 12;
}

export function getNoteIndex(note: string): number | null {
  return Object.prototype.hasOwnProperty.call(NOTE_INDEX, note)
    ? NOTE_INDEX[note as NoteName]
    : null;
}

export function noteName(index: number, preference: Exclude<AccidentalPreference, "auto"> = "sharp"): NoteName {
  return preference === "flat" ? NOTES_FLAT[modulo12(index)] : NOTES_SHARP[modulo12(index)];
}

export function preferredAccidental(rootNote: NoteName): "sharp" | "flat" {
  return FLAT_ROOTS.has(rootNote) ? "flat" : "sharp";
}

export function transposeNote(
  note: NoteName,
  semitones: number,
  preference: AccidentalPreference = "auto",
): NoteName {
  const index = NOTE_INDEX[note];
  const resolvedPreference = preference === "auto" ? preferredAccidental(note) : preference;
  return noteName(index + semitones, resolvedPreference);
}

export function musicXmlAccidentalLabel(alter: number): string {
  const safeAlter = Math.max(-2, Math.min(2, Math.trunc(alter)));
  if (safeAlter === -2) return "♭♭";
  if (safeAlter === -1) return "♭";
  if (safeAlter === 1) return "♯";
  if (safeAlter === 2) return "♯♯";
  return "";
}

export function musicXmlPitchLabel(step: string, alter = 0): string | null {
  const normalizedStep = step.trim().toUpperCase();
  if (!/^[A-G]$/.test(normalizedStep) || !Number.isInteger(alter) || Math.abs(alter) > 2) {
    return null;
  }
  return `${normalizedStep}${musicXmlAccidentalLabel(alter)}`;
}

export function musicXmlPitchToNoteName(step: string, alter = 0): NoteName | null {
  const normalizedStep = step.trim().toUpperCase();
  const naturalIndex = getNoteIndex(normalizedStep);
  if (naturalIndex === null || !Number.isInteger(alter) || Math.abs(alter) > 2) return null;
  const preference = alter < 0 ? "flat" : "sharp";
  return noteName(naturalIndex + alter, preference);
}

export function resolveMusicXmlChordKind(
  kindValue: string,
  kindText = "",
): MusicXmlChordKind | null {
  const normalizedKind = kindValue.trim().toLowerCase();
  const byKind = MUSIC_XML_CHORD_KINDS[normalizedKind];
  if (byKind) return byKind;

  const exactText = kindText.trim().replaceAll("♭", "b").replaceAll("♯", "#");
  if (!exactText) return null;
  if (exactText === "M7") return MUSIC_XML_CHORD_KINDS["major-seventh"];
  if (exactText === "M9") return MUSIC_XML_CHORD_KINDS["major-ninth"];
  if (exactText === "M11") return MUSIC_XML_CHORD_KINDS["major-11th"];
  if (exactText === "M13") return MUSIC_XML_CHORD_KINDS["major-13th"];

  const normalizedText = exactText.toLowerCase().replaceAll(/\s+/g, "");
  return MUSIC_XML_KIND_TEXT_ALIASES[normalizedText] ?? null;
}

export function formatMusicXmlChordSymbol({
  rootStep,
  rootAlter = 0,
  kindValue,
  kindText = "",
  bassStep,
  bassAlter = 0,
}: {
  rootStep: string;
  rootAlter?: number;
  kindValue: string;
  kindText?: string;
  bassStep?: string | null;
  bassAlter?: number;
}): string | null {
  const root = musicXmlPitchLabel(rootStep, rootAlter);
  if (!root) return null;
  const resolvedKind = resolveMusicXmlChordKind(kindValue, kindText);
  const fallbackSuffix = kindText.trim() || (kindValue === "major" ? "" : kindValue.trim());
  const suffix = resolvedKind?.suffix ?? fallbackSuffix;
  const bass = bassStep ? musicXmlPitchLabel(bassStep, bassAlter) : null;
  return `${root}${suffix}${bass ? `/${bass}` : ""}`;
}

export function getPatternIntervals(kind: PatternKind, patternName: string): readonly number[] {
  const patterns: Readonly<Record<string, readonly number[]>> =
    kind === "scale" ? SCALE_PATTERNS : CHORD_PATTERNS;
  return patterns[patternName] ?? EMPTY_INTERVALS;
}

export function degreeName(interval: number): string {
  return FUNCTIONAL_DEGREES[modulo12(interval)] ?? "";
}

export function getPatternDegreeName(
  kind: PatternKind,
  patternName: string,
  interval: number,
): string {
  const normalizedInterval = modulo12(interval);
  if (kind === "chord") {
    const extensionLabels = CHORD_EXTENSION_DEGREES[patternName as ChordPatternName];
    const extensionLabel = extensionLabels?.[normalizedInterval];
    if (extensionLabel) return extensionLabel;
  }
  return degreeName(normalizedInterval);
}

export function getPatternNotes(
  rootNote: NoteName,
  kind: PatternKind,
  patternName: string,
  preference: AccidentalPreference = "auto",
): string[] {
  const rootIndex = NOTE_INDEX[rootNote];
  const resolvedPreference = preference === "auto" ? preferredAccidental(rootNote) : preference;
  return getPatternIntervals(kind, patternName).map((interval) => {
    if (kind !== "chord") return noteName(rootIndex + interval, resolvedPreference);

    const degree = getPatternDegreeName(kind, patternName, interval);
    const degreeNumber = degree === "R" ? 1 : Number.parseInt(degree.replaceAll(/[^0-9]/g, ""), 10);
    if (!Number.isInteger(degreeNumber) || degreeNumber < 1) {
      return noteName(rootIndex + interval, resolvedPreference);
    }

    const letterNames = ["C", "D", "E", "F", "G", "A", "B"] as const;
    const rootLetterIndex = letterNames.indexOf(rootNote[0] as (typeof letterNames)[number]);
    const targetLetter = letterNames[(rootLetterIndex + degreeNumber - 1) % letterNames.length];
    const targetPitch = modulo12(rootIndex + interval);
    const naturalPitch = NOTE_INDEX[targetLetter];
    let alteration = modulo12(targetPitch - naturalPitch);
    if (alteration > 6) alteration -= 12;
    if (alteration === 0) return targetLetter;
    if (alteration === 1) return `${targetLetter}#`;
    if (alteration === -1) return `${targetLetter}b`;
    if (alteration === 2) return `${targetLetter}##`;
    if (alteration === -2) return `${targetLetter}bb`;
    return noteName(targetPitch, resolvedPreference);
  });
}

export function getFretPositionWindows(
  maxFret = 24,
  fretsPerWindow = 5,
): FretPositionWindow[] {
  const safeMaxFret = Math.max(0, Math.trunc(maxFret));
  const safeWindowSize = Math.max(1, Math.trunc(fretsPerWindow));
  const windows: FretPositionWindow[] = [];

  for (let startFret = 0; startFret <= safeMaxFret; startFret += safeWindowSize) {
    const endFret = Math.min(safeMaxFret, startFret + safeWindowSize - 1);
    windows.push({
      name: `${startFret}–${endFret}프렛`,
      startFret,
      endFret,
    });
  }

  return windows;
}

export function getCapoMappings(
  capoFret: number,
  preference: Exclude<AccidentalPreference, "auto"> = "sharp",
) {
  const safeCapo = Math.min(12, Math.max(0, Math.trunc(capoFret)));
  return OPEN_CHORD_SHAPES.map((shape) => ({
    shape: shape.name,
    quality: shape.quality,
    soundingNote: noteName(shape.pitchClass + safeCapo, preference),
  }));
}

export function getMatchingCapoShapes(
  targetNote: NoteName,
  targetQuality: ChordQuality,
  capoFret: number,
) {
  const targetIndex = NOTE_INDEX[targetNote];
  return getCapoMappings(capoFret, preferredAccidental(targetNote)).filter(
    ({ soundingNote, quality }) =>
      NOTE_INDEX[soundingNote] === targetIndex && quality === targetQuality,
  );
}
