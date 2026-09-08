import 'dotenv/config';
import path from 'node:path';

const bool = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const number = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: number(process.env.PORT, 3000),
  appBaseUrl: process.env.APP_BASE_URL || '',
  appTimeZone: process.env.APP_TIME_ZONE || process.env.TZ || 'America/Chicago',
  dataDir: path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data')),
  databaseUrl: process.env.DATABASE_URL,
  admin: {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || '',
    passwordHash: process.env.ADMIN_PASSWORD_HASH || '',
    sessionSecret: process.env.SESSION_SECRET || ''
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    jobChatTitle: process.env.TELEGRAM_JOB_CHAT_TITLE || 'FTRFIXBOT_CHAT',
    jobChatId: process.env.TELEGRAM_JOB_CHAT_ID || '',
    managerChatId: process.env.TELEGRAM_MANAGER_CHAT_ID || '',
    ackEnabled: bool(process.env.TELEGRAM_ACK_ENABLED, true),
    adminUserIds: (process.env.TELEGRAM_ADMIN_USER_IDS || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
  },
  bluebubbles: {
    serverUrl: process.env.BLUEBUBBLES_SERVER_URL || '',
    password: process.env.BLUEBUBBLES_PASSWORD || '',
    webhookSecret: process.env.BLUEBUBBLES_WEBHOOK_SECRET || '',
    sendMethod: process.env.BLUEBUBBLES_SEND_METHOD || 'private-api',
    serviceOrder: process.env.BLUEBUBBLES_SERVICE_ORDER || 'iMessage,SMS',
    addressFallback: bool(process.env.BLUEBUBBLES_ADDRESS_FALLBACK, true),
    typingIndicatorsEnabled: bool(process.env.BLUEBUBBLES_TYPING_INDICATORS_ENABLED, true),
    escalationEnabled: bool(process.env.BLUEBUBBLES_ESCALATION_ENABLED, false),
    escalationPhones: process.env.BLUEBUBBLES_ESCALATION_PHONES || '',
    escalationTemplate: process.env.BLUEBUBBLES_ESCALATION_TEMPLATE || ''
  },
  followup: {
    maxAgentMessages: number(process.env.FOLLOWUP_MAX_AGENT_MESSAGES, 6),
    conversationWindowDays: number(process.env.FOLLOWUP_CONVERSATION_WINDOW_DAYS, 30),
    replyDelayMinSeconds: number(process.env.FOLLOWUP_REPLY_DELAY_MIN_SECONDS, 5),
    replyDelayMaxSeconds: number(process.env.FOLLOWUP_REPLY_DELAY_MAX_SECONDS, 10)
  },
  llm: {
    provider: process.env.LLM_PROVIDER || 'ollama',
    classificationMode: process.env.CLASSIFICATION_MODE || 'ai_only',
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    ollamaModel: process.env.OLLAMA_MODEL || 'qwen2.5:7b',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    geminiModel: process.env.GEMINI_MODEL || 'gemini-3.8-flash'
  },
  autoSendFollowup: bool(process.env.AUTO_SEND_FOLLOWUP, true)
};

export function validateConfigForStart() {
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is required.');
  }

  if (config.nodeEnv === 'production') {
    if (!config.admin.password && !config.admin.passwordHash) {
      throw new Error('ADMIN_PASSWORD or ADMIN_PASSWORD_HASH is required in production.');
    }
    if (!config.admin.sessionSecret || config.admin.sessionSecret.length < 24) {
      throw new Error('SESSION_SECRET must be at least 24 characters in production.');
    }
  }
}
