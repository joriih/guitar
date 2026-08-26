import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error Node's type-stripping test runner requires the .ts extension.
import { libraryCreatePayloadDigest } from "./library-create-idempotency.ts";

test("library create digests are canonical but operation and payload sensitive", () => {
  const left = libraryCreatePayloadDigest("album_create", {
    name: "Night Drive",
    color: "#ffffff",
    nested: { second: 2, first: 1 },
  });
  const reordered = libraryCreatePayloadDigest("album_create", {
    nested: { first: 1, second: 2 },
    color: "#ffffff",
    name: "Night Drive",
  });
  assert.equal(left, reordered);
  assert.notEqual(
    left,
    libraryCreatePayloadDigest("album_create", {
      name: "Night Drive 2",
      color: "#ffffff",
      nested: { first: 1, second: 2 },
    }),
  );
  assert.notEqual(
    left,
    libraryCreatePayloadDigest("riff_create", {
      name: "Night Drive",
      color: "#ffffff",
      nested: { first: 1, second: 2 },
    }),
  );
});
