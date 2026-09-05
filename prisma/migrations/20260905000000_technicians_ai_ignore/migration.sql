CREATE TABLE IF NOT EXISTS technicians (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  tech_id text NOT NULL UNIQUE,
  telegram_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS technicians_telegram_id_idx ON technicians(telegram_id);

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS ai_ignore boolean NOT NULL DEFAULT false;
