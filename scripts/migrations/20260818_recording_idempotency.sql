ALTER TABLE take_recording
  ADD COLUMN IF NOT EXISTS client_recording_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS take_recording_client_recording_id_idx
  ON take_recording (riff_id, client_recording_id)
  WHERE client_recording_id IS NOT NULL;
