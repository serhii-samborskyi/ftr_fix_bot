import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl
});

pool.on('error', (error) => {
  console.error('[postgres] unexpected idle client error', error);
});

export async function query(text, params = []) {
  return pool.query(text, params);
}

export async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function runMigrations() {
  await query('CREATE EXTENSION IF NOT EXISTS pgcrypto');

  await query(`
    CREATE TABLE IF NOT EXISTS settings (
      key text PRIMARY KEY,
      value text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await query(`
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
    )
  `);

  await query('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source_sender_id text');
  await query('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source_sender_username text');
  await query('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source_sender_name text');
  await query('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source_sender_is_bot boolean');

  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS jobs_source_message_uidx
      ON jobs(source_chat_id, source_message_id)
      WHERE source_chat_id IS NOT NULL AND source_message_id IS NOT NULL
  `);
  await query('CREATE INDEX IF NOT EXISTS jobs_created_at_idx ON jobs(created_at DESC)');
  await query('CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status)');
  await query('CREATE INDEX IF NOT EXISTS jobs_normalized_phone_idx ON jobs(normalized_phone)');

  await query(`
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
    )
  `);

  await query('CREATE INDEX IF NOT EXISTS conversations_job_created_idx ON conversations(job_id, created_at)');
  await query('CREATE UNIQUE INDEX IF NOT EXISTS conversations_external_guid_uidx ON conversations(external_guid) WHERE external_guid IS NOT NULL');

  await query(`
    CREATE TABLE IF NOT EXISTS escalations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      reason text NOT NULL,
      status text NOT NULL DEFAULT 'sent',
      telegram_message_id text,
      raw jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await query('CREATE INDEX IF NOT EXISTS escalations_job_created_idx ON escalations(job_id, created_at)');
}

export async function closeDb() {
  await pool.end();
}
