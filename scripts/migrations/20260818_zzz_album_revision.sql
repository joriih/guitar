ALTER TABLE album
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'album_revision_nonnegative'
       AND conrelid = 'album'::regclass
  ) THEN
    ALTER TABLE album
      ADD CONSTRAINT album_revision_nonnegative
      CHECK (revision >= 0) NOT VALID;
  END IF;
END
$$;

ALTER TABLE album VALIDATE CONSTRAINT album_revision_nonnegative;
