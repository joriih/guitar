import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));

async function source(name) {
  return readFile(path.join(directory, name), "utf8");
}

function busyFieldset(contents, label) {
  const opening = '<fieldset className={styles.formFields} disabled={busy}>';
  const start = contents.indexOf(opening);
  assert.notEqual(start, -1, `${label} must use a busy-disabled fieldset`);
  const end = contents.indexOf("</fieldset>", start);
  assert.notEqual(end, -1, `${label} busy fieldset must be closed`);
  return contents.slice(start, end);
}

test("album and riff create/edit forms lock every mutable field while saving", async () => {
  const [editAlbum, newAlbum, newRiff] = await Promise.all([
    source("EditAlbumForm.tsx"),
    source("NewAlbumForm.tsx"),
    source("NewRiffForm.tsx"),
  ]);

  const editFields = busyFieldset(editAlbum, "album edit");
  assert.match(editFields, /name="name"/);
  assert.match(editFields, /name="description"/);
  assert.match(editFields, /name="color"/);
  assert.match(editFields, /<AlbumCoverPicker[\s\S]*disabled=\{busy\}/);

  const newAlbumFields = busyFieldset(newAlbum, "album create");
  assert.match(newAlbumFields, /name="name"/);
  assert.match(newAlbumFields, /name="description"/);
  assert.match(newAlbumFields, /name="color"/);
  assert.match(newAlbumFields, /<AlbumCoverPicker disabled=\{busy\}/);

  const newRiffFields = busyFieldset(newRiff, "riff create");
  assert.match(newRiffFields, /name="title"/);
  assert.match(newRiffFields, /name="albumId"/);

  for (const contents of [editAlbum, newAlbum, newRiff]) {
    assert.match(contents, /aria-busy=\{busy\}/);
    assert.match(contents, /aria-disabled=\{busy\}/);
    assert.match(contents, /if \(busy\) event\.preventDefault\(\)/);
  }

  assert.match(newAlbum, /getOrCreateClientCreateRequest/);
  assert.match(newAlbum, /requestId: createRequest\.requestId/);
  assert.match(newRiff, /getOrCreateClientCreateRequest/);
  assert.match(newRiff, /requestId: createRequest\.requestId/);
});

test("album cover picker exposes native disabled fieldset semantics", async () => {
  const picker = await source("AlbumCoverPicker.tsx");
  assert.match(picker, /disabled\?: boolean/);
  assert.match(picker, /disabled = false/);
  assert.match(picker, /<fieldset[\s\S]*disabled=\{disabled\}/);
});

test("album cover picker keeps a larger catalog compact at phone widths", async () => {
  const styles = await source("AlbumCoverPicker.module.css");
  assert.match(
    styles,
    /\.options\s*\{[^}]*grid-template-columns:\s*repeat\(5, minmax\(0, 1fr\)\)/s,
  );
  assert.match(
    styles,
    /@media \(max-width: 560px\)[\s\S]*?\.options\s*\{[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/s,
  );
  assert.match(
    styles,
    /@media \(max-width: 340px\)[\s\S]*?\.options\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/s,
  );
});
