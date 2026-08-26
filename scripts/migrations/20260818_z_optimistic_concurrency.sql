ALTER TABLE riff
  ADD COLUMN IF NOT EXISTS metadata_revision integer NOT NULL DEFAULT 0;

ALTER TABLE riff_track
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0;

ALTER TABLE take_recording
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'riff_metadata_revision_nonnegative'
       AND conrelid = 'riff'::regclass
  ) THEN
    ALTER TABLE riff
      ADD CONSTRAINT riff_metadata_revision_nonnegative
      CHECK (metadata_revision >= 0) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'riff_track_revision_nonnegative'
       AND conrelid = 'riff_track'::regclass
  ) THEN
    ALTER TABLE riff_track
      ADD CONSTRAINT riff_track_revision_nonnegative
      CHECK (revision >= 0) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'take_recording_revision_nonnegative'
       AND conrelid = 'take_recording'::regclass
  ) THEN
    ALTER TABLE take_recording
      ADD CONSTRAINT take_recording_revision_nonnegative
      CHECK (revision >= 0) NOT VALID;
  END IF;
END
$$;

ALTER TABLE riff VALIDATE CONSTRAINT riff_metadata_revision_nonnegative;
ALTER TABLE riff_track VALIDATE CONSTRAINT riff_track_revision_nonnegative;
ALTER TABLE take_recording VALIDATE CONSTRAINT take_recording_revision_nonnegative;
