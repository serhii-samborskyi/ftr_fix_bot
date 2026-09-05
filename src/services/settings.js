import { config } from '../config.js';
import { query } from '../db.js';
import { normalizeTimeZone } from '../utils/time.js';

const defaults = {
  appBaseUrl: config.appBaseUrl,
  appTimeZone: config.appTimeZone,
  telegramJobChatTitle: config.telegram.jobChatTitle,
  telegramJobChatId: config.telegram.jobChatId,
  telegramManagerChatId: config.telegram.managerChatId,
  telegramAckEnabled: String(config.telegram.ackEnabled),
  bluebubblesServerUrl: config.bluebubbles.serverUrl,
  bluebubblesSendMethod: config.bluebubbles.sendMethod,
  bluebubblesServiceOrder: config.bluebubbles.serviceOrder,
  bluebubblesAddressFallback: String(config.bluebubbles.addressFallback),
  bluebubblesEscalationEnabled: String(config.bluebubbles.escalationEnabled),
  bluebubblesEscalationPhones: config.bluebubbles.escalationPhones,
  bluebubblesEscalationTemplate:
    config.bluebubbles.escalationTemplate ||
    `Customer concern detected
Name: {{name}}
Phone: {{phone}}
Primary phone: {{primaryPhone}}
Account #: {{accountNumber}}
Address: {{address}}
Technician: {{tech}}
Concern: {{concern}}`,
  llmProvider: config.llm.provider,
  ollamaBaseUrl: config.llm.ollamaBaseUrl,
  ollamaModel: config.llm.ollamaModel,
  geminiModel: config.llm.geminiModel,
  autoSendFollowup: String(config.autoSendFollowup),
  followupMaxAgentMessages: String(config.followup.maxAgentMessages),
  followupConversationWindowDays: String(config.followup.conversationWindowDays),
  systemPrompt: `You are the FTR Fix customer follow-up agent.

Goal: identify whether the customer is satisfied after a completed service visit.

Rules:
- Be brief, polite, and human.
- Ask one clear question at a time.
- Use the full conversation history and respond naturally to the latest customer message.
- Do not repeat the same satisfaction question if the customer already answered it.
- Interpret short answers like "yes" and "no" based on the agent's previous question.
- If the customer answers "no" to "Were you satisfied?", ask what still needs attention.
- If the customer answers "no" to "Is there anything that still needs attention?", mark satisfied and close politely.
- If the customer answers "yes" to "Is there anything that still needs attention?" and gives any details, mark concern.
- If the customer keeps chatting but has no concern, acknowledge briefly and close politely.
- Do not promise a specific refund, appointment, or technical outcome.
- If the customer reports unresolved work, loose/hanging/left wires, equipment left behind, property damage, billing concern, missed appointment, safety concern, dissatisfaction, or asks for a supervisor, mark concern.
- If the customer clearly says everything is good, mark the conversation as satisfied.
- If the customer is unclear, ask one short follow-up question.
- Never repeat an agent message that is already in the conversation.

When classifying a reply, return strict JSON only with:
{
  "status": "satisfied" | "concern" | "needs_followup",
  "reply": "message to send back, or empty string",
  "concern_summary": "short manager summary, or empty string"
}`,
  initialMessageTemplate:
    'Hi {{name}}, this is FTR Fix following up on your recent service visit with {{tech}}. Were you satisfied with the work completed?'
};

const secretDefaults = {
  telegramBotToken: config.telegram.botToken,
  bluebubblesPassword: config.bluebubbles.password,
  bluebubblesWebhookSecret: config.bluebubbles.webhookSecret,
  geminiApiKey: config.llm.geminiApiKey
};

export function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function parsePositiveInt(value, fallback, max = 1000) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(1, parsed));
}

export async function getSetting(key, fallback = '') {
  const result = await query('SELECT value FROM settings WHERE key = $1', [key]);
  if (result.rows[0]) return result.rows[0].value;
  if (Object.hasOwn(defaults, key)) return defaults[key];
  if (Object.hasOwn(secretDefaults, key)) return secretDefaults[key];
  return fallback;
}

export async function setSetting(key, value) {
  await query(
    `
      INSERT INTO settings(key, value, updated_at)
      VALUES ($1, $2, now())
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `,
    [key, String(value ?? '')]
  );
}

export async function getRuntimeSettings() {
  const rows = await query('SELECT key, value FROM settings');
  const fromDb = Object.fromEntries(rows.rows.map((row) => [row.key, row.value]));
  const merged = { ...defaults, ...secretDefaults, ...fromDb };

  return {
    appBaseUrl: merged.appBaseUrl,
    appTimeZone: normalizeTimeZone(merged.appTimeZone),
    telegramJobChatTitle: merged.telegramJobChatTitle,
    telegramJobChatId: merged.telegramJobChatId,
    telegramManagerChatId: merged.telegramManagerChatId,
    telegramBotToken: merged.telegramBotToken,
    telegramAckEnabled: parseBool(merged.telegramAckEnabled, true),
    bluebubblesServerUrl: merged.bluebubblesServerUrl,
    bluebubblesPassword: merged.bluebubblesPassword,
    bluebubblesWebhookSecret: merged.bluebubblesWebhookSecret,
    bluebubblesSendMethod: merged.bluebubblesSendMethod,
    bluebubblesServiceOrder: merged.bluebubblesServiceOrder,
    bluebubblesAddressFallback: parseBool(merged.bluebubblesAddressFallback, true),
    bluebubblesEscalationEnabled: parseBool(merged.bluebubblesEscalationEnabled, false),
    bluebubblesEscalationPhones: merged.bluebubblesEscalationPhones,
    bluebubblesEscalationTemplate: merged.bluebubblesEscalationTemplate,
    llmProvider: merged.llmProvider,
    ollamaBaseUrl: merged.ollamaBaseUrl,
    ollamaModel: merged.ollamaModel,
    geminiApiKey: merged.geminiApiKey,
    geminiModel: merged.geminiModel,
    autoSendFollowup: parseBool(merged.autoSendFollowup, true),
    followupMaxAgentMessages: parsePositiveInt(merged.followupMaxAgentMessages, 6, 50),
    followupConversationWindowDays: parsePositiveInt(merged.followupConversationWindowDays, 30, 3650),
    systemPrompt: merged.systemPrompt,
    initialMessageTemplate: merged.initialMessageTemplate
  };
}

function buildBlueBubblesWebhookUrl(settings) {
  let base = String(settings.appBaseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;

  try {
    const url = new URL('/webhooks/bluebubbles', base);
    if (settings.bluebubblesWebhookSecret) url.searchParams.set('secret', settings.bluebubblesWebhookSecret);
    return url.toString();
  } catch {
    return '';
  }
}

export async function getPublicSettings() {
  const settings = await getRuntimeSettings();
  return {
    appBaseUrl: settings.appBaseUrl,
    appTimeZone: settings.appTimeZone,
    telegramJobChatTitle: settings.telegramJobChatTitle,
    telegramJobChatId: settings.telegramJobChatId,
    telegramManagerChatId: settings.telegramManagerChatId,
    telegramBotTokenConfigured: Boolean(settings.telegramBotToken),
    telegramAckEnabled: settings.telegramAckEnabled,
    bluebubblesServerUrl: settings.bluebubblesServerUrl,
    bluebubblesPasswordConfigured: Boolean(settings.bluebubblesPassword),
    bluebubblesWebhookSecretConfigured: Boolean(settings.bluebubblesWebhookSecret),
    bluebubblesWebhookUrl: buildBlueBubblesWebhookUrl(settings),
    bluebubblesSendMethod: settings.bluebubblesSendMethod,
    bluebubblesServiceOrder: settings.bluebubblesServiceOrder,
    bluebubblesAddressFallback: settings.bluebubblesAddressFallback,
    bluebubblesEscalationEnabled: settings.bluebubblesEscalationEnabled,
    bluebubblesEscalationPhones: settings.bluebubblesEscalationPhones,
    bluebubblesEscalationTemplate: settings.bluebubblesEscalationTemplate,
    llmProvider: settings.llmProvider,
    ollamaBaseUrl: settings.ollamaBaseUrl,
    ollamaModel: settings.ollamaModel,
    geminiModel: settings.geminiModel,
    geminiApiKeyConfigured: Boolean(settings.geminiApiKey),
    autoSendFollowup: settings.autoSendFollowup,
    followupMaxAgentMessages: settings.followupMaxAgentMessages,
    followupConversationWindowDays: settings.followupConversationWindowDays,
    systemPrompt: settings.systemPrompt,
    initialMessageTemplate: settings.initialMessageTemplate
  };
}

export async function updatePublicSettings(payload) {
  const editable = [
    'appBaseUrl',
    'appTimeZone',
    'telegramJobChatTitle',
    'telegramJobChatId',
    'telegramManagerChatId',
    'telegramAckEnabled',
    'bluebubblesServerUrl',
    'bluebubblesSendMethod',
    'bluebubblesServiceOrder',
    'bluebubblesAddressFallback',
    'bluebubblesEscalationEnabled',
    'bluebubblesEscalationPhones',
    'bluebubblesEscalationTemplate',
    'llmProvider',
    'ollamaBaseUrl',
    'ollamaModel',
    'geminiModel',
    'autoSendFollowup',
    'followupMaxAgentMessages',
    'followupConversationWindowDays',
    'systemPrompt',
    'initialMessageTemplate'
  ];

  for (const key of editable) {
    if (Object.hasOwn(payload, key)) await setSetting(key, payload[key]);
  }

  if (payload.bluebubblesPassword) await setSetting('bluebubblesPassword', payload.bluebubblesPassword);
  if (payload.bluebubblesWebhookSecret) await setSetting('bluebubblesWebhookSecret', payload.bluebubblesWebhookSecret);
  if (payload.telegramBotToken) await setSetting('telegramBotToken', payload.telegramBotToken);
  if (payload.geminiApiKey) await setSetting('geminiApiKey', payload.geminiApiKey);

  return getPublicSettings();
}
