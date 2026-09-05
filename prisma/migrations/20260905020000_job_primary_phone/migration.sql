ALTER TABLE jobs ADD COLUMN IF NOT EXISTS primary_phone text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS normalized_primary_phone text;

CREATE INDEX IF NOT EXISTS jobs_normalized_primary_phone_idx ON jobs(normalized_primary_phone);
