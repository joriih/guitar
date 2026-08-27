ALTER TABLE app_user
  ADD COLUMN IF NOT EXISTS revision integer;

UPDATE app_user
   SET revision = 0
 WHERE revision IS NULL;

ALTER TABLE app_user
  ALTER COLUMN revision SET DEFAULT 0,
  ALTER COLUMN revision SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'app_user_revision_nonnegative'
       AND conrelid = 'app_user'::regclass
  ) THEN
    ALTER TABLE app_user
      ADD CONSTRAINT app_user_revision_nonnegative
      CHECK (revision >= 0) NOT VALID;
  END IF;
END
$$;

ALTER TABLE app_user
  VALIDATE CONSTRAINT app_user_revision_nonnegative;
