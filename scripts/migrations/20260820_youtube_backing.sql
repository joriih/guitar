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
);

CREATE INDEX IF NOT EXISTS riff_youtube_backing_riff_id_idx
  ON riff_youtube_backing (riff_id);
