CREATE TABLE IF NOT EXISTS audio_cleanup_queue (
  storage_path varchar(255) PRIMARY KEY CHECK (
    storage_path ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(webm|ogg|wav|aiff|mp3|m4a|aac|flac|opus)$'
  ),
  queued_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error varchar(64)
);

CREATE INDEX IF NOT EXISTS audio_cleanup_queue_queued_at_idx
  ON audio_cleanup_queue (queued_at, storage_path);

ALTER TABLE take_recording
  ADD COLUMN IF NOT EXISTS duplicate_request_id uuid;

ALTER TABLE take_recording
  ADD COLUMN IF NOT EXISTS duplicate_source_take_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'take_recording_duplicate_request_pair'
       AND conrelid = 'take_recording'::regclass
  ) THEN
    ALTER TABLE take_recording
      ADD CONSTRAINT take_recording_duplicate_request_pair
      CHECK (
        (duplicate_request_id IS NULL) = (duplicate_source_take_id IS NULL)
      ) NOT VALID;
  END IF;
END
$$;

ALTER TABLE take_recording
  VALIDATE CONSTRAINT take_recording_duplicate_request_pair;

CREATE UNIQUE INDEX IF NOT EXISTS take_recording_duplicate_request_id_idx
  ON take_recording (duplicate_request_id)
  WHERE duplicate_request_id IS NOT NULL;
