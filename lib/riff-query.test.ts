import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error Node's type-stripping test runner requires the .ts extension.
import { buildRiffSqlFilter } from "./riff-query.ts";

test("active album and favorite filters share stable parameters", () => {
  const filter = buildRiffSqlFilter({
    albumId: "10000000-0000-4000-8000-000000000001",
    favoriteOnly: true,
  });
  assert.deepEqual(filter.values, ["10000000-0000-4000-8000-000000000001"]);
  assert.deepEqual(filter.where, [
    "r.album_id IS NOT DISTINCT FROM $1::uuid",
    "r.deleted_at IS NULL",
    "r.is_favorite = true",
  ]);
});

test("trashed and unfiled filters preserve the explicit null album", () => {
  const filter = buildRiffSqlFilter({ albumId: null, deletedOnly: true });
  assert.deepEqual(filter.values, [null]);
  assert.deepEqual(filter.where, [
    "r.album_id IS NOT DISTINCT FROM $1::uuid",
    "r.deleted_at IS NOT NULL",
  ]);
});

test("search wildcards are literal and tag parameters follow search", () => {
  const filter = buildRiffSqlFilter({
    search: "  #100%_Clean\\Tone  ",
    normalizedTag: "dream pop",
  });
  assert.deepEqual(filter.values, ["%100\\%\\_Clean\\\\Tone%", "dream pop"]);
  assert.match(filter.where[1] ?? "", /r\.title ILIKE \$1/);
  assert.match(filter.where[1] ?? "", /search_tag\.name ILIKE \$1/);
  assert.match(filter.where[2] ?? "", /filter_tag\.normalized_name = \$2/);
});

test("blank search and tag values do not add accidental filters", () => {
  assert.deepEqual(buildRiffSqlFilter({ search: "###", normalizedTag: "  " }), {
    values: [],
    where: ["r.deleted_at IS NULL"],
  });
});
