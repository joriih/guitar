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
);

CREATE TABLE IF NOT EXISTS password_change_request (
  request_id uuid PRIMARY KEY,
  user_id smallint NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  payload_hash text NOT NULL,
  previous_session_digest bytea NOT NULL CHECK (
    octet_length(previous_session_digest) = 32
  ),
  session_token_ciphertext bytea NOT NULL,
  session_token_iv bytea NOT NULL CHECK (octet_length(session_token_iv) = 12),
  session_token_tag bytea NOT NULL CHECK (octet_length(session_token_tag) = 16),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE password_change_request
  ADD COLUMN IF NOT EXISTS session_token_ciphertext bytea;
ALTER TABLE password_change_request
  ADD COLUMN IF NOT EXISTS session_token_iv bytea;
ALTER TABLE password_change_request
  ADD COLUMN IF NOT EXISTS session_token_tag bytea;

-- Rows written by the pre-encryption development build cannot safely recover
-- the one replacement session and are intentionally ephemeral.
DELETE FROM password_change_request
 WHERE session_token_ciphertext IS NULL
    OR session_token_iv IS NULL
    OR session_token_tag IS NULL;

ALTER TABLE password_change_request
  ALTER COLUMN session_token_ciphertext SET NOT NULL;
ALTER TABLE password_change_request
  ALTER COLUMN session_token_iv SET NOT NULL;
ALTER TABLE password_change_request
  ALTER COLUMN session_token_tag SET NOT NULL;

ALTER TABLE password_change_request
  ALTER COLUMN expires_at SET DEFAULT (now() + interval '15 minutes');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'password_change_request_iv_length'
       AND conrelid = 'password_change_request'::regclass
  ) THEN
    ALTER TABLE password_change_request
      ADD CONSTRAINT password_change_request_iv_length
      CHECK (octet_length(session_token_iv) = 12) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'password_change_request_tag_length'
       AND conrelid = 'password_change_request'::regclass
  ) THEN
    ALTER TABLE password_change_request
      ADD CONSTRAINT password_change_request_tag_length
      CHECK (octet_length(session_token_tag) = 16) NOT VALID;
  END IF;
END
$$;

ALTER TABLE password_change_request
  VALIDATE CONSTRAINT password_change_request_iv_length;
ALTER TABLE password_change_request
  VALIDATE CONSTRAINT password_change_request_tag_length;

CREATE UNIQUE INDEX IF NOT EXISTS password_change_request_one_active_user_idx
  ON password_change_request (user_id)
  WHERE superseded_at IS NULL;
