import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Pool } from "pg";

import {
  assertLoopbackDatabaseUrl,
  resolvePostgresAdminUsername,
} from "./local-database-url.mjs";
import { acquireOperationLock } from "./operation-lock.mjs";
import { assertNoIncompleteRestoreState } from "./restore-state.mjs";

function loadLocalEnv() {
  const envPath = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return;
  fs.chmodSync(envPath, 0o600);

  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadLocalEnv();

const DATABASE_NAME = "riff_sketchbook";
const APP_ROLE = "riff_sketchbook_app";
const databaseUrl =
  process.env.DATABASE_URL ??
  `postgresql://${APP_ROLE}@127.0.0.1:5432/${DATABASE_NAME}`;

const targetUrl = assertLoopbackDatabaseUrl(databaseUrl);
if (
  targetUrl.pathname.slice(1) !== DATABASE_NAME ||
  decodeURIComponent(targetUrl.username) !== APP_ROLE
) {
  throw new Error(
    `DATABASE_URL must use database ${DATABASE_NAME} and role ${APP_ROLE}.`,
  );
}

const parentToken = process.env.RIFF_OPERATION_PARENT_TOKEN;
delete process.env.RIFF_OPERATION_PARENT_TOKEN;
const operationLock = await acquireOperationLock("doctor", {
  root: process.cwd(),
  ...(parentToken ? { parentToken } : {}),
});
try {
if (!parentToken) {
  // Standalone schema initialization must not race a restore generation. A
  // parent-owned invocation is already serialized by its inherited lease and
  // may legitimately run while that restore's durable journal exists.
  await assertNoIncompleteRestoreState(process.cwd());
}

const audioStorageDirectory = path.join(process.cwd(), "storage", "audio");
fs.mkdirSync(audioStorageDirectory, { recursive: true, mode: 0o700 });
const audioStorageStat = fs.lstatSync(audioStorageDirectory);
if (!audioStorageStat.isDirectory() || audioStorageStat.isSymbolicLink()) {
  throw new Error("Audio storage must be a safe local directory.");
}
fs.chmodSync(audioStorageDirectory, 0o700);

const adminUrl = process.env.PG_ADMIN_URL
  ? assertLoopbackDatabaseUrl(process.env.PG_ADMIN_URL, "PG_ADMIN_URL")
  : new URL(databaseUrl);
adminUrl.pathname = "/postgres";
if (process.env.PG_ADMIN_URL) {
  if (process.env.PG_ADMIN_USER) adminUrl.username = process.env.PG_ADMIN_USER;
  if (process.env.PG_ADMIN_PASSWORD !== undefined) {
    adminUrl.password = process.env.PG_ADMIN_PASSWORD;
  }
} else {
  adminUrl.username = resolvePostgresAdminUsername(process.env);
  adminUrl.password = process.env.PG_ADMIN_PASSWORD ?? "";
}

const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });

try {
  const role = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [
    APP_ROLE,
  ]);
  if (role.rowCount === 0) {
    await admin.query(
      `CREATE ROLE riff_sketchbook_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    );
  } else {
    await admin.query(
      `ALTER ROLE riff_sketchbook_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    );
  }

  const database = await admin.query(
    "SELECT 1 FROM pg_database WHERE datname = $1",
    [DATABASE_NAME],
  );
  if (database.rowCount === 0) {
    await admin.query(
      `CREATE DATABASE riff_sketchbook OWNER riff_sketchbook_app ENCODING 'UTF8' TEMPLATE template0`,
    );
  }
  await admin.query(`REVOKE ALL ON DATABASE riff_sketchbook FROM PUBLIC`);
  await admin.query(
    `GRANT CONNECT, TEMPORARY ON DATABASE riff_sketchbook TO riff_sketchbook_app`,
  );
} finally {
  await admin.end();
}

const app = new Pool({ connectionString: targetUrl.toString(), max: 1 });

try {
  await app.query("BEGIN");
  await app.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
  await app.query(
    `GRANT USAGE, CREATE ON SCHEMA public TO riff_sketchbook_app`,
  );

  await app.query(`
    CREATE TABLE IF NOT EXISTS app_user (
      id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      username varchar(40) NOT NULL UNIQUE,
      display_name varchar(40) NOT NULL,
      password_hash text NOT NULL,
      revision integer NOT NULL DEFAULT 0
        CONSTRAINT app_user_revision_nonnegative CHECK (revision >= 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await app.query(
    `ALTER TABLE app_user
       ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0`,
  );
  await app.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'app_user'::regclass
           AND conname = 'app_user_revision_nonnegative'
      ) THEN
        ALTER TABLE app_user
          ADD CONSTRAINT app_user_revision_nonnegative
          CHECK (revision >= 0) NOT VALID;
      END IF;
      ALTER TABLE app_user VALIDATE CONSTRAINT app_user_revision_nonnegative;
    END
    $$
  `);

  await app.query(`
    CREATE TABLE IF NOT EXISTS app_session (
      token_digest bytea PRIMARY KEY,
      user_id smallint NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL
    )
  `);
  await app.query(
    `CREATE INDEX IF NOT EXISTS app_session_expires_at_idx ON app_session (expires_at)`,
  );

  await app.query(`
    CREATE TABLE IF NOT EXISTS password_change_request (
      request_id uuid PRIMARY KEY,
      user_id smallint NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
      payload_hash text NOT NULL,
      previous_session_digest bytea NOT NULL CHECK (
        octet_length(previous_session_digest) = 32
      ),
      session_token_ciphertext bytea NOT NULL,
      session_token_iv bytea NOT NULL
        CONSTRAINT password_change_request_iv_length CHECK (
          octet_length(session_token_iv) = 12
        ),
      session_token_tag bytea NOT NULL
        CONSTRAINT password_change_request_tag_length CHECK (
          octet_length(session_token_tag) = 16
        ),
      expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
      superseded_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await app.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS password_change_request_one_active_user_idx
       ON password_change_request (user_id)
       WHERE superseded_at IS NULL`,
  );

  await app.query(`
    CREATE TABLE IF NOT EXISTS album (
      id uuid PRIMARY KEY,
      name varchar(80) NOT NULL,
      description varchar(500) NOT NULL DEFAULT '',
      color char(7) NOT NULL DEFAULT '#D9D2C3' CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
      cover_asset varchar(500) CONSTRAINT album_cover_asset_allowed CHECK (
        cover_asset IS NULL OR cover_asset IN (
          '/assets/guitars/olympic-white.avif',
          '/assets/guitars/candy-apple-red.avif',
          '/assets/guitars/aged-surf-green.avif',
          '/assets/guitars/black-guard.avif',
          '/assets/guitars/sonic-blue.avif',
          '/assets/guitars/vintage-sunburst.webp'
        )
      ),
      sort_order integer NOT NULL DEFAULT 0,
      revision integer NOT NULL DEFAULT 0
        CONSTRAINT album_revision_nonnegative CHECK (revision >= 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await app.query(
    `ALTER TABLE album ADD COLUMN IF NOT EXISTS cover_asset varchar(500)`,
  );
  await app.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'album'::regclass
           AND conname = 'album_cover_asset_allowed'
      ) THEN
        ALTER TABLE album
          ADD CONSTRAINT album_cover_asset_allowed CHECK (
            cover_asset IS NULL OR cover_asset IN (
              '/assets/guitars/olympic-white.avif',
              '/assets/guitars/candy-apple-red.avif',
              '/assets/guitars/aged-surf-green.avif',
              '/assets/guitars/black-guard.avif',
              '/assets/guitars/sonic-blue.avif',
              '/assets/guitars/vintage-sunburst.webp'
            )
          ) NOT VALID;
      END IF;
      IF NOT EXISTS (
        SELECT 1
          FROM album
         WHERE cover_asset IS NOT NULL
           AND cover_asset NOT IN (
             '/assets/guitars/olympic-white.avif',
             '/assets/guitars/candy-apple-red.avif',
             '/assets/guitars/aged-surf-green.avif',
             '/assets/guitars/black-guard.avif',
             '/assets/guitars/sonic-blue.avif',
             '/assets/guitars/vintage-sunburst.webp'
           )
      ) THEN
        ALTER TABLE album VALIDATE CONSTRAINT album_cover_asset_allowed;
      END IF;
    END
    $$
  `);

  await app.query(`
    CREATE TABLE IF NOT EXISTS riff (
      id uuid PRIMARY KEY,
      album_id uuid REFERENCES album(id) ON DELETE SET NULL,
      title varchar(120) NOT NULL,
      bpm smallint NOT NULL DEFAULT 120 CHECK (bpm BETWEEN 30 AND 300),
      musical_key varchar(20) NOT NULL DEFAULT 'E minor',
      tuning varchar(40) NOT NULL DEFAULT 'E A D G B E',
      time_signature varchar(12) NOT NULL DEFAULT '4/4',
      notes text NOT NULL DEFAULT '',
      tab text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await app.query(
    `CREATE INDEX IF NOT EXISTS riff_album_id_idx ON riff (album_id)`,
  );
  await app.query(
    `CREATE INDEX IF NOT EXISTS riff_updated_at_idx ON riff (updated_at DESC)`,
  );
  await app.query(
    `ALTER TABLE riff ADD COLUMN IF NOT EXISTS is_favorite boolean NOT NULL DEFAULT false`,
  );
  await app.query(
    `ALTER TABLE riff ADD COLUMN IF NOT EXISTS deleted_at timestamptz`,
  );
  await app.query(
    `CREATE INDEX IF NOT EXISTS riff_favorite_idx ON riff (updated_at DESC) WHERE is_favorite AND deleted_at IS NULL`,
  );
  await app.query(
    `CREATE INDEX IF NOT EXISTS riff_deleted_at_idx ON riff (deleted_at DESC) WHERE deleted_at IS NOT NULL`,
  );

  await app.query(`
    CREATE TABLE IF NOT EXISTS library_create_request (
      operation varchar(16) NOT NULL CHECK (
        operation IN ('album_create', 'riff_create')
      ),
      request_id uuid NOT NULL,
      payload_sha256 char(64) NOT NULL CHECK (
        payload_sha256 ~ '^[0-9a-f]{64}$'
      ),
      resource_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (operation, request_id),
      UNIQUE (operation, resource_id)
    )
  `);

  await app.query(`
    CREATE TABLE IF NOT EXISTS tag (
      id uuid PRIMARY KEY,
      name varchar(32) NOT NULL CHECK (
        char_length(name) BETWEEN 1 AND 32 AND btrim(name) = name
      ),
      normalized_name varchar(64) NOT NULL UNIQUE CHECK (
        char_length(normalized_name) BETWEEN 1 AND 64 AND btrim(normalized_name) = normalized_name
      ),
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await app.query(`
    CREATE TABLE IF NOT EXISTS riff_tag (
      riff_id uuid NOT NULL REFERENCES riff(id) ON DELETE CASCADE,
      tag_id uuid NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (riff_id, tag_id)
    )
  `);
  await app.query(
    `CREATE INDEX IF NOT EXISTS riff_tag_tag_id_idx ON riff_tag (tag_id, riff_id)`,
  );

  await app.query(`
    CREATE TABLE IF NOT EXISTS take_recording (
      id uuid PRIMARY KEY,
      riff_id uuid NOT NULL REFERENCES riff(id) ON DELETE CASCADE,
      take_no integer NOT NULL CHECK (take_no > 0),
      name varchar(120) NOT NULL,
      storage_path varchar(255) NOT NULL UNIQUE,
      original_file_name varchar(255) NOT NULL,
      mime_type varchar(100) NOT NULL,
      byte_size bigint NOT NULL CHECK (byte_size > 0),
      duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
      trim_start_ms integer NOT NULL DEFAULT 0 CHECK (trim_start_ms >= 0),
      trim_end_ms integer CHECK (trim_end_ms IS NULL OR trim_end_ms > trim_start_ms),
      offset_ms integer NOT NULL DEFAULT 0 CHECK (offset_ms >= 0),
      is_primary boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (riff_id, take_no)
    )
  `);
  await app.query(
    `ALTER TABLE take_recording ADD COLUMN IF NOT EXISTS trim_start_ms integer NOT NULL DEFAULT 0`,
  );
  await app.query(
    `ALTER TABLE take_recording ADD COLUMN IF NOT EXISTS trim_end_ms integer`,
  );
  await app.query(
    `ALTER TABLE take_recording ADD COLUMN IF NOT EXISTS offset_ms integer NOT NULL DEFAULT 0`,
  );
  await app.query(
    `CREATE INDEX IF NOT EXISTS take_recording_riff_id_idx ON take_recording (riff_id, take_no DESC)`,
  );
  await app.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS take_recording_one_primary_idx
       ON take_recording (riff_id) WHERE is_primary`,
  );

  await app.query(`
    CREATE TABLE IF NOT EXISTS riff_track (
      id uuid PRIMARY KEY,
      riff_id uuid NOT NULL REFERENCES riff(id) ON DELETE CASCADE,
      kind varchar(12) NOT NULL CHECK (kind IN ('guitar', 'backing')),
      name varchar(120) NOT NULL,
      storage_path varchar(255) NOT NULL UNIQUE,
      original_file_name varchar(255) NOT NULL,
      mime_type varchar(100) NOT NULL,
      byte_size bigint NOT NULL CHECK (byte_size > 0),
      duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
      offset_ms integer NOT NULL DEFAULT 0 CHECK (offset_ms >= 0),
      volume real NOT NULL DEFAULT 1 CHECK (volume BETWEEN 0 AND 2),
      pan real NOT NULL DEFAULT 0 CHECK (pan BETWEEN -1 AND 1),
      muted boolean NOT NULL DEFAULT false,
      solo boolean NOT NULL DEFAULT false,
      fade_in_ms integer NOT NULL DEFAULT 0 CHECK (fade_in_ms >= 0),
      fade_out_ms integer NOT NULL DEFAULT 0 CHECK (fade_out_ms >= 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await app.query(
    `ALTER TABLE riff_track ADD COLUMN IF NOT EXISTS muted boolean NOT NULL DEFAULT false`,
  );
  await app.query(
    `ALTER TABLE riff_track ADD COLUMN IF NOT EXISTS solo boolean NOT NULL DEFAULT false`,
  );
  await app.query(
    `CREATE INDEX IF NOT EXISTS riff_track_riff_id_idx ON riff_track (riff_id, created_at)`,
  );

  await app.query(`
    CREATE TABLE IF NOT EXISTS riff_youtube_backing (
      id uuid PRIMARY KEY,
      riff_id uuid NOT NULL UNIQUE REFERENCES riff(id) ON DELETE CASCADE,
      video_id varchar(11) NOT NULL CHECK (video_id ~ '^[A-Za-z0-9_-]{11}$'),
      name varchar(120) NOT NULL CHECK (
        char_length(name) BETWEEN 1 AND 120 AND btrim(name) = name
      ),
      source_start_ms integer NOT NULL DEFAULT 0 CHECK (source_start_ms BETWEEN 0 AND 86400000),
      volume real NOT NULL DEFAULT 1 CHECK (volume BETWEEN 0 AND 1),
      sync_enabled boolean NOT NULL DEFAULT false,
      revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await app.query(
    `CREATE INDEX IF NOT EXISTS riff_youtube_backing_riff_id_idx
       ON riff_youtube_backing (riff_id)`,
  );

  await app.query(`
    CREATE TABLE IF NOT EXISTS comp_segment (
      id uuid PRIMARY KEY,
      riff_id uuid NOT NULL REFERENCES riff(id) ON DELETE CASCADE,
      take_id uuid NOT NULL REFERENCES take_recording(id) ON DELETE CASCADE,
      start_ms integer NOT NULL CHECK (start_ms >= 0),
      end_ms integer NOT NULL CHECK (end_ms > start_ms),
      sort_order integer NOT NULL CHECK (sort_order >= 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (riff_id, sort_order)
    )
  `);
  await app.query(
    `CREATE INDEX IF NOT EXISTS comp_segment_riff_id_idx ON comp_segment (riff_id, sort_order)`,
  );

  await app.query(`
    CREATE TABLE IF NOT EXISTS riff_marker (
      id uuid PRIMARY KEY,
      riff_id uuid NOT NULL REFERENCES riff(id) ON DELETE CASCADE,
      position_ms integer NOT NULL CHECK (position_ms BETWEEN 0 AND 86400000),
      label varchar(32) NOT NULL CHECK (
        char_length(label) BETWEEN 1 AND 32 AND btrim(label) = label
      ),
      color varchar(12) NOT NULL DEFAULT 'rose' CHECK (
        color IN ('rose', 'amber', 'lime', 'sky', 'violet', 'slate')
      ),
      sort_order integer NOT NULL CHECK (sort_order >= 0),
      revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (riff_id, sort_order)
    )
  `);
  await app.query(
    `ALTER TABLE riff_marker ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0`,
  );
  await app.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS riff_marker_riff_order_idx
       ON riff_marker (riff_id, sort_order)`,
  );
  await app.query(
    `CREATE INDEX IF NOT EXISTS riff_marker_timeline_idx
       ON riff_marker (riff_id, position_ms, sort_order)`,
  );

  const migrationsDirectory = path.join(process.cwd(), "scripts", "migrations");
  const migrationFiles = fs.existsSync(migrationsDirectory)
    ? fs
        .readdirSync(migrationsDirectory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /^\d{8}_[a-z0-9_-]+\.sql$/.test(entry.name))
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right))
    : [];
  for (const migrationFile of migrationFiles) {
    const migrationPath = path.join(migrationsDirectory, migrationFile);
    const migrationStat = fs.lstatSync(migrationPath);
    if (!migrationStat.isFile() || migrationStat.isSymbolicLink()) {
      throw new Error(`Unsafe database migration: ${migrationFile}`);
    }
    const migrationSql = fs.readFileSync(migrationPath, "utf8").trim();
    if (!migrationSql) throw new Error(`Empty database migration: ${migrationFile}`);
    await app.query(migrationSql);
  }
  await app.query("COMMIT");
} catch (error) {
  await app.query("ROLLBACK");
  throw error;
} finally {
  await app.end();
}

console.log("riff_sketchbook database is ready.");
} finally {
  await operationLock.release();
}
