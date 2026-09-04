import { query, withTransaction } from '../db.js';
import { getRuntimeSettings } from './settings.js';
import { addWorkerLog } from './workerLogs.js';
import { errorToLogMeta } from '../utils/errors.js';

let botInstance = null;

export function setEscalationTelegramBot(bot) {
  botInstance = bot;
}

function jobValue(job, camelKey, snakeKey = camelKey) {
  return job?.[camelKey] || job?.[snakeKey] || '';
}

function managerMessage(job, reason) {
  return [
    'Customer concern detected',
    '',
    `Name: ${jobValue(job, 'customerName', 'customer_name') || 'Unknown'}`,
    `Phone: ${jobValue(job, 'phone') || jobValue(job, 'normalizedPhone', 'normalized_phone') || 'Unknown'}`,
    `Account #: ${jobValue(job, 'accountNumber', 'account_number') || 'Unknown'}`,
    `Address: ${jobValue(job, 'address') || 'Unknown'}`,
    '',
    `Concern: ${reason || 'No summary provided.'}`
  ].join('\n');
}

function normalizeTelegramSendTarget(value) {
  const target = String(value || '').trim();
  if (!target) return { error: 'Telegram manager chat ID is not configured.' };
  if (/^-?\d+$/.test(target)) return { target, kind: 'numeric_chat_id' };
  if (/^@[a-zA-Z0-9_]{5,}$/.test(target)) return { target, kind: 'public_username' };
  if (/^(https?:\/\/)?t\.me\/\+/i.test(target)) {
    return {
      error:
        'Telegram private invite links cannot be used as Bot API send targets. Send /bind_manager inside the manager group so the app can save the numeric chat ID.'
    };
  }
  return {
    error: `Telegram manager chat target "${target}" is not sendable. Use a numeric chat ID like -1001234567890, a public @username, or send /bind_manager in the manager group.`
  };
}

export async function escalateJobConcern({ job, reason, raw = {} }) {
  const settings = await getRuntimeSettings();
  let telegramMessageId = null;
  let sendError = null;
  const managerTarget = normalizeTelegramSendTarget(settings.telegramManagerChatId);

  if (!botInstance) {
    sendError = 'Telegram bot is not running, so the manager escalation could not be sent.';
    addWorkerLog('telegram', 'error', 'Escalation send skipped', {
      jobId: job.id,
      error: sendError
    });
  } else if (managerTarget.error) {
    sendError = managerTarget.error;
    addWorkerLog('telegram', 'error', 'Escalation send skipped', {
      jobId: job.id,
      managerChatId: settings.telegramManagerChatId,
      error: sendError
    });
  } else {
    try {
      const message = await botInstance.telegram.sendMessage(managerTarget.target, managerMessage(job, reason), {
        disable_web_page_preview: true
      });
      telegramMessageId = String(message.message_id);
      addWorkerLog('telegram', 'info', 'Escalation sent to manager', {
        jobId: job.id,
        managerChatId: managerTarget.target,
        managerTargetKind: managerTarget.kind,
        telegramMessageId
      });
    } catch (error) {
      sendError = error.message;
      addWorkerLog('telegram', 'error', 'Escalation send failed', errorToLogMeta(error, {
        jobId: job.id,
        managerChatId: managerTarget.target,
        managerTargetKind: managerTarget.kind
      }));
    }
  }

  await withTransaction(async (client) => {
    await client.query(
      `
        UPDATE jobs
        SET status = 'concern',
            followup_status = 'concern',
            escalated_at = COALESCE(escalated_at, now()),
            followup_last_error = $2,
            updated_at = now()
        WHERE id = $1
      `,
      [job.id, sendError]
    );
    await client.query(
      `
        INSERT INTO escalations(job_id, reason, status, telegram_message_id, raw)
        VALUES ($1, $2, $3, $4, $5)
      `,
      [job.id, reason || '', sendError ? 'failed' : 'sent', telegramMessageId, JSON.stringify(raw)]
    );
  });

  return { telegramMessageId, sendError };
}
