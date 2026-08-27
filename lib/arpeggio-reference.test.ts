import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// @ts-expect-error Node's type-stripping test runner requires the .ts extension.
import { getArpeggioReferenceFileName, isSafeArpeggioReferenceFileName } from "./arpeggio-reference.ts";
// @ts-expect-error Node's type-stripping test runner requires the .ts extension.
import { parseArpeggioReferenceManifest, readArpeggioReferenceImage } from "./arpeggio-reference-storage.ts";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("private-reference-test"),
]);

function manifestFor(fileName: string, bytes = PNG) {
  return JSON.stringify({
    source: "https://www.guitar-chords.org.uk",
    personalReferenceOnly: true,
    images: [{
      fileName,
      sourceURL: `https://www.guitar-chords.org.uk/arpeggio-images/${fileName}`,
      pageURL: "https://www.guitar-chords.org.uk/arpeggios/c-7-arpeggios.html",
      byteSize: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }],
  });
}

async function createReferenceFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "riff-reference-test-"));
  const directory = path.join(root, "storage", "reference-library", "guitar-chords", "arpeggios");
  await mkdir(directory, { recursive: true });
  const fileName = "c-maj7-arpeggio-fretboard.png";
  await writeFile(path.join(directory, fileName), PNG);
  await writeFile(path.join(directory, "manifest.json"), manifestFor(fileName));
  return { root, directory, fileName };
}

test("maps common MusicXML chord roots and qualities to exact saved fretboard names", () => {
  assert.equal(getArpeggioReferenceFileName("C", "Major 7th"), "c-maj7-arpeggio-fretboard.png");
  assert.equal(getArpeggioReferenceFileName("E", "Dominant 7th"), "e7-arpeggio-fretboard.png");
  assert.equal(getArpeggioReferenceFileName("Bb", "Minor 7th"), "b-flat-minor7-arpeggio-fretboard.png");
  assert.equal(getArpeggioReferenceFileName("Db", "Diminished 7th"), "c-sharp-dim7-arpeggio-fretboard.png");
  assert.equal(getArpeggioReferenceFileName("G#", "Minor 7th b5"), "a-flat-m7b5-arpeggio-fretboard.png");
  assert.equal(getArpeggioReferenceFileName("E", "Minor 7th b5"), "em7b5-arpeggio-fretboard.png");
  assert.equal(getArpeggioReferenceFileName("F#", "Major"), "f-sharp-arpeggio-fretboard.png");
  assert.equal(getArpeggioReferenceFileName("C", "Major 9th"), null);
  assert.equal(getArpeggioReferenceFileName("C", null), null);
});

test("accepts only short lowercase PNG basenames", () => {
  assert.equal(isSafeArpeggioReferenceFileName("c7-arpeggio-fretboard.png"), true);
  for (const value of [
    "../c7-arpeggio-fretboard.png",
    "nested/c7-arpeggio-fretboard.png",
    "C7-arpeggio-fretboard.png",
    "c7-arpeggio-fretboard.jpg",
    "c7.png%00.txt",
    "",
  ]) {
    assert.equal(isSafeArpeggioReferenceFileName(value), false);
  }
});

test("reads an exact manifest-listed PNG and treats absent entries as unavailable", async (t) => {
  const fixture = await createReferenceFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const image = await readArpeggioReferenceImage(fixture.fileName, fixture.root);
  assert.ok(image);
  assert.equal(image.fileName, fixture.fileName);
  assert.deepEqual(Buffer.from(image.bytes), PNG);
  assert.equal(await readArpeggioReferenceImage("d7-arpeggio-fretboard.png", fixture.root), null);
  assert.equal(await readArpeggioReferenceImage("../manifest.json", fixture.root), null);
  assert.equal(await readArpeggioReferenceImage(fixture.fileName, path.join(fixture.root, "missing")), null);
});

test("rejects tampered, symlinked, and nonregular image files without serving bytes", async (t) => {
  const fixture = await createReferenceFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  await writeFile(path.join(fixture.directory, fixture.fileName), Buffer.concat([PNG, Buffer.from("changed")]));
  assert.equal(await readArpeggioReferenceImage(fixture.fileName, fixture.root), null);

  const outside = path.join(fixture.root, "outside.png");
  await writeFile(outside, PNG);
  await rm(path.join(fixture.directory, fixture.fileName));
  await symlink(outside, path.join(fixture.directory, fixture.fileName));
  assert.equal(await readArpeggioReferenceImage(fixture.fileName, fixture.root), null);

  await rm(path.join(fixture.directory, fixture.fileName));
  await mkdir(path.join(fixture.directory, fixture.fileName));
  assert.equal(await readArpeggioReferenceImage(fixture.fileName, fixture.root), null);
});

test("rejects a symlink anywhere in the fixed private-library directory chain", async (t) => {
  const fixture = await createReferenceFixture();
  const linkedRoot = await mkdtemp(path.join(os.tmpdir(), "riff-reference-link-test-"));
  t.after(() => Promise.all([
    rm(fixture.root, { recursive: true, force: true }),
    rm(linkedRoot, { recursive: true, force: true }),
  ]));
  await symlink(path.join(fixture.root, "storage"), path.join(linkedRoot, "storage"));
  assert.equal(await readArpeggioReferenceImage(fixture.fileName, linkedRoot), null);
});

test("rejects malformed or widened manifests", () => {
  assert.equal(parseArpeggioReferenceManifest("not json"), null);
  const widened = JSON.parse(manifestFor("c-maj7-arpeggio-fretboard.png"));
  widened.images[0].fileName = "../private.png";
  assert.equal(parseArpeggioReferenceManifest(JSON.stringify(widened)), null);
  const wrongSource = JSON.parse(manifestFor("c-maj7-arpeggio-fretboard.png"));
  wrongSource.images[0].sourceURL = "https://example.com/c-maj7-arpeggio-fretboard.png";
  assert.equal(parseArpeggioReferenceManifest(JSON.stringify(wrongSource)), null);
});

test("the image route authenticates before lookup and disables storage caches", async () => {
  const routeSource = await import("node:fs/promises").then(({ readFile }) => readFile(
    new URL("../app/api/practice-reference/arpeggios/[fileName]/route.ts", import.meta.url),
    "utf8",
  ));
  const authentication = routeSource.indexOf("await requireUser()");
  const lookup = routeSource.indexOf("await readArpeggioReferenceImage(fileName)");
  assert.ok(authentication >= 0 && lookup > authentication);
  assert.match(routeSource, /private, no-store, max-age=0/);
  assert.match(routeSource, /Cross-Origin-Resource-Policy.*same-origin/);
  assert.match(routeSource, /X-Content-Type-Options.*nosniff/);
});
