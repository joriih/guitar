ALTER TABLE riff_track
  ADD COLUMN IF NOT EXISTS client_request_id uuid;

ALTER TABLE riff_track
  ADD COLUMN IF NOT EXISTS client_request_fingerprint varchar(64);

ALTER TABLE riff_marker
  ADD COLUMN IF NOT EXISTS client_request_id uuid;

ALTER TABLE riff_marker
  ADD COLUMN IF NOT EXISTS client_request_fingerprint varchar(64);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'riff_track_client_request_pair'
       AND conrelid = 'riff_track'::regclass
  ) THEN
    ALTER TABLE riff_track
      ADD CONSTRAINT riff_track_client_request_pair
      CHECK (
        (client_request_id IS NULL) = (client_request_fingerprint IS NULL)
        AND (
          client_request_fingerprint IS NULL
          OR client_request_fingerprint ~ '^[0-9a-f]{64}$'
        )
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'riff_marker_client_request_pair'
       AND conrelid = 'riff_marker'::regclass
  ) THEN
    ALTER TABLE riff_marker
      ADD CONSTRAINT riff_marker_client_request_pair
      CHECK (
        (client_request_id IS NULL) = (client_request_fingerprint IS NULL)
        AND (
          client_request_fingerprint IS NULL
          OR client_request_fingerprint ~ '^[0-9a-f]{64}$'
        )
      ) NOT VALID;
  END IF;
END
$$;

ALTER TABLE riff_track
  VALIDATE CONSTRAINT riff_track_client_request_pair;

ALTER TABLE riff_marker
  VALIDATE CONSTRAINT riff_marker_client_request_pair;

CREATE UNIQUE INDEX IF NOT EXISTS riff_track_client_request_id_idx
  ON riff_track (riff_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS riff_marker_client_request_id_idx
  ON riff_marker (riff_id, client_request_id)
  WHERE client_request_id IS NOT NULL;
