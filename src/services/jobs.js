import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { query, withTransaction } from '../db.js';
import { normalizePhone } from '../utils/phone.js';
import { buildInitialFollowup } from './agent.js';
import {
  buildBlueBubblesTextAttempts,
  getBlueBubblesMessage,
  getBlueBubblesChatGuid,
  getBlueBubblesExternalGuid,
  getBlueBubblesSentMessage,
  sendBlueBubblesText,
  sendBlueBubblesTextAttempt
} from './bluebubbles.js';
import { extractJobFromImage } from './ocr.js';
import { getRuntimeSettings } from './settings.js';
import { unmatchedTechFilter } from './techs.js';
import { addWorkerLog } from './workerLogs.js';
import { errorToLogMeta, errorToStoredMessage, truncateText } from '../utils/errors.js';
import { dateRangeForFilter } from '../utils/time.js';

const deliveryCheckTimers = new Set();
const deliveryFallbackTimers = new Set();

const jobSelect = `
  jobs.*,
  tech.id AS tech_db_id,
  tech.name AS tech_name,
  tech.tech_id AS tech_id,
  tech.telegram_id AS tech_telegram_id
`;

const jobTechJoin = `
  LEFT JOIN LATERAL (
    SELECT technicians.*
    FROM technicians
    WHERE technicians.telegram_id = jobs.source_sender_id
       OR (
         jobs.source_sender_username IS NOT NULL
         AND jobs.source_sender_username <> ''
         AND lower(regexp_replace(technicians.telegram_id, '^@+', '')) = lower(regexp_replace(jobs.source_sender_username, '^@+', ''))
       )
    ORDER BY CASE WHEN technicians.telegram_id = jobs.source_sender_id THEN 0 ELSE 1 END,
             technicians.updated_at DESC
    LIMIT 1
  ) tech ON true
`;

function normalizeChatService(value) {
  const text = String(value || '').trim();
  if (!text) return '';

  const guidService = text.split(';-;')[0].trim();
  if (/^sms$/i.test(guidService) || /\bSMS\b/i.test(text)) return 'SMS';
  if (/^imessage$/i.test(guidService) || /\biMessage\b/i.test(text)) return 'iMessage';
  return '';
}

function rawObject(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function chatServiceFromRaw(raw) {
  const data = rawObject(raw);
  const candidates = [
    data.deliveryAttempt?.service,
    data.deliveryAttempt?.chatGuid,
    data.deliveryAttempt?.label,
    data.chatGuid,
    data.chat?.guid,
    data.chats?.[0]?.guid,
    data.data?.chatGuid,
    data.data?.chat?.guid,
    data.data?.chats?.[0]?.guid,
    data.message?.chatGuid,
    data.message?.chat?.guid,
    data.message?.chats?.[0]?.guid,
    data.service,
    data.data?.service,
    data.message?.service
  ];

  for (const candidate of candidates) {
    const service = normalizeChatService(candidate);
    if (service) return service;
  }
  return '';
}

function chatServiceForConversation(row) {
  return normalizeChatService(row?.external_chat_guid) || chatServiceFromRaw(row?.raw);
}

export function toJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    sourceChatId: row.source_chat_id,
    sourceChatTitle: row.source_chat_title,
    sourceMessageId: row.source_message_id,
    sourceSenderId: row.source_sender_id,
    sourceSenderUsername: row.source_sender_username,
    sourceSenderName: row.source_sender_name,
    sourceSenderIsBot: row.source_sender_is_bot,
    telegramFileId: row.telegram_file_id,
    imagePath: row.image_path,
    imageMime: row.image_mime,
    status: row.status,
    customerName: row.customer_name,
    phone: row.phone,
    normalizedPhone: row.normalized_phone,
    primaryPhone: row.primary_phone,
    normalizedPrimaryPhone: row.normalized_primary_phone,
    accountNumber: row.account_number,
    address: row.address,
    ocrText: row.ocr_text,
    ocrConfidence: row.ocr_confidence === null ? null : Number(row.ocr_confidence),
    ocrRaw: row.ocr_raw,
    aiIgnore: row.ai_ignore,
    techDbId: row.tech_db_id,
    techName: row.tech_name,
    techId: row.tech_id,
    techTelegramId: row.tech_telegram_id,
    followupStatus: row.followup_status,
    followupChatGuid: row.followup_chat_guid,
    followupChatService: normalizeChatService(row.followup_chat_guid),
    followupLastError: row.followup_last_error,
    escalatedAt: row.escalated_at,
    lastContactAt: row.last_contact_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function appendDateFilter(clauses, params, { range = 'today', from = '', to = '', timeZone = '' } = {}) {
  const dateRange = dateRangeForFilter({ range, from, to, timeZone });
  if (dateRange.start) {
    params.push(dateRange.start);
    clauses.push(`jobs.created_at >= $${params.length}`);
  }
  if (dateRange.end) {
    params.push(dateRange.end);
    clauses.push(`jobs.created_at < $${params.length}`);
  }
  return dateRange;
}

function appendTechFilter(clauses, params, techId = '') {
  const filter = String(techId || '').trim();
  if (!filter || filter === 'all') return;

  if (filter === unmatchedTechFilter) {
    clauses.push('tech.id IS NULL');
    return;
  }

  params.push(filter);
  clauses.push(`tech.id = $${params.length}`);
}

async function jobFilters({ range = 'today', from = '', to = '', techId = '' } = {}) {
  const clauses = [];
  const params = [];
  const settings = await getRuntimeSettings();
  const dateRange = appendDateFilter(clauses, params, {
    range,
    from,
    to,
    timeZone: settings.appTimeZone
  });
  appendTechFilter(clauses, params, techId);

  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params, dateRange };
}

export async function listJobs({ range = 'today', from = '', to = '', techId = '' } = {}) {
  const filter = await jobFilters({ range, from, to, techId });
  const result = await query(
    `
      SELECT ${jobSelect}
      FROM jobs
      ${jobTechJoin}
      ${filter.where}
      ORDER BY jobs.created_at DESC
      LIMIT 250
    `,
    filter.params
  );
  return result.rows.map(toJob);
}

export async function getJob(id) {
  const result = await query(
    `
      SELECT ${jobSelect}
      FROM jobs
      ${jobTechJoin}
      WHERE jobs.id = $1
    `,
    [id]
  );
  return toJob(result.rows[0]);
}

export async function updateJob(id, payload) {
  const allowed = {
    customerName: 'customer_name',
    phone: 'phone',
    primaryPhone: 'primary_phone',
    accountNumber: 'account_number',
    address: 'address',
    status: 'status',
    followupStatus: 'followup_status',
    aiIgnore: 'ai_ignore'
  };

  const assignments = [];
  const params = [];
  for (const [key, column] of Object.entries(allowed)) {
    if (Object.hasOwn(payload, key)) {
      params.push(payload[key]);
      assignments.push(`${column} = $${params.length}`);
      if (key === 'phone') {
        params.push(normalizePhone(payload[key]));
        assignments.push(`normalized_phone = $${params.length}`);
      } else if (key === 'primaryPhone') {
        params.push(normalizePhone(payload[key]));
        assignments.push(`normalized_primary_phone = $${params.length}`);
      }
    }
  }

  if (!assignments.length) return getJob(id);
  params.push(id);

  const result = await query(
    `
      UPDATE jobs
      SET ${assignments.join(', ')}, updated_at = now()
      WHERE id = $${params.length}
      RETURNING id
    `,
    params
  );
  if (!result.rows[0]) return null;
  return getJob(id);
}

export async function deleteJob(id) {
  const result = await query('DELETE FROM jobs WHERE id = $1 RETURNING *', [id]);
  const deleted = toJob(result.rows[0]);

  if (deleted?.imagePath) {
    await fs.unlink(deleted.imagePath).catch((error) => {
      if (error.code !== 'ENOENT') console.warn('[jobs] failed to delete image:', error.message);
    });
  }

  return deleted;
}

export async function createJobFromImage({
  source = 'manual',
  sourceChatId = null,
  sourceChatTitle = null,
  sourceMessageId = null,
  sourceSenderId = null,
  sourceSenderUsername = null,
  sourceSenderName = null,
  sourceSenderIsBot = null,
  telegramFileId = null,
  imagePath,
  imageMime = null
}) {
  const result = await query(
    `
      INSERT INTO jobs(
        source,
        source_chat_id,
        source_chat_title,
        source_message_id,
        source_sender_id,
        source_sender_username,
        source_sender_name,
        source_sender_is_bot,
        telegram_file_id,
        image_path,
        image_mime
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (source_chat_id, source_message_id)
      WHERE source_chat_id IS NOT NULL AND source_message_id IS NOT NULL
      DO UPDATE SET
        source_sender_id = COALESCE(jobs.source_sender_id, EXCLUDED.source_sender_id),
        source_sender_username = COALESCE(jobs.source_sender_username, EXCLUDED.source_sender_username),
        source_sender_name = COALESCE(jobs.source_sender_name, EXCLUDED.source_sender_name),
        source_sender_is_bot = COALESCE(jobs.source_sender_is_bot, EXCLUDED.source_sender_is_bot),
        updated_at = jobs.updated_at
      RETURNING id
    `,
    [
      source,
      sourceChatId,
      sourceChatTitle,
      sourceMessageId,
      sourceSenderId,
      sourceSenderUsername,
      sourceSenderName,
      sourceSenderIsBot,
      telegramFileId,
      imagePath,
      imageMime
    ]
  );
  return getJob(result.rows[0].id);
}

export async function saveIncomingImage(buffer, filename = 'job.jpg') {
  const now = new Date();
  const dir = path.join(
    config.dataDir,
    'images',
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  );
  await fs.mkdir(dir, { recursive: true });
  const safeName = filename.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const imagePath = path.join(dir, `${Date.now()}-${safeName}`);
  await fs.writeFile(imagePath, buffer);
  return imagePath;
}

export async function processJobOcr(id) {
  const job = await getJob(id);
  if (!job) throw new Error('Job not found');

  await query("UPDATE jobs SET status = 'ocr_processing', updated_at = now() WHERE id = $1", [id]);

  try {
    const extracted = await extractJobFromImage(job.imagePath);
    const normalizedPhone = normalizePhone(extracted.phone);
    const normalizedPrimaryPhone = normalizePhone(extracted.primaryPhone);
    const missingFields = [
      extracted.customerName ? '' : 'name',
      normalizedPhone || normalizedPrimaryPhone ? '' : 'phone',
      extracted.accountNumber ? '' : 'account number',
      extracted.address ? '' : 'address'
    ].filter(Boolean);
    const hasRequired = !missingFields.length;
    const canAutoFollowup = Boolean(normalizedPhone || normalizedPrimaryPhone);

    const result = await query(
      `
        UPDATE jobs
        SET status = $2,
            customer_name = $3,
            phone = $4,
            normalized_phone = $5,
            primary_phone = $6,
            normalized_primary_phone = $7,
            account_number = $8,
            address = $9,
            ocr_text = $10,
            ocr_confidence = $11,
            ocr_raw = $12,
            updated_at = now()
        WHERE id = $1
        RETURNING *
      `,
      [
        id,
        hasRequired ? 'ocr_ready' : 'needs_review',
        extracted.customerName || null,
        extracted.phone || null,
        normalizedPhone || null,
        extracted.primaryPhone || null,
        normalizedPrimaryPhone || null,
        extracted.accountNumber || null,
        extracted.address || null,
        extracted.ocrText || '',
        extracted.ocrConfidence || null,
        JSON.stringify(extracted.raw || {})
      ]
    );

    const processed = await getJob(result.rows[0].id);
    const settings = await getRuntimeSettings();
    if (settings.autoSendFollowup && canAutoFollowup) {
      if (!hasRequired) {
        addWorkerLog('followup', 'warn', 'Auto follow-up continuing with incomplete OCR', {
          jobId: processed.id,
          missingFields: missingFields.join(', '),
          phone: processed.normalizedPhone || processed.phone || '',
          primaryPhone: processed.normalizedPrimaryPhone || processed.primaryPhone || ''
        });
      }
      try {
        await sendInitialFollowup(processed.id);
        return getJob(processed.id);
      } catch (error) {
        addWorkerLog('followup', 'error', 'Auto follow-up failed', errorToLogMeta(error, { jobId: processed.id }));
        return getJob(processed.id);
      }
    }
    if (settings.autoSendFollowup && !canAutoFollowup) {
      addWorkerLog('followup', 'warn', 'Auto follow-up skipped because OCR did not find a phone number', {
        jobId: processed.id,
        missingFields: missingFields.join(', ')
      });
    }

    return processed;
  } catch (error) {
    await query(
      "UPDATE jobs SET status = 'ocr_failed', followup_last_error = $2, updated_at = now() WHERE id = $1",
      [id, errorToStoredMessage(error)]
    );
    throw error;
  }
}

function messageChatGuid(message) {
  return message?.chats?.[0]?.guid || message?.chat?.guid || message?.chatGuid || '';
}

function sentMessageFromResult(sent) {
  return getBlueBubblesSentMessage(sent);
}

function deliveryStateFromBlueBubblesMessage(message, fallbackGuid = '', fallbackChatGuid = '') {
  const externalGuid = message?.guid || fallbackGuid || '';
  const chatGuid = messageChatGuid(message) || fallbackChatGuid || '';
  const errorText = String(message?.error ?? '').trim();
  const hasDeliveryError = errorText && !['0', 'false', 'null'].includes(errorText.toLowerCase());
  const delivered = message?.isDelivered === true || Boolean(message?.dateDelivered);

  if (delivered) {
    return {
      followupStatus: 'sent',
      followupLastError: null,
      externalGuid,
      chatGuid,
      isDelivered: true,
      dateDelivered: message?.dateDelivered || null,
      errorCode: errorText || '0'
    };
  }

  if (hasDeliveryError) {
    return {
      followupStatus: 'delivery_failed',
      followupLastError: truncateText(
        [
          `BlueBubbles accepted the message, but Messages reports delivery error ${errorText}.`,
          `isDelivered=${message?.isDelivered === true ? 'true' : 'false'}`,
          `dateDelivered=${message?.dateDelivered || 'null'}`,
          `chatGuid=${chatGuid || 'unknown'}`,
          `externalGuid=${externalGuid || 'unknown'}`,
          `handle=${message?.handle?.address || 'unknown'}`,
          `service=${message?.handle?.service || 'unknown'}`
        ].join(' '),
        1000
      ),
      externalGuid,
      chatGuid,
      isDelivered: false,
      dateDelivered: message?.dateDelivered || null,
      errorCode: errorText
    };
  }

  return {
    followupStatus: 'delivery_pending',
    followupLastError: null,
    externalGuid,
    chatGuid,
    isDelivered: false,
    dateDelivered: message?.dateDelivered || null,
    errorCode: errorText || '0'
  };
}

function deliveryLogMeta(delivery, extra = {}) {
  return {
    ...extra,
    chatGuid: delivery.chatGuid || '',
    externalGuid: delivery.externalGuid || '',
    followupStatus: delivery.followupStatus,
    isDelivered: String(Boolean(delivery.isDelivered)),
    dateDelivered: delivery.dateDelivered || '',
    errorCode: delivery.errorCode || ''
  };
}

async function getOutboundConversation({ jobId = '', externalGuid = '' } = {}) {
  const params = [];
  const clauses = ["direction = 'outbound'", 'external_guid IS NOT NULL'];

  if (externalGuid) {
    params.push(externalGuid);
    clauses.push(`external_guid = $${params.length}`);
  }
  if (jobId) {
    params.push(jobId);
    clauses.push(`job_id = $${params.length}`);
  }

  if (!jobId && !externalGuid) return null;

  const result = await query(
    `
      SELECT id, job_id, external_guid, external_chat_guid
        , body, raw
      FROM conversations
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT 1
    `,
    params
  );
  return result.rows[0] || null;
}

async function applyDeliveryUpdate({ conversation, message, raw, source }) {
  const delivery = deliveryStateFromBlueBubblesMessage(message, conversation.external_guid);
  const rawKey = source === 'webhook' ? 'deliveryWebhook' : 'deliveryCheck';
  const rawValue = JSON.stringify({
    checkedAt: new Date().toISOString(),
    source,
    message,
    raw
  });

  await withTransaction(async (client) => {
    await client.query(
      `
        UPDATE conversations
        SET raw = raw || jsonb_build_object($2::text, $3::jsonb)
        WHERE id = $1
      `,
      [conversation.id, rawKey, rawValue]
    );
    await client.query(
      `
        UPDATE jobs
        SET followup_status = CASE
              WHEN followup_status IN ('concern', 'satisfied', 'limit_reached') THEN followup_status
              WHEN followup_status = 'sent' AND $2 IN ('delivery_pending', 'delivery_failed', 'failed') THEN followup_status
              ELSE $2
            END,
            followup_last_error = CASE
              WHEN followup_status IN ('concern', 'satisfied', 'limit_reached') THEN followup_last_error
              WHEN followup_status = 'sent' AND $2 IN ('delivery_pending', 'delivery_failed', 'failed') THEN followup_last_error
              ELSE $3
            END,
            followup_chat_guid = COALESCE($4, followup_chat_guid),
            updated_at = now()
        WHERE id = $1
      `,
      [conversation.job_id, delivery.followupStatus, delivery.followupLastError, delivery.chatGuid || null]
    );
  });

  const level = delivery.followupStatus === 'delivery_failed' ? 'error' : 'info';
  const messageText =
    delivery.followupStatus === 'sent'
      ? 'BlueBubbles delivery confirmed'
      : delivery.followupStatus === 'delivery_failed'
        ? 'BlueBubbles delivery failed'
        : 'BlueBubbles delivery still pending';
  addWorkerLog('bluebubbles', level, messageText, deliveryLogMeta(delivery, { jobId: conversation.job_id, source }));
  if (delivery.followupStatus === 'delivery_failed') scheduleDeliveryFallback(conversation, delivery);

  return { delivery, job: await getJob(conversation.job_id) };
}

export async function refreshJobDeliveryStatus(id, { externalGuid = '', source = 'manual_check' } = {}) {
  const conversation = await getOutboundConversation({ jobId: id, externalGuid });
  if (!conversation) throw new Error('No outbound BlueBubbles message is saved for this job.');

  const current = await getBlueBubblesMessage(conversation.external_guid);
  if (!current.message) throw new Error(`BlueBubbles message ${conversation.external_guid} was not found.`);

  return applyDeliveryUpdate({
    conversation,
    message: current.message,
    raw: current.result,
    source
  });
}

export async function updateOutboundDeliveryFromMessage(data, raw = {}) {
  const message = data?.message || data;
  const guid = message?.guid || data?.guid || '';
  if (!guid) return { matched: false };

  const conversation = await getOutboundConversation({ externalGuid: guid });
  if (!conversation) return { matched: false, externalGuid: guid };

  const result = await applyDeliveryUpdate({
    conversation,
    message,
    raw,
    source: 'webhook'
  });

  return { matched: true, jobId: result.job?.id || conversation.job_id, delivery: result.delivery };
}

function scheduleDeliveryChecks(jobId, externalGuid) {
  if (!jobId || !externalGuid) return;

  for (const delayMs of [8000, 30000]) {
    const key = `${jobId}:${externalGuid}:${delayMs}`;
    if (deliveryCheckTimers.has(key)) continue;
    deliveryCheckTimers.add(key);

    const timer = setTimeout(() => {
      deliveryCheckTimers.delete(key);
      refreshJobDeliveryStatus(jobId, { externalGuid, source: `auto_${delayMs}ms` }).catch((error) => {
        addWorkerLog('bluebubbles', 'warn', 'BlueBubbles delivery check failed', errorToLogMeta(error, {
          jobId,
          externalGuid,
          delayMs
        }));
      });
    }, delayMs);
    timer.unref?.();
  }
}

function nextFallbackAttempt(conversation) {
  const raw = conversation.raw || {};
  const attempts = Array.isArray(raw.deliveryAttempts) ? raw.deliveryAttempts : [];
  const currentIndex = Number(raw.deliveryAttempt?.index);
  if (!attempts.length || !Number.isFinite(currentIndex)) return null;
  return attempts.find((attempt) => Number(attempt.index) > currentIndex) || null;
}

async function sendFallbackAttempt(conversation, failedDelivery) {
  const attempt = nextFallbackAttempt(conversation);
  if (!attempt) return null;

  const attempts = Array.isArray(conversation.raw?.deliveryAttempts) ? conversation.raw.deliveryAttempts : [attempt];
  const previousErrorsBase = Array.isArray(conversation.raw?.deliveryAttemptErrors)
    ? conversation.raw.deliveryAttemptErrors
    : [];
  const previousErrors = [
    ...previousErrorsBase,
    {
      attempt: conversation.raw?.deliveryAttempt || {},
      error: {
        name: 'BlueBubblesDeliveryError',
        message: failedDelivery.followupLastError || `Delivery failed with error code ${failedDelivery.errorCode || 'unknown'}.`,
        errorCode: failedDelivery.errorCode || ''
      }
    }
  ];

  addWorkerLog('bluebubbles', 'info', 'Trying BlueBubbles fallback send attempt', {
    jobId: conversation.job_id,
    previousExternalGuid: failedDelivery.externalGuid || conversation.external_guid,
    attempt: attempt.label || attempt.kind || '',
    chatGuid: attempt.chatGuid || '',
    addresses: Array.isArray(attempt.addresses) ? attempt.addresses.join(',') : '',
    method: attempt.method || ''
  });

  const sent = await sendBlueBubblesTextAttempt({
    attempt,
    message: conversation.body,
    allAttempts: attempts,
    previousErrors
  });
  const sentMessage = sentMessageFromResult(sent);
  const chatGuid = getBlueBubblesChatGuid(sent, attempt.chatGuid || null);
  const externalGuid = getBlueBubblesExternalGuid(sent);
  const delivery = deliveryStateFromBlueBubblesMessage(sentMessage, externalGuid, chatGuid);
  const raw = {
    ...sent,
    fallbackFromExternalGuid: failedDelivery.externalGuid || conversation.external_guid
  };

  await withTransaction(async (client) => {
    await client.query(
      `
        INSERT INTO conversations(job_id, direction, body, external_guid, external_chat_guid, raw)
        VALUES ($1, 'outbound', $2, $3, $4, $5)
        ON CONFLICT (external_guid) WHERE external_guid IS NOT NULL DO NOTHING
      `,
      [conversation.job_id, conversation.body, externalGuid, chatGuid, JSON.stringify(raw)]
    );
    await client.query(
      `
        UPDATE jobs
        SET followup_status = CASE
              WHEN followup_status IN ('concern', 'satisfied', 'limit_reached') THEN followup_status
              WHEN followup_status = 'sent' AND $2 IN ('delivery_pending', 'delivery_failed', 'failed') THEN followup_status
              ELSE $2
            END,
            followup_last_error = CASE
              WHEN followup_status IN ('concern', 'satisfied', 'limit_reached') THEN followup_last_error
              WHEN followup_status = 'sent' AND $2 IN ('delivery_pending', 'delivery_failed', 'failed') THEN followup_last_error
              ELSE $3
            END,
            followup_chat_guid = COALESCE($4, followup_chat_guid),
            last_contact_at = now(),
            updated_at = now()
        WHERE id = $1
      `,
      [conversation.job_id, delivery.followupStatus, delivery.followupLastError, chatGuid]
    );
  });

  addWorkerLog('bluebubbles', 'info', 'BlueBubbles fallback attempt accepted', {
    jobId: conversation.job_id,
    attempt: attempt.label || attempt.kind || '',
    chatGuid: chatGuid || '',
    externalGuid: externalGuid || '',
    followupStatus: delivery.followupStatus,
    isDelivered: String(Boolean(delivery.isDelivered)),
    errorCode: delivery.errorCode || ''
  });

  if (delivery.followupStatus === 'delivery_pending') scheduleDeliveryChecks(conversation.job_id, externalGuid);

  return { delivery, job: await getJob(conversation.job_id) };
}

function scheduleDeliveryFallback(conversation, failedDelivery) {
  const attempt = nextFallbackAttempt(conversation);
  const key = `${conversation.id}:${attempt?.index ?? 'none'}`;
  if (deliveryFallbackTimers.has(key)) return;
  deliveryFallbackTimers.add(key);

  if (!attempt) {
    addWorkerLog('bluebubbles', 'warn', 'No BlueBubbles fallback attempts remain', {
      jobId: conversation.job_id,
      externalGuid: failedDelivery.externalGuid || conversation.external_guid || ''
    });
    return;
  }

  const timer = setTimeout(() => {
    sendFallbackAttempt(conversation, failedDelivery).catch((error) => {
      addWorkerLog('bluebubbles', 'error', 'BlueBubbles fallback attempt failed', errorToLogMeta(error, {
        jobId: conversation.job_id,
        previousExternalGuid: failedDelivery.externalGuid || conversation.external_guid || '',
        attempt: attempt.label || attempt.kind || ''
      }));
    });
  }, 1000);
  timer.unref?.();
}

export function jobContactPhoneTargets(job) {
  const candidates = [
    {
      label: 'Call First',
      phone: normalizePhone(job?.normalizedPhone || job?.phone),
      displayPhone: job?.phone || job?.normalizedPhone || ''
    },
    {
      label: 'Primary',
      phone: normalizePhone(job?.normalizedPrimaryPhone || job?.primaryPhone),
      displayPhone: job?.primaryPhone || job?.normalizedPrimaryPhone || ''
    }
  ];
  const seen = new Set();

  return candidates.filter((candidate) => {
    if (!/^\+\d{8,15}$/.test(candidate.phone)) return false;
    if (seen.has(candidate.phone)) return false;
    seen.add(candidate.phone);
    return true;
  });
}

export async function sendInitialFollowup(id) {
  const job = await getJob(id);
  if (!job) throw new Error('Job not found');
  const targets = jobContactPhoneTargets(job);
  if (!targets.length) throw new Error('Job has no phone number.');

  const message = await buildInitialFollowup(job);
  const settings = await getRuntimeSettings();
  const outcomes = [];
  const errors = [];

  for (const target of targets) {
    const attempts = buildBlueBubblesTextAttempts({ phone: target.phone }, settings);
    const firstAttempt = attempts[0] || {};
    addWorkerLog('followup', 'info', 'Sending BlueBubbles follow-up', {
      jobId: job.id,
      customerName: job.customerName || '',
      targetLabel: target.label,
      phone: target.phone,
      firstAttempt: firstAttempt.label || '',
      chatGuid: firstAttempt.chatGuid || '',
      attemptCount: String(attempts.length)
    });

    try {
      const sent = await sendBlueBubblesText({ phone: target.phone, message });
      const sentMessage = sentMessageFromResult(sent);
      const chatGuid = getBlueBubblesChatGuid(sent);
      const externalGuid = getBlueBubblesExternalGuid(sent);
      const delivery = deliveryStateFromBlueBubblesMessage(sentMessage, externalGuid, chatGuid);
      const raw = {
        ...sent,
        targetLabel: target.label,
        targetPhone: target.phone
      };

      await query(
        `
          INSERT INTO conversations(job_id, direction, body, external_guid, external_chat_guid, raw)
          VALUES ($1, 'outbound', $2, $3, $4, $5)
          ON CONFLICT (external_guid) WHERE external_guid IS NOT NULL DO NOTHING
        `,
        [id, message, externalGuid, chatGuid, JSON.stringify(raw)]
      );
      outcomes.push({ target, sent, delivery });
      addWorkerLog('followup', 'info', 'BlueBubbles follow-up accepted', {
        jobId: job.id,
        targetLabel: target.label,
        phone: target.phone,
        chatGuid: chatGuid || '',
        externalGuid: externalGuid || '',
        attempt: sent.deliveryAttempt?.label || '',
        method: sent.deliveryAttempt?.method || '',
        previousFailedAttempts: String(sent.deliveryAttemptErrors?.length || 0),
        followupStatus: delivery.followupStatus,
        isDelivered: String(Boolean(delivery.isDelivered)),
        errorCode: delivery.errorCode || ''
      });
      if (delivery.followupStatus === 'delivery_pending') scheduleDeliveryChecks(job.id, externalGuid);
    } catch (error) {
      errors.push({ target, error });
      addWorkerLog('followup', 'error', 'BlueBubbles follow-up target failed', errorToLogMeta(error, {
        jobId: job.id,
        targetLabel: target.label,
        phone: target.phone
      }));
    }
  }

  const accepted = outcomes.filter((outcome) => outcome.delivery.followupStatus !== 'delivery_failed');
  const finalStatus = accepted.some((outcome) => outcome.delivery.followupStatus === 'sent')
    ? 'sent'
    : accepted.some((outcome) => outcome.delivery.followupStatus === 'delivery_pending')
      ? 'delivery_pending'
      : 'failed';
  const firstChatGuid = accepted[0]?.delivery.chatGuid || outcomes[0]?.delivery.chatGuid || null;
  const errorMessage = errors.length
    ? truncateText(
        errors
          .map((entry) => `${entry.target.label} ${entry.target.phone}: ${errorToStoredMessage(entry.error, 350)}`)
          .join(' | '),
        1000
      )
    : null;

  try {
    await withTransaction(async (client) => {
      await client.query(
        `
          UPDATE jobs
          SET status = CASE WHEN status IN ('ocr_ready', 'received', 'needs_review') THEN 'contacted' ELSE status END,
              followup_status = $3,
              followup_chat_guid = COALESCE($2, followup_chat_guid),
              followup_last_error = $4,
              last_contact_at = now(),
              updated_at = now()
          WHERE id = $1
        `,
        [id, firstChatGuid, finalStatus, finalStatus === 'failed' ? errorMessage || 'All follow-up target sends failed.' : errorMessage]
      );
    });

    if (finalStatus === 'failed') {
      const error = new Error(errorMessage || 'All follow-up target sends failed.');
      addWorkerLog('followup', 'error', 'BlueBubbles follow-up failed for every target', errorToLogMeta(error, {
        jobId: job.id,
        targetCount: String(targets.length)
      }));
      throw error;
    }

    return getJob(id);
  } catch (error) {
    const storedError = errorToStoredMessage(error);
    await query(
      `
        UPDATE jobs
        SET followup_status = 'failed',
            followup_last_error = $2,
            updated_at = now()
        WHERE id = $1
      `,
      [id, storedError]
    );
    addWorkerLog('followup', 'error', 'BlueBubbles follow-up failed', errorToLogMeta(error, { jobId: job.id }));
    throw error;
  }
}

export async function sendManualJobMessage(id, message) {
  const body = String(message || '').trim();
  if (!body) throw new Error('Message text is required.');

  const job = await getJob(id);
  if (!job) throw new Error('Job not found');
  const targetPhone = jobContactPhoneTargets(job)[0]?.phone || '';
  if (!targetPhone && !job.followupChatGuid) throw new Error('Job has no phone number or BlueBubbles chat GUID.');

  const sent = await sendBlueBubblesText({
    phone: targetPhone,
    chatGuid: job.followupChatGuid,
    message: body
  });
  const sentMessage = sentMessageFromResult(sent);
  const chatGuid = getBlueBubblesChatGuid(sent, job.followupChatGuid || null);
  const externalGuid = getBlueBubblesExternalGuid(sent);
  const delivery = deliveryStateFromBlueBubblesMessage(sentMessage, externalGuid, chatGuid);
  const raw = {
    ...sent,
    manual: true
  };

  await withTransaction(async (client) => {
    await client.query(
      `
        UPDATE jobs
        SET status = CASE WHEN status IN ('ocr_ready', 'received', 'needs_review') THEN 'contacted' ELSE status END,
            followup_status = CASE
              WHEN followup_status IN ('concern', 'satisfied', 'limit_reached') THEN followup_status
              WHEN followup_status = 'sent' AND $3 IN ('delivery_pending', 'delivery_failed', 'failed') THEN followup_status
              ELSE $3
            END,
            followup_chat_guid = COALESCE($2, followup_chat_guid),
            followup_last_error = CASE
              WHEN followup_status IN ('concern', 'satisfied', 'limit_reached') THEN followup_last_error
              WHEN followup_status = 'sent' AND $3 IN ('delivery_pending', 'delivery_failed', 'failed') THEN followup_last_error
              ELSE $4
            END,
            last_contact_at = now(),
            updated_at = now()
        WHERE id = $1
      `,
      [id, chatGuid, delivery.followupStatus, delivery.followupLastError]
    );
    await client.query(
      `
        INSERT INTO conversations(job_id, direction, body, external_guid, external_chat_guid, raw)
        VALUES ($1, 'outbound', $2, $3, $4, $5)
        ON CONFLICT (external_guid) WHERE external_guid IS NOT NULL DO NOTHING
      `,
      [id, body, externalGuid, chatGuid, JSON.stringify(raw)]
    );
  });

  addWorkerLog('bluebubbles', 'info', 'Manual BlueBubbles message sent from app', {
    jobId: id,
    chatGuid: chatGuid || '',
    externalGuid: externalGuid || '',
    followupStatus: delivery.followupStatus,
    isDelivered: String(Boolean(delivery.isDelivered)),
    errorCode: delivery.errorCode || ''
  });

  if (delivery.followupStatus === 'delivery_pending') scheduleDeliveryChecks(id, externalGuid);
  return { job: await getJob(id), delivery };
}

export async function getConversation(jobId) {
  const result = await query(
    `
      SELECT *
      FROM conversations
      WHERE job_id = $1
      ORDER BY created_at ASC
    `,
    [jobId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    jobId: row.job_id,
    channel: row.channel,
    direction: row.direction,
    body: row.body,
    externalGuid: row.external_guid,
    externalChatGuid: row.external_chat_guid,
    chatService: chatServiceForConversation(row),
    raw: row.raw,
    createdAt: row.created_at
  }));
}

export async function listRecentConversations({ range = 'today', from = '', to = '', techId = '' } = {}) {
  const filter = await jobFilters({ range, from, to, techId });
  const result = await query(
    `
      SELECT ${jobSelect},
             latest.id AS last_message_id,
             latest.direction AS last_message_direction,
             latest.body AS last_message_body,
             latest.external_chat_guid AS last_message_external_chat_guid,
             latest.raw AS last_message_raw,
             latest.created_at AS last_message_created_at
      FROM jobs
      ${jobTechJoin}
      JOIN LATERAL (
        SELECT id, direction, body, external_chat_guid, raw, created_at
        FROM conversations
        WHERE conversations.job_id = jobs.id
        ORDER BY created_at DESC
        LIMIT 1
      ) latest ON true
      ${filter.where}
      ORDER BY latest.created_at DESC
      LIMIT 50
    `,
    filter.params
  );

  return result.rows.map((row) => ({
    job: toJob(row),
    lastMessage: {
      id: row.last_message_id,
      direction: row.last_message_direction,
      body: row.last_message_body,
      externalChatGuid: row.last_message_external_chat_guid,
      chatService: chatServiceForConversation({
        external_chat_guid: row.last_message_external_chat_guid,
        raw: row.last_message_raw
      }),
      createdAt: row.last_message_created_at
    }
  }));
}

export async function getDashboardStats({ range = 'today', from = '', to = '', techId = '' } = {}) {
  const filter = await jobFilters({ range, from, to, techId });
  const summary = await query(
    `
      SELECT count(DISTINCT jobs.id)::int AS jobs,
             count(DISTINCT jobs.id) FILTER (
               WHERE jobs.followup_status <> 'not_started' OR outbound.job_id IS NOT NULL
             )::int AS followups,
             count(DISTINCT jobs.id) FILTER (
               WHERE jobs.followup_status = 'satisfied' OR jobs.status = 'satisfied'
             )::int AS satisfactions,
             count(DISTINCT jobs.id) FILTER (
               WHERE jobs.followup_status = 'concern' OR jobs.status = 'concern' OR escalations.id IS NOT NULL
             )::int AS escalations
      FROM jobs
      ${jobTechJoin}
      LEFT JOIN (SELECT DISTINCT job_id FROM conversations WHERE direction = 'outbound') outbound ON outbound.job_id = jobs.id
      LEFT JOIN escalations ON escalations.job_id = jobs.id
      ${filter.where}
    `,
    filter.params
  );

  const byTech = await query(
    `
      SELECT COALESCE(tech.id::text, 'unmatched') AS tech_filter,
             COALESCE(tech.name, 'Unmatched') AS tech_name,
             COALESCE(tech.tech_id, '') AS tech_id,
             count(DISTINCT jobs.id)::int AS jobs,
             count(DISTINCT jobs.id) FILTER (
               WHERE jobs.followup_status <> 'not_started' OR outbound.job_id IS NOT NULL
             )::int AS followups,
             count(DISTINCT jobs.id) FILTER (
               WHERE jobs.followup_status = 'satisfied' OR jobs.status = 'satisfied'
             )::int AS satisfactions,
             count(DISTINCT jobs.id) FILTER (
               WHERE jobs.followup_status = 'concern' OR jobs.status = 'concern' OR escalations.id IS NOT NULL
             )::int AS escalations
      FROM jobs
      ${jobTechJoin}
      LEFT JOIN (SELECT DISTINCT job_id FROM conversations WHERE direction = 'outbound') outbound ON outbound.job_id = jobs.id
      LEFT JOIN escalations ON escalations.job_id = jobs.id
      ${filter.where ? `${filter.where} AND` : 'WHERE'} jobs.id IS NOT NULL
      GROUP BY tech.id, tech.name, tech.tech_id
      ORDER BY escalations DESC, jobs DESC, lower(COALESCE(tech.name, 'Unmatched'))
      LIMIT 20
    `,
    filter.params
  );

  return {
    range: {
      type: range,
      timeZone: filter.dateRange.timeZone,
      startDate: filter.dateRange.startDate,
      endDate: filter.dateRange.endDate
    },
    summary: summary.rows[0] || { jobs: 0, followups: 0, satisfactions: 0, escalations: 0 },
    byTech: byTech.rows.map((row) => ({
      techFilter: row.tech_filter,
      techName: row.tech_name,
      techId: row.tech_id,
      jobs: row.jobs,
      followups: row.followups,
      satisfactions: row.satisfactions,
      escalations: row.escalations
    }))
  };
}

export async function getJobByPhoneOrChat({ phone, chatGuid }) {
  const normalized = normalizePhone(phone);
  const params = [];
  const clauses = [];

  if (normalized) {
    params.push(normalized);
    clauses.push(`(jobs.normalized_phone = $${params.length} OR jobs.normalized_primary_phone = $${params.length})`);
  }
  if (chatGuid) {
    params.push(chatGuid);
    clauses.push(`jobs.followup_chat_guid = $${params.length}`);
  }
  if (!clauses.length) return null;

  const settings = await getRuntimeSettings();
  const windowDays = Math.min(3650, Math.max(1, Number.parseInt(settings.followupConversationWindowDays, 10) || 30));
  const activeStatuses = [
    'sent',
    'conversation',
    'failed',
    'delivery_pending',
    'delivery_failed',
    'limit_reached',
    'satisfied',
    'concern'
  ];
  params.push(activeStatuses);
  const statusParam = params.length;
  params.push(windowDays);
  const windowParam = params.length;

  const result = await query(
    `
      SELECT ${jobSelect}
      FROM jobs
      ${jobTechJoin}
      WHERE (${clauses.join(' OR ')})
        AND jobs.followup_status = ANY($${statusParam}::text[])
        AND jobs.created_at >= now() - ($${windowParam}::int * interval '1 day')
      ORDER BY jobs.created_at DESC
      LIMIT 1
    `,
    params
  );
  return toJob(result.rows[0]);
}
