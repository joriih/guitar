import type { ChordPatternName, NoteName } from "./music-theory.ts";

export const ARPEGGIO_REFERENCE_FILE_NAME_PATTERN =
  /^[a-z0-9]+(?:-[a-z0-9]+)*\.png$/;

const REFERENCE_ROOT_SLUGS: Readonly<Record<NoteName, string>> = {
  C: "c",
  "C#": "c-sharp",
  Db: "c-sharp",
  D: "d",
  "D#": "e-flat",
  Eb: "e-flat",
  E: "e",
  F: "f",
  "F#": "f-sharp",
  Gb: "f-sharp",
  G: "g",
  "G#": "a-flat",
  Ab: "a-flat",
  A: "a",
  "A#": "b-flat",
  Bb: "b-flat",
  B: "b",
};

const NATURAL_ROOT_SLUGS = new Set(["a", "b", "c", "d", "e", "f", "g"]);

const MAJOR_REFERENCE_STEMS: Readonly<Record<string, string>> = {
  c: "c-major",
  "c-sharp": "c-sharp-major",
  d: "d-major",
  "e-flat": "e-flat",
  e: "e-major",
  f: "f-major",
  "f-sharp": "f-sharp",
  g: "g-major",
  "a-flat": "a-flat",
  a: "a-major",
  "b-flat": "b-flat",
  b: "b-major",
};

function referenceStem(rootSlug: string, patternName: ChordPatternName): string | null {
  switch (patternName) {
    case "Major":
      return MAJOR_REFERENCE_STEMS[rootSlug] ?? null;
    case "Minor":
      return `${rootSlug}-minor`;
    case "Dominant 7th":
      return NATURAL_ROOT_SLUGS.has(rootSlug) ? `${rootSlug}7` : `${rootSlug}-7`;
    case "Major 7th":
      return `${rootSlug}-maj7`;
    case "Minor 7th":
      return `${rootSlug}-minor7`;
    case "Diminished":
      return `${rootSlug}-diminished`;
    case "Diminished 7th":
      return `${rootSlug}-dim7`;
    case "Minor 7th b5":
      return NATURAL_ROOT_SLUGS.has(rootSlug) ? `${rootSlug}m7b5` : `${rootSlug}-m7b5`;
    case "Augmented":
      return `${rootSlug}-augmented`;
    default:
      return null;
  }
}

export function isSafeArpeggioReferenceFileName(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 96
    && ARPEGGIO_REFERENCE_FILE_NAME_PATTERN.test(value);
}

/**
 * Maps the spelling used in a chord chart to the site's locally saved,
 * enharmonically equivalent fretboard image. Unsupported extensions keep using
 * the app's generated mini fretboard instead.
 */
export function getArpeggioReferenceFileName(
  root: NoteName,
  patternName: ChordPatternName | null,
): string | null {
  if (!patternName) return null;
  const rootSlug = REFERENCE_ROOT_SLUGS[root];
  if (!rootSlug) return null;
  const stem = referenceStem(rootSlug, patternName);
  return stem ? `${stem}-arpeggio-fretboard.png` : null;
}
