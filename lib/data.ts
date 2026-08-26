import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { isAllowedAlbumCover } from "@/lib/album-covers";
import {
  buildRiffSqlFilter,
  type RiffFilterInput,
} from "@/lib/riff-query";
import { normalizeTagName } from "@/lib/tags";
import type {
  Album,
  CompSegment,
  Riff,
  RiffMarker,
  RiffTrack,
  Tag,
  TagSummary,
  Take,
  YouTubeBackingSource,
} from "@/types/domain";
import { canonicalYouTubeUrl } from "@/lib/youtube-backing";

type AlbumRow = {
  id: string;
  name: string;
  description: string;
  color: string;
  cover_asset: string | null;
  riff_count: string | number;
  revision: number;
  created_at: Date | string;
  updated_at: Date | string;
};

type RiffRow = {
  id: string;
  album_id: string | null;
  title: string;
  bpm: number;
  musical_key: string;
  tuning: string;
  time_signature: string;
  notes: string;
  tab: string;
  tags: unknown;
  take_count: string | number;
  primary_take_id: string | null;
  is_favorite: boolean;
  deleted_at: Date | string | null;
  metadata_revision: number;
  created_at: Date | string;
  updated_at: Date | string;
};

type TagRow = {
  id: string;
  name: string;
  usage_count?: string | number;
};

type TakeRow = {
  id: string;
  riff_id: string;
  take_no: number;
  name: string;
  duration_ms: number | null;
  trim_start_ms: number;
  trim_end_ms: number | null;
  offset_ms: number;
  mime_type: string;
  byte_size: string | number;
  is_primary: boolean;
  revision: number;
  created_at: Date | string;
};

type TrackRow = {
  id: string;
  riff_id: string;
  kind: "guitar" | "backing";
  name: string;
  duration_ms: number | null;
  offset_ms: number;
  volume: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  fade_in_ms: number;
  fade_out_ms: number;
  mime_type: string;
  byte_size: string | number;
  revision: number;
  client_request_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export type YouTubeBackingRow = {
  id: string;
  riff_id: string;
  video_id: string;
  name: string;
  source_start_ms: number;
  volume: number;
  sync_enabled: boolean;
  revision: number;
  created_at: Date | string;
  updated_at: Date | string;
};

type CompSegmentRow = {
  id: string;
  riff_id: string;
  take_id: string;
  start_ms: number;
  end_ms: number;
  sort_order: number;
};

type MarkerRow = {
  id: string;
  riff_id: string;
  position_ms: number;
  label: string;
  color: RiffMarker["color"];
  sort_order: number;
  revision: number;
  client_request_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapTagValue(value: unknown): Tag[] {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item): Tag[] => {
    if (!item || typeof item !== "object") return [];
    const { id, name } = item as { id?: unknown; name?: unknown };
    return typeof id === "string" && typeof name === "string" ? [{ id, name }] : [];
  });
}

export function mapTag(row: TagRow): Tag {
  return { id: row.id, name: row.name };
}

export function mapAlbum(row: AlbumRow): Album {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    color: row.color,
    coverAsset: isAllowedAlbumCover(row.cover_asset) ? row.cover_asset : null,
    riffCount: Number(row.riff_count),
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function mapRiff(row: RiffRow): Riff {
  return {
    id: row.id,
    albumId: row.album_id,
    title: row.title,
    bpm: row.bpm,
    musicalKey: row.musical_key,
    tuning: row.tuning,
    timeSignature: row.time_signature,
    notes: row.notes,
    tab: row.tab,
    tags: mapTagValue(row.tags),
    takeCount: Number(row.take_count),
    primaryTakeId: row.primary_take_id,
    isFavorite: row.is_favorite,
    deletedAt: row.deleted_at ? iso(row.deleted_at) : null,
    revision: row.metadata_revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function mapTake(row: TakeRow): Take {
  return {
    id: row.id,
    riffId: row.riff_id,
    takeNo: row.take_no,
    name: row.name,
    durationMs: row.duration_ms,
    trimStartMs: row.trim_start_ms,
    trimEndMs: row.trim_end_ms,
    offsetMs: row.offset_ms,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size),
    isPrimary: row.is_primary,
    revision: row.revision,
    createdAt: iso(row.created_at),
    audioUrl: `/api/takes/${row.id}/audio`,
  };
}

export function mapTrack(row: TrackRow): RiffTrack {
  return {
    id: row.id,
    riffId: row.riff_id,
    kind: row.kind,
    name: row.name,
    durationMs: row.duration_ms,
    offsetMs: row.offset_ms,
    volume: row.volume,
    pan: row.pan,
    muted: row.muted,
    solo: row.solo,
    fadeInMs: row.fade_in_ms,
    fadeOutMs: row.fade_out_ms,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size),
    revision: row.revision,
    clientRequestId: row.client_request_id,
    audioUrl: `/api/tracks/${row.id}/audio`,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function mapYouTubeBacking(
  row: YouTubeBackingRow,
): YouTubeBackingSource {
  return {
    id: row.id,
    riffId: row.riff_id,
    videoId: row.video_id,
    url: canonicalYouTubeUrl(row.video_id),
    name: row.name,
    sourceStartMs: row.source_start_ms,
    volume: row.volume,
    syncEnabled: row.sync_enabled,
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function mapCompSegment(row: CompSegmentRow): CompSegment {
  return {
    id: row.id,
    riffId: row.riff_id,
    takeId: row.take_id,
    startMs: row.start_ms,
    endMs: row.end_ms,
    sortOrder: row.sort_order,
  };
}

export function mapMarker(row: MarkerRow): RiffMarker {
  return {
    id: row.id,
    riffId: row.riff_id,
    positionMs: row.position_ms,
    label: row.label,
    color: row.color,
    sortOrder: row.sort_order,
    revision: row.revision,
    clientRequestId: row.client_request_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export async function hasAppUser(): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM app_user WHERE id = 1) AS exists",
  );
  return result.rows[0]?.exists ?? false;
}

export { getCurrentUser };

export async function listAlbums(): Promise<Album[]> {
  const result = await db.query<AlbumRow>(
    `SELECT a.id, a.name, a.description, a.color, a.cover_asset,
            count(r.id) AS riff_count, a.revision, a.created_at, a.updated_at
       FROM album a
       LEFT JOIN riff r ON r.album_id = a.id AND r.deleted_at IS NULL
      GROUP BY a.id
      ORDER BY a.sort_order, a.created_at`,
  );
  return result.rows.map(mapAlbum);
}

export async function getAlbumById(id: string): Promise<Album | null> {
  const result = await db.query<AlbumRow>(
    `SELECT a.id, a.name, a.description, a.color, a.cover_asset,
            count(r.id) AS riff_count, a.revision, a.created_at, a.updated_at
       FROM album a
       LEFT JOIN riff r ON r.album_id = a.id AND r.deleted_at IS NULL
      WHERE a.id = $1
      GROUP BY a.id`,
    [id],
  );
  return result.rows[0] ? mapAlbum(result.rows[0]) : null;
}

export type RiffListOptions = {
  albumId?: string | null;
  limit?: number;
  favoriteOnly?: boolean;
  deletedOnly?: boolean;
  search?: string;
  tagName?: string;
};

function riffFilterInput(options?: RiffListOptions): RiffFilterInput {
  return {
    ...(options && "albumId" in options
      ? { albumId: options.albumId ?? null }
      : {}),
    favoriteOnly: options?.favoriteOnly,
    deletedOnly: options?.deletedOnly,
    search: options?.search,
    normalizedTag: options?.tagName
      ? normalizeTagName(options.tagName)
      : "",
  };
}

export async function countRiffs(options?: RiffListOptions): Promise<number> {
  const { values, where } = buildRiffSqlFilter(riffFilterInput(options));
  const result = await db.query<{ total: number }>(
    `SELECT count(*)::integer AS total
       FROM riff r
      WHERE ${where.join(" AND ")}`,
    values,
  );
  return result.rows[0]?.total ?? 0;
}

export async function listRiffAlbumIds(
  options?: RiffListOptions,
): Promise<string[]> {
  const { values, where } = buildRiffSqlFilter(riffFilterInput(options));
  const result = await db.query<{ album_id: string }>(
    `SELECT DISTINCT r.album_id
       FROM riff r
      WHERE ${where.join(" AND ")}
        AND r.album_id IS NOT NULL
      ORDER BY r.album_id`,
    values,
  );
  return result.rows.map((row) => row.album_id);
}

export async function listRiffs(options?: RiffListOptions): Promise<Riff[]> {
  const { values, where } = buildRiffSqlFilter(riffFilterInput(options));
  values.push(options?.limit ?? 100);

  const result = await db.query<RiffRow>(
    `SELECT r.id, r.album_id, r.title, r.bpm, r.musical_key, r.tuning,
            r.time_signature, r.notes, r.tab,
            COALESCE((
              SELECT jsonb_agg(
                       jsonb_build_object('id', listed_tag.id, 'name', listed_tag.name)
                       ORDER BY listed_tag.normalized_name
                     )
                FROM riff_tag listed_riff_tag
                JOIN tag listed_tag ON listed_tag.id = listed_riff_tag.tag_id
               WHERE listed_riff_tag.riff_id = r.id
            ), '[]'::jsonb) AS tags,
            count(t.id) AS take_count,
            max(t.id::text) FILTER (WHERE t.is_primary)::uuid AS primary_take_id,
            r.is_favorite, r.deleted_at, r.metadata_revision,
            r.created_at, r.updated_at
       FROM riff r
       LEFT JOIN take_recording t ON t.riff_id = r.id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      GROUP BY r.id
      ORDER BY r.updated_at DESC
      LIMIT $${values.length}`,
    values,
  );
  return result.rows.map(mapRiff);
}

export async function getRiffById(
  id: string,
  options?: { includeDeleted?: boolean },
): Promise<Riff | null> {
  const result = await db.query<RiffRow>(
    `SELECT r.id, r.album_id, r.title, r.bpm, r.musical_key, r.tuning,
            r.time_signature, r.notes, r.tab,
            COALESCE((
              SELECT jsonb_agg(
                       jsonb_build_object('id', listed_tag.id, 'name', listed_tag.name)
                       ORDER BY listed_tag.normalized_name
                     )
                FROM riff_tag listed_riff_tag
                JOIN tag listed_tag ON listed_tag.id = listed_riff_tag.tag_id
               WHERE listed_riff_tag.riff_id = r.id
            ), '[]'::jsonb) AS tags,
            count(t.id) AS take_count,
            max(t.id::text) FILTER (WHERE t.is_primary)::uuid AS primary_take_id,
            r.is_favorite, r.deleted_at, r.metadata_revision,
            r.created_at, r.updated_at
       FROM riff r
       LEFT JOIN take_recording t ON t.riff_id = r.id
      WHERE r.id = $1${options?.includeDeleted ? "" : " AND r.deleted_at IS NULL"}
      GROUP BY r.id`,
    [id],
  );
  return result.rows[0] ? mapRiff(result.rows[0]) : null;
}

export async function getRiffTags(riffId: string): Promise<Tag[]> {
  const result = await db.query<TagRow>(
    `SELECT tag.id, tag.name
       FROM riff_tag
       JOIN tag ON tag.id = riff_tag.tag_id
      WHERE riff_tag.riff_id = $1
      ORDER BY tag.normalized_name`,
    [riffId],
  );
  return result.rows.map(mapTag);
}

export async function listTags(options?: {
  search?: string;
  limit?: number;
}): Promise<TagSummary[]> {
  const values: unknown[] = [];
  let where = "";
  const searchTerm = options?.search?.trim().replace(/^#+/, "");
  if (searchTerm) {
    values.push(`%${searchTerm.replace(/[\\%_]/g, "\\$&")}%`);
    where = `WHERE tag.name ILIKE $${values.length} ESCAPE E'\\\\'`;
  }
  values.push(options?.limit ?? 100);
  const result = await db.query<TagRow>(
    `SELECT tag.id, tag.name, count(riff.id) AS usage_count
       FROM tag
       LEFT JOIN riff_tag ON riff_tag.tag_id = tag.id
       LEFT JOIN riff ON riff.id = riff_tag.riff_id AND riff.deleted_at IS NULL
       ${where}
      GROUP BY tag.id
      ORDER BY count(riff.id) DESC, tag.normalized_name
      LIMIT $${values.length}`,
    values,
  );
  return result.rows.map((row) => ({
    ...mapTag(row),
    usageCount: Number(row.usage_count ?? 0),
  }));
}

export async function listTakes(riffId: string): Promise<Take[]> {
  const result = await db.query<TakeRow>(
    `SELECT id, riff_id, take_no, name, duration_ms, trim_start_ms,
            trim_end_ms, offset_ms, mime_type,
            byte_size, is_primary, revision, created_at
       FROM take_recording
      WHERE riff_id = $1
      ORDER BY take_no DESC`,
    [riffId],
  );
  return result.rows.map(mapTake);
}

export async function listTracks(riffId: string): Promise<RiffTrack[]> {
  const result = await db.query<TrackRow>(
    `SELECT id, riff_id, kind, name, duration_ms, offset_ms, volume, pan, muted, solo,
            fade_in_ms, fade_out_ms, mime_type, byte_size, revision,
            client_request_id, created_at, updated_at
       FROM riff_track
      WHERE riff_id = $1
      ORDER BY created_at`,
    [riffId],
  );
  return result.rows.map(mapTrack);
}

export async function getYouTubeBacking(
  riffId: string,
): Promise<YouTubeBackingSource | null> {
  const result = await db.query<YouTubeBackingRow>(
    `SELECT id, riff_id, video_id, name, source_start_ms, volume,
            sync_enabled, revision,
            created_at, updated_at
       FROM riff_youtube_backing
      WHERE riff_id = $1`,
    [riffId],
  );
  return result.rows[0] ? mapYouTubeBacking(result.rows[0]) : null;
}

export async function getCompSegments(riffId: string): Promise<CompSegment[]> {
  const result = await db.query<CompSegmentRow>(
    `SELECT id, riff_id, take_id, start_ms, end_ms, sort_order
       FROM comp_segment
      WHERE riff_id = $1
      ORDER BY sort_order`,
    [riffId],
  );
  return result.rows.map(mapCompSegment);
}

export async function listRiffMarkers(riffId: string): Promise<RiffMarker[]> {
  const result = await db.query<MarkerRow>(
    `SELECT id, riff_id, position_ms, label, color, sort_order, revision,
            client_request_id,
            created_at, updated_at
       FROM riff_marker
      WHERE riff_id = $1
      ORDER BY position_ms, sort_order, id`,
    [riffId],
  );
  return result.rows.map(mapMarker);
}

export async function listHomeData() {
  const [albums, recentRiffs] = await Promise.all([
    listAlbums(),
    listRiffs({ limit: 12 }),
  ]);
  return { albums, recentRiffs };
}

export async function getAppUserProfile(): Promise<{
  username: string;
  displayName: string;
} | null> {
  const result = await db.query<{ username: string; display_name: string }>(
    "SELECT username, display_name FROM app_user WHERE id = 1",
  );
  const row = result.rows[0];
  return row ? { username: row.username, displayName: row.display_name } : null;
}
