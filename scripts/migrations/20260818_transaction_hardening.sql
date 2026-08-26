ALTER TABLE riff
  ADD COLUMN IF NOT EXISTS comp_revision integer NOT NULL DEFAULT 0;

ALTER TABLE riff
  ADD COLUMN IF NOT EXISTS duplicate_request_id uuid;

ALTER TABLE riff
  ADD COLUMN IF NOT EXISTS duplicate_source_riff_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'riff_comp_revision_nonnegative'
       AND conrelid = 'riff'::regclass
  ) THEN
    ALTER TABLE riff
      ADD CONSTRAINT riff_comp_revision_nonnegative
      CHECK (comp_revision >= 0) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'riff_duplicate_request_pair'
       AND conrelid = 'riff'::regclass
  ) THEN
    ALTER TABLE riff
      ADD CONSTRAINT riff_duplicate_request_pair
      CHECK (
        (duplicate_request_id IS NULL) = (duplicate_source_riff_id IS NULL)
      ) NOT VALID;
  END IF;
END
$$;

ALTER TABLE riff VALIDATE CONSTRAINT riff_comp_revision_nonnegative;
ALTER TABLE riff VALIDATE CONSTRAINT riff_duplicate_request_pair;

CREATE UNIQUE INDEX IF NOT EXISTS riff_duplicate_request_id_idx
  ON riff (duplicate_request_id)
  WHERE duplicate_request_id IS NOT NULL;
