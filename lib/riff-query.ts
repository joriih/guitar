export type RiffFilterInput = {
  albumId?: string | null;
  favoriteOnly?: boolean;
  deletedOnly?: boolean;
  search?: string;
  normalizedTag?: string;
};

export type RiffSqlFilter = {
  values: unknown[];
  where: string[];
};

export function buildRiffSqlFilter(
  options: RiffFilterInput = {},
): RiffSqlFilter {
  const values: unknown[] = [];
  const where: string[] = [];
  if ("albumId" in options) {
    values.push(options.albumId ?? null);
    where.push(`r.album_id IS NOT DISTINCT FROM $${values.length}::uuid`);
  }
  where.push(
    options.deletedOnly
      ? "r.deleted_at IS NOT NULL"
      : "r.deleted_at IS NULL",
  );
  if (options.favoriteOnly) where.push("r.is_favorite = true");

  const searchTerm = options.search?.trim().replace(/^#+/, "");
  if (searchTerm) {
    const escaped = searchTerm.replace(/[\\%_]/g, "\\$&");
    values.push(`%${escaped}%`);
    const parameter = `$${values.length}`;
    where.push(`(
      r.title ILIKE ${parameter} ESCAPE E'\\\\'
      OR r.musical_key ILIKE ${parameter} ESCAPE E'\\\\'
      OR EXISTS (
        SELECT 1 FROM album search_album
         WHERE search_album.id = r.album_id
           AND search_album.name ILIKE ${parameter} ESCAPE E'\\\\'
      )
      OR EXISTS (
        SELECT 1
          FROM riff_tag search_riff_tag
          JOIN tag search_tag ON search_tag.id = search_riff_tag.tag_id
         WHERE search_riff_tag.riff_id = r.id
           AND search_tag.name ILIKE ${parameter} ESCAPE E'\\\\'
      )
    )`);
  }

  const normalizedTag = options.normalizedTag?.trim() ?? "";
  if (normalizedTag) {
    values.push(normalizedTag);
    where.push(`EXISTS (
      SELECT 1
        FROM riff_tag filter_riff_tag
        JOIN tag filter_tag ON filter_tag.id = filter_riff_tag.tag_id
       WHERE filter_riff_tag.riff_id = r.id
         AND filter_tag.normalized_name = $${values.length}
    )`);
  }

  return { values, where };
}
