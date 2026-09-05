import { query, withTransaction } from '../db.js';
import { getBlueBubblesChatGuid, getBlueBubblesExternalGuid, sendBlueBubblesText } from './bluebubbles.js';
import { getRuntimeSettings } from './settings.js';
import { addWorkerLog } from './workerLogs.js';
import { errorToLogMeta, errorToStoredMessage, serializeError } from '../utils/errors.js';
import { normalizePhone } from '../utils/phone.js';

let botInstance = null;

export function setEscalationTelegramBot(bot) {
  botInstance = bot;
}

function jobValue(job, camelKey, snakeKey = camelKey) {
  return job?.[camelKey] || job?.[snakeKey] || '';
}

function telegramPoster(job) {
  const username = jobValue(job, 'sourceSenderUsername', 'source_sender_username');
  const name = jobValue(job, 'sourceSenderName', 'source_sender_name');
  const id = jobValue(job, 'sourceSenderId', 'source_sender_id');
  if (name && username) return `${name} (@${username})`;
  if (name) return name;
  if (username) return `@${username}`;
  if (id) return `Telegram ID ${id}`;
  return 'Unknown';
}

function managerMessage(job, reason) {
  return [
    'Customer concern detected',
    '',
    `Name: ${jobValue(job, 'customerName', 'customer_name') || 'Unknown'}`,
    `Phone: ${jobValue(job, 'phone') || jobValue(job, 'normalizedPhone', 'normalized_phone') || 'Unknown'}`,
    `Primary phone: ${jobValue(job, 'primaryPhone', 'primary_phone') || jobValue(job, 'normalizedPrimaryPhone', 'normalized_primary_phone') || 'Unknown'}`,
    `Account #: ${jobValue(job, 'accountNumber', 'account_number') || 'Unknown'}`,
    `Address: ${jobValue(job, 'address') || 'Unknown'}`,
    `Technician: ${jobValue(job, 'techName', 'tech_name') || 'Unmatched'}`,
    `Posted by: ${telegramPoster(job)}`,
    '',
    `Concern: ${reason || 'No summary provided.'}`
  ].join('\n');
}

export function parseBlueBubblesEscalationPhones(value) {
  const seen = new Set();
  return String(value || '')
    .split(/[,\n;]+/)
    .map((item) => normalizePhone(item))
    .filter((phone) => /^\+\d{8,15}$/.test(phone))
    .filter((phone) => {
      if (seen.has(phone)) return false;
      seen.add(phone);
      return true;
    });
}

export function renderBlueBubblesEscalationMessage(template, job, reason) {
  const values = {
    name: jobValue(job, 'customerName', 'customer_name') || 'Unknown',
    phone: jobValue(job, 'phone') || jobValue(job, 'normalizedPhone', 'normalized_phone') || 'Unknown',
    primaryPhone: jobValue(job, 'primaryPhone', 'primary_phone') || jobValue(job, 'normalizedPrimaryPhone', 'normalized_primary_phone') || '',
    accountNumber: jobValue(job, 'accountNumber', 'account_number') || 'Unknown',
    address: jobValue(job, 'address') || 'Unknown',
    tech: jobValue(job, 'techName', 'tech_name') || 'Unmatched',
    techId: jobValue(job, 'techId', 'tech_id') || '',
    techTelegramId: jobValue(job, 'techTelegramId', 'tech_telegram_id') || '',
    telegramPoster: telegramPoster(job),
    concern: reason || 'No summary provided.',
    jobId: jobValue(job, 'id') || ''
  };

  return String(template || managerMessage(job, reason))
    .replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => (Object.hasOwn(values, key) ? values[key] : match))
    .trim();
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

async function sendBlueBubblesManagerEscalations(settings, job, reason) {
  const result = {
    enabled: Boolean(settings.bluebubblesEscalationEnabled),
    message: '',
    results: [],
    errors: []
  };
  if (!settings.bluebubblesEscalationEnabled) return result;

  const phones = parseBlueBubblesEscalationPhones(settings.bluebubblesEscalationPhones);
  if (!phones.length) {
    const message = 'BlueBubbles manager escalation is enabled, but no valid manager/supervisor phone numbers are configured.';
    result.errors.push({ phone: '', error: { name: 'ConfigurationError', message } });
    addWorkerLog('bluebubbles', 'error', 'Escalation SMS skipped', { jobId: job.id, error: message });
    return result;
  }

  const body = renderBlueBubblesEscalationMessage(settings.bluebubblesEscalationTemplate, job, reason);
  result.message = body;

  for (const phone of phones) {
    try {
      const sent = await sendBlueBubblesText({ phone, message: body });
      const chatGuid = getBlueBubblesChatGuid(sent);
      const externalGuid = getBlueBubblesExternalGuid(sent);
      result.results.push({
        phone,
        chatGuid,
        externalGuid,
        deliveryAttempt: sent.deliveryAttempt || null,
        deliveryAttemptErrors: sent.deliveryAttemptErrors || []
      });
      addWorkerLog('bluebubbles', 'info', 'Escalation SMS sent to manager', {
        jobId: job.id,
        managerPhone: phone,
        chatGuid: chatGuid || '',
        externalGuid: externalGuid || '',
        attempt: sent.deliveryAttempt?.label || ''
      });
    } catch (error) {
      result.errors.push({ phone, error: serializeError(error) });
      addWorkerLog('bluebubbles', 'error', 'Escalation SMS send failed', errorToLogMeta(error, {
        jobId: job.id,
        managerPhone: phone
      }));
    }
  }

  return result;
}

export async function escalateJobConcern({ job, reason, raw = {} }) {
  const settings = await getRuntimeSettings();
  let telegramMessageId = null;
  let telegramError = null;
  const managerTarget = normalizeTelegramSendTarget(settings.telegramManagerChatId);

  if (!botInstance) {
    telegramError = 'Telegram bot is not running, so the manager escalation could not be sent.';
    addWorkerLog('telegram', 'error', 'Escalation send skipped', {
      jobId: job.id,
      error: telegramError
    });
  } else if (managerTarget.error) {
    telegramError = managerTarget.error;
    addWorkerLog('telegram', 'error', 'Escalation send skipped', {
      jobId: job.id,
      managerChatId: settings.telegramManagerChatId,
      error: telegramError
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
      telegramError = error.message;
      addWorkerLog('telegram', 'error', 'Escalation send failed', errorToLogMeta(error, {
        jobId: job.id,
        managerChatId: managerTarget.target,
        managerTargetKind: managerTarget.kind
      }));
    }
  }

  const bluebubblesEscalation = await sendBlueBubblesManagerEscalations(settings, job, reason);
  const channelErrors = [
    telegramError ? `Telegram: ${telegramError}` : '',
    ...bluebubblesEscalation.errors.map((entry) => `BlueBubbles${entry.phone ? ` ${entry.phone}` : ''}: ${entry.error?.message || 'send failed'}`)
  ].filter(Boolean);
  const anySent = Boolean(telegramMessageId || bluebubblesEscalation.results.length);
  const sendError = anySent ? null : errorToStoredMessage(new Error(channelErrors.join(' | ') || 'No manager escalation channel sent.'));
  const escalationRaw = {
    ...raw,
    escalationChannels: {
      telegram: {
        enabled: Boolean(settings.telegramManagerChatId),
        target: managerTarget.target || settings.telegramManagerChatId || '',
        targetKind: managerTarget.kind || '',
        messageId: telegramMessageId,
        error: telegramError
      },
      bluebubbles: bluebubblesEscalation
    }
  };

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
      [job.id, reason || '', anySent ? 'sent' : 'failed', telegramMessageId, JSON.stringify(escalationRaw)]
    );
  });

  return { telegramMessageId, bluebubblesEscalation, sendError };
}
