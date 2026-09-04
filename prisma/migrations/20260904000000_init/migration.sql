CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL DEFAULT 'telegram',
  source_chat_id text,
  source_chat_title text,
  source_message_id text,
  source_sender_id text,
  source_sender_username text,
  source_sender_name text,
  source_sender_is_bot boolean,
  telegram_file_id text,
  image_path text NOT NULL,
  image_mime text,
  status text NOT NULL DEFAULT 'received',
  customer_name text,
  phone text,
  normalized_phone text,
  account_number text,
  address text,
  ocr_text text,
  ocr_confidence numeric,
  ocr_raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  followup_status text NOT NULL DEFAULT 'not_started',
  followup_chat_guid text,
  followup_last_error text,
  escalated_at timestamptz,
  last_contact_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source_sender_id text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source_sender_username text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source_sender_name text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source_sender_is_bot boolean;

CREATE UNIQUE INDEX IF NOT EXISTS jobs_source_message_uidx
  ON jobs(source_chat_id, source_message_id)
  WHERE source_chat_id IS NOT NULL AND source_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS jobs_created_at_idx ON jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status);
CREATE INDEX IF NOT EXISTS jobs_normalized_phone_idx ON jobs(normalized_phone);

CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  channel text NOT NULL DEFAULT 'bluebubbles',
  direction text NOT NULL,
  body text NOT NULL DEFAULT '',
  external_guid text,
  external_chat_guid text,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversations_job_created_idx ON conversations(job_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS conversations_external_guid_uidx
  ON conversations(external_guid)
  WHERE external_guid IS NOT NULL;

CREATE TABLE IF NOT EXISTS escalations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'sent',
  telegram_message_id text,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS escalations_job_created_idx ON escalations(job_id, created_at);
