import { query } from '../db.js';

export const unmatchedTechFilter = 'unmatched';

function normalizeTechPayload(payload = {}) {
  return {
    name: String(payload.name || '').trim(),
    techId: String(payload.techId || payload.tech_id || '').trim(),
    telegramId: String(payload.telegramId || payload.telegram_id || '').trim()
  };
}

function toTechnician(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    techId: row.tech_id,
    telegramId: row.telegram_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function validateTechnician(payload) {
  const tech = normalizeTechPayload(payload);
  if (!tech.name) throw new Error('Technician name is required.');
  if (!tech.techId) throw new Error('Technician ID is required.');
  if (!tech.telegramId) throw new Error('Telegram ID is required.');
  return tech;
}

export async function listTechnicians() {
  const result = await query(`
    SELECT *
    FROM technicians
    ORDER BY lower(name), tech_id
  `);
  return result.rows.map(toTechnician);
}

export async function createTechnician(payload) {
  const tech = validateTechnician(payload);
  const result = await query(
    `
      INSERT INTO technicians(name, tech_id, telegram_id)
      VALUES ($1, $2, $3)
      RETURNING *
    `,
    [tech.name, tech.techId, tech.telegramId]
  );
  return toTechnician(result.rows[0]);
}

export async function updateTechnician(id, payload) {
  const tech = validateTechnician(payload);
  const result = await query(
    `
      UPDATE technicians
      SET name = $2,
          tech_id = $3,
          telegram_id = $4,
          updated_at = now()
      WHERE id = $1
      RETURNING *
    `,
    [id, tech.name, tech.techId, tech.telegramId]
  );
  return toTechnician(result.rows[0]);
}

export async function deleteTechnician(id) {
  const result = await query('DELETE FROM technicians WHERE id = $1 RETURNING *', [id]);
  return toTechnician(result.rows[0]);
}
