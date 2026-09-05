import express from 'express';
import { classifyCustomerReply } from '../services/agent.js';
import { getBlueBubblesChatGuid, getBlueBubblesExternalGuid, sendBlueBubblesText } from '../services/bluebubbles.js';
import { escalateJobConcern } from '../services/escalations.js';
import { getConversation, getJobByPhoneOrChat, updateOutboundDeliveryFromMessage } from '../services/jobs.js';
import { getRuntimeSettings } from '../services/settings.js';
import { addWorkerLog } from '../services/workerLogs.js';
import { errorToLogMeta, errorToStoredMessage, truncateText } from '../utils/errors.js';
import { normalizePhone } from '../utils/phone.js';
import { query, withTransaction } from '../db.js';

export const webhookRouter = express.Router();

async function verifyBlueBubblesWebhook(req, res, next) {
  const settings = await getRuntimeSettings();
  if (!settings.bluebubblesWebhookSecret) return next();

  const provided =
    req.query.secret || req.query.password || req.query.token || req.get('x-webhook-secret') || req.get('authorization')?.replace(/^Bearer\s+/i, '');

  if (provided !== settings.bluebubblesWebhookSecret) {
    return res.status(401).json({ error: 'Invalid webhook secret' });
  }

  return next();
}

async function insertInboundMessage(job, data, chatGuid, body) {
  const result = await query(
    `
      INSERT INTO conversations(job_id, direction, body, external_guid, external_chat_guid, raw)
      VALUES ($1, 'inbound', $2, $3, $4, $5)
      ON CONFLICT (external_guid) WHERE external_guid IS NOT NULL DO NOTHING
      RETURNING id
    `,
    [job.id, body, data.guid || null, chatGuid || null, JSON.stringify(data)]
  );

  if (!result.rowCount) return { inserted: false };

  await query(
    `
      UPDATE jobs
      SET followup_status = CASE
            WHEN followup_status IN ('concern', 'limit_reached') THEN followup_status
            ELSE 'conversation'
          END,
          last_contact_at = now(),
          updated_at = now()
      WHERE id = $1
    `,
    [job.id]
  );

  return { inserted: true };
}

function countAgentMessages(conversation) {
  return conversation.filter((message) => message.direction === 'outbound' && !message.raw?.fallbackFromExternalGuid).length;
}

function maxAgentMessages(settings) {
  const parsed = Number.parseInt(settings.followupMaxAgentMessages, 10);
  return Number.isFinite(parsed) ? Math.min(50, Math.max(1, parsed)) : 6;
}

async function markReplyLimitReached(jobId, meta = {}) {
  await query(
    `
      UPDATE jobs
      SET followup_status = 'limit_reached',
          updated_at = now()
      WHERE id = $1 AND followup_status NOT IN ('concern', 'satisfied')
    `,
    [jobId]
  );
  addWorkerLog('agent', 'warn', 'Agent reply limit reached', meta);
}

async function handleBlueBubblesSendError(data, reqBody) {
  const chatGuid = data.chats?.[0]?.guid || data.chatGuid || data.chat?.guid || null;
  const sender = normalizePhone(data.handle?.address || data.address || data.chats?.[0]?.chatIdentifier || '');
  const message =
    data.error?.message ||
    (typeof data.message === 'string' ? data.message : data.message?.text || data.message?.message) ||
    data.statusMessage ||
    'BlueBubbles message send error';
  const error = new Error(message);
  error.name = 'BlueBubblesWebhookError';
  error.status = data.status || data.error?.status || '';
  error.type = data.error?.type || '';
  error.responseBody = truncateText(JSON.stringify(data.error || data), 1200);

  const job = await getJobByPhoneOrChat({ phone: sender, chatGuid });
  if (job) {
    await query(
      `
        UPDATE jobs
        SET followup_status = CASE
              WHEN followup_status IN ('concern', 'satisfied', 'limit_reached') THEN followup_status
              ELSE 'failed'
            END,
            followup_last_error = CASE
              WHEN followup_status IN ('concern', 'satisfied', 'limit_reached') THEN followup_last_error
              ELSE $2
            END,
            updated_at = now()
        WHERE id = $1
      `,
      [job.id, errorToStoredMessage(error)]
    );
  }

  addWorkerLog(
    'bluebubbles',
    'error',
    'BlueBubbles message-send-error webhook received',
    errorToLogMeta(error, {
      matchedJobId: job?.id || '',
      chatGuid: chatGuid || '',
      sender: sender || '',
      rawType: reqBody?.type || ''
    })
  );

  return { matched: Boolean(job), jobId: job?.id || null };
}

webhookRouter.post('/bluebubbles', verifyBlueBubblesWebhook, async (req, res, next) => {
  try {
    const { type, data = {} } = req.body || {};
    if (type === 'updated-message') {
      const result = await updateOutboundDeliveryFromMessage(data, req.body);
      if (!result.matched) {
        addWorkerLog('webhook', 'info', 'BlueBubbles updated-message did not match an outbound job', {
          externalGuid: data.guid || data.message?.guid || '',
          chatGuid: data.chats?.[0]?.guid || data.chatGuid || data.chat?.guid || ''
        });
      }
      return res.json({ ok: true, handled: true, ...result });
    }
    if (type === 'message-send-error') {
      const result = await updateOutboundDeliveryFromMessage(data, req.body);
      if (result.matched) return res.json({ ok: true, handled: true, ...result });
      return res.json({ ok: true, handled: true, ...(await handleBlueBubblesSendError(data, req.body)) });
    }
    if (type !== 'new-message') return res.json({ ok: true, ignored: true });
    if (data.isFromMe) return res.json({ ok: true, ignored: true });

    const body = String(data.text || '').trim();
    if (!body) return res.json({ ok: true, ignored: true });

    const sender = normalizePhone(data.handle?.address || data.chats?.[0]?.chatIdentifier || '');
    const chatGuid = data.chats?.[0]?.guid || null;
    const job = await getJobByPhoneOrChat({ phone: sender, chatGuid });
    if (!job) {
      addWorkerLog('webhook', 'info', 'BlueBubbles inbound message did not match a job', {
        chatGuid: chatGuid || '',
        sender: sender || ''
      });
      return res.json({ ok: true, matched: false });
    }

    const inbound = await insertInboundMessage(job, data, chatGuid, body);
    if (!inbound.inserted) {
      addWorkerLog('webhook', 'info', 'Duplicate BlueBubbles inbound message ignored', {
        jobId: job.id,
        externalGuid: data.guid || '',
        chatGuid: chatGuid || '',
        sender: sender || ''
      });
      return res.json({ ok: true, matched: true, duplicate: true });
    }

    if (job.aiIgnore) {
      addWorkerLog('agent', 'info', 'BlueBubbles inbound saved with AI ignored for job', {
        jobId: job.id,
        chatGuid: chatGuid || '',
        sender: sender || ''
      });
      return res.json({ ok: true, matched: true, aiIgnored: true });
    }

    const conversation = await getConversation(job.id);
    const settings = await getRuntimeSettings();
    const agentMessageCount = countAgentMessages(conversation);
    const agentMessageLimit = maxAgentMessages(settings);
    const decision = await classifyCustomerReply({ job, conversation, customerText: body });
    const canSendReply = Boolean(decision.reply) && agentMessageCount < agentMessageLimit;

    if (decision.reply && canSendReply) {
      const sent = await sendBlueBubblesText({
        phone: job.normalizedPhone || job.phone,
        chatGuid: chatGuid || job.followupChatGuid,
        message: decision.reply
      });
      const sentChatGuid = getBlueBubblesChatGuid(sent, chatGuid || job.followupChatGuid || null);
      const externalGuid = getBlueBubblesExternalGuid(sent);
      await withTransaction(async (client) => {
        await client.query(
          `
            INSERT INTO conversations(job_id, direction, body, external_guid, external_chat_guid, raw)
            VALUES ($1, 'outbound', $2, $3, $4, $5)
            ON CONFLICT (external_guid) WHERE external_guid IS NOT NULL DO NOTHING
          `,
          [job.id, decision.reply, externalGuid || null, sentChatGuid || null, JSON.stringify(sent)]
        );
        await client.query(
          `
            UPDATE jobs
            SET followup_chat_guid = COALESCE($2, followup_chat_guid),
                last_contact_at = now(),
                updated_at = now()
            WHERE id = $1
          `,
          [job.id, sentChatGuid || null]
        );
      });
      addWorkerLog('bluebubbles', 'info', 'BlueBubbles webhook reply sent', {
        jobId: job.id,
        chatGuid: sentChatGuid || '',
        externalGuid: externalGuid || ''
      });
      if (decision.status === 'needs_followup' && agentMessageCount + 1 >= agentMessageLimit) {
        await markReplyLimitReached(job.id, {
          jobId: job.id,
          agentMessageCount: String(agentMessageCount + 1),
          maxAgentMessages: String(agentMessageLimit)
        });
      }
    } else if (decision.reply) {
      await markReplyLimitReached(job.id, {
        jobId: job.id,
        agentMessageCount: String(agentMessageCount),
        maxAgentMessages: String(agentMessageLimit),
        skippedReply: truncateText(decision.reply, 300)
      });
    }

    if (decision.status === 'concern') {
      await escalateJobConcern({ job, reason: decision.concernSummary || body, raw: { webhook: req.body, decision } });
    } else if (decision.status === 'satisfied') {
      await query(
        `
          UPDATE jobs
          SET status = 'satisfied',
              followup_status = 'satisfied',
              updated_at = now()
          WHERE id = $1
        `,
        [job.id]
      );
    } else if (!decision.reply && agentMessageCount >= agentMessageLimit) {
      await markReplyLimitReached(job.id, {
        jobId: job.id,
        agentMessageCount: String(agentMessageCount),
        maxAgentMessages: String(agentMessageLimit)
      });
    }

    res.json({
      ok: true,
      matched: true,
      decision,
      agentMessageCount,
      maxAgentMessages: agentMessageLimit,
      replySent: canSendReply
    });
  } catch (error) {
    addWorkerLog('webhook', 'error', 'BlueBubbles webhook handling failed', errorToLogMeta(error));
    next(error);
  }
});
