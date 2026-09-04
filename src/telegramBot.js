import { Telegraf } from 'telegraf';
import { config } from './config.js';
import { createJobFromImage, processJobOcr, saveIncomingImage } from './services/jobs.js';
import { setEscalationTelegramBot } from './services/escalations.js';
import { getRuntimeSettings, setSetting } from './services/settings.js';
import { addWorkerLog, getWorkerLogs } from './services/workerLogs.js';
import { errorToLogMeta } from './utils/errors.js';

const telegramWorker = {
  bot: null,
  state: 'stopped',
  startedAt: null,
  stoppedAt: null,
  lastError: null,
  botUsername: null
};

function isSendableChatTarget(value) {
  const target = String(value || '').trim();
  return /^-?\d+$/.test(target) || /^@[a-zA-Z0-9_]{5,}$/.test(target);
}

function configuredTitle(value) {
  const target = String(value || '').trim();
  if (!target || isSendableChatTarget(target) || /^(https?:\/\/)?t\.me\/\+/i.test(target)) return '';
  return target;
}

function isAllowedAdmin(ctx) {
  if (!config.telegram.adminUserIds.length) return true;
  const userId = ctx.from?.id ? String(ctx.from.id) : '';
  return config.telegram.adminUserIds.includes(userId);
}

async function bindChat(ctx, key) {
  if (!isAllowedAdmin(ctx)) {
    await ctx.reply('Not allowed.');
    return;
  }
  await setSetting(key, String(ctx.chat.id));
  addWorkerLog('telegram', 'info', `Saved ${key}`, {
    chatId: String(ctx.chat.id),
    chatTitle: ctx.chat.title || ''
  });
  await ctx.reply(`Saved ${key}: ${ctx.chat.id}`);
}

async function autoBindConfiguredChat(ctx) {
  if (!ctx.chat?.id || !ctx.chat?.title) return;
  const settings = await getRuntimeSettings();
  const chatId = String(ctx.chat.id);

  if (!settings.telegramJobChatId && ctx.chat.title === settings.telegramJobChatTitle) {
    await setSetting('telegramJobChatId', chatId);
    addWorkerLog('telegram', 'info', 'Auto-bound telegramJobChatId from matching group title', {
      chatId,
      chatTitle: ctx.chat.title
    });
  }

  const managerTitle = configuredTitle(settings.telegramManagerChatId);
  if (managerTitle && ctx.chat.title === managerTitle) {
    await setSetting('telegramManagerChatId', chatId);
    addWorkerLog('telegram', 'info', 'Auto-bound telegramManagerChatId from matching group title', {
      chatId,
      chatTitle: ctx.chat.title
    });
    await ctx.reply(`Saved telegramManagerChatId: ${ctx.chat.id}`);
  }
}

function chatMatchesJobSource(settings, chat) {
  const chatId = String(chat.id);
  if (settings.telegramJobChatId) return chatId === String(settings.telegramJobChatId);
  return chat.title === settings.telegramJobChatTitle;
}

async function downloadTelegramFile(ctx, fileId) {
  const link = await ctx.telegram.getFileLink(fileId);
  const response = await fetch(link);
  if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function senderName(from = {}) {
  return [from.first_name, from.last_name].filter(Boolean).join(' ').trim() || from.username || '';
}

function createBot(token) {
  const bot = new Telegraf(token);
  bot.use(async (ctx, next) => {
    await autoBindConfiguredChat(ctx).catch((error) => {
      addWorkerLog('telegram', 'warn', 'Telegram auto-bind failed', errorToLogMeta(error, {
        chatId: ctx.chat?.id ? String(ctx.chat.id) : '',
        chatTitle: ctx.chat?.title || ''
      }));
    });
    return next();
  });

  bot.command('chatid', async (ctx) => {
    await ctx.reply(`Chat ID: ${ctx.chat.id}\nTitle: ${ctx.chat.title || 'private chat'}`);
  });

  bot.command('bind_jobs', async (ctx) => bindChat(ctx, 'telegramJobChatId'));
  bot.command('bind_manager', async (ctx) => bindChat(ctx, 'telegramManagerChatId'));

  bot.on('photo', async (ctx) => {
    const settings = await getRuntimeSettings();
    if (!chatMatchesJobSource(settings, ctx.chat)) return;

    const photos = ctx.message.photo || [];
    const largest = photos[photos.length - 1];
    if (!largest) return;

    try {
      addWorkerLog('telegram', 'info', 'Job image received', {
        chatId: String(ctx.chat.id),
        chatTitle: ctx.chat.title || '',
        messageId: String(ctx.message.message_id),
        senderId: ctx.from?.id ? String(ctx.from.id) : '',
        senderUsername: ctx.from?.username || '',
        senderName: senderName(ctx.from),
        fileId: largest.file_id
      });
      const buffer = await downloadTelegramFile(ctx, largest.file_id);
      const imagePath = await saveIncomingImage(buffer, `telegram-${ctx.chat.id}-${ctx.message.message_id}.jpg`);
      const job = await createJobFromImage({
        source: 'telegram',
        sourceChatId: String(ctx.chat.id),
        sourceChatTitle: ctx.chat.title || null,
        sourceMessageId: String(ctx.message.message_id),
        sourceSenderId: ctx.from?.id ? String(ctx.from.id) : null,
        sourceSenderUsername: ctx.from?.username || null,
        sourceSenderName: senderName(ctx.from) || null,
        sourceSenderIsBot: typeof ctx.from?.is_bot === 'boolean' ? ctx.from.is_bot : null,
        telegramFileId: largest.file_id,
        imagePath,
        imageMime: 'image/jpeg'
      });
      addWorkerLog('telegram', 'info', 'Job image saved', {
        jobId: job.id,
        imagePath,
        sourceMessageId: String(ctx.message.message_id),
        sourceSenderId: job.sourceSenderId || ''
      });

      if (settings.telegramAckEnabled) {
        await ctx.reply(`Received job image. Processing OCR for job ${job.id.slice(0, 8)}.`);
      }

      processJobOcr(job.id)
        .then((processed) => {
          addWorkerLog('telegram', 'info', 'OCR completed', {
            jobId: processed.id,
            status: processed.status,
            customerName: processed.customerName || ''
          });
        })
        .catch(async (error) => {
          addWorkerLog('telegram', 'error', 'OCR failed', errorToLogMeta(error, { jobId: job.id }));
          if (settings.telegramAckEnabled) {
            await ctx.reply(`OCR failed for job ${job.id.slice(0, 8)}: ${error.message}`);
          }
        });
    } catch (error) {
      addWorkerLog('telegram', 'error', 'Photo processing failed', errorToLogMeta(error));
      if (settings.telegramAckEnabled) await ctx.reply(`Failed to process image: ${error.message}`);
    }
  });

  bot.catch((error, ctx) => {
    addWorkerLog('telegram', 'error', 'Telegram update failed', errorToLogMeta(error, {
      updateType: ctx.updateType || ''
    }));
  });

  return bot;
}

export async function getTelegramWorkerStatus() {
  const settings = await getRuntimeSettings();
  return {
    state: telegramWorker.state,
    running: telegramWorker.state === 'running',
    configured: Boolean(settings.telegramBotToken),
    startedAt: telegramWorker.startedAt,
    stoppedAt: telegramWorker.stoppedAt,
    lastError: telegramWorker.lastError,
    botUsername: telegramWorker.botUsername,
    jobChatTitle: settings.telegramJobChatTitle,
    jobChatId: settings.telegramJobChatId,
    managerChatId: settings.telegramManagerChatId,
    ackEnabled: settings.telegramAckEnabled,
    logs: getWorkerLogs({ worker: 'telegram', limit: 75 })
  };
}

export async function startTelegramBot({ reason = 'manual' } = {}) {
  if (telegramWorker.bot || telegramWorker.state === 'starting') {
    return getTelegramWorkerStatus();
  }

  const settings = await getRuntimeSettings();
  if (!settings.telegramBotToken) {
    telegramWorker.state = 'stopped';
    telegramWorker.lastError = 'Telegram bot token is not configured.';
    addWorkerLog('telegram', 'warn', telegramWorker.lastError, { reason });
    return getTelegramWorkerStatus();
  }

  telegramWorker.state = 'starting';
  telegramWorker.lastError = null;
  addWorkerLog('telegram', 'info', 'Starting Telegram worker', { reason });

  const bot = createBot(settings.telegramBotToken);
  try {
    const me = await bot.telegram.getMe();
    telegramWorker.botUsername = me.username || null;
    const launchPromise = bot.launch();
    telegramWorker.bot = bot;
    telegramWorker.state = 'running';
    telegramWorker.startedAt = new Date().toISOString();
    telegramWorker.stoppedAt = null;
    setEscalationTelegramBot(bot);
    addWorkerLog('telegram', 'info', 'Telegram worker started', {
      botUsername: telegramWorker.botUsername || '',
      jobChatId: settings.telegramJobChatId || '',
      jobChatTitle: settings.telegramJobChatTitle || ''
    });
    if (settings.telegramManagerChatId && !isSendableChatTarget(settings.telegramManagerChatId)) {
      addWorkerLog('telegram', 'warn', 'Telegram manager chat target is not directly sendable', {
        managerChatId: settings.telegramManagerChatId,
        hint: 'Send /bind_manager inside the manager group to save the numeric chat ID.'
      });
    }
    launchPromise.catch((error) => {
      if (telegramWorker.bot !== bot) return;
      telegramWorker.bot = null;
      telegramWorker.state = 'error';
      telegramWorker.lastError = error.message;
      telegramWorker.stoppedAt = new Date().toISOString();
      setEscalationTelegramBot(null);
      addWorkerLog('telegram', 'error', 'Telegram worker polling failed', errorToLogMeta(error));
    });
  } catch (error) {
    try {
      bot.stop('start-failed');
    } catch {
      // The bot may fail before polling starts.
    }
    telegramWorker.bot = null;
    telegramWorker.state = 'error';
    telegramWorker.lastError = error.message;
    telegramWorker.stoppedAt = new Date().toISOString();
    setEscalationTelegramBot(null);
    addWorkerLog('telegram', 'error', 'Telegram worker failed to start', errorToLogMeta(error));
  }

  return getTelegramWorkerStatus();
}

export async function stopTelegramBot({ reason = 'manual' } = {}) {
  if (!telegramWorker.bot) {
    telegramWorker.state = 'stopped';
    telegramWorker.stoppedAt = telegramWorker.stoppedAt || new Date().toISOString();
    setEscalationTelegramBot(null);
    return getTelegramWorkerStatus();
  }

  telegramWorker.state = 'stopping';
  addWorkerLog('telegram', 'info', 'Stopping Telegram worker', { reason });

  try {
    telegramWorker.bot.stop(reason);
    telegramWorker.lastError = null;
    addWorkerLog('telegram', 'info', 'Telegram worker stopped', { reason });
  } catch (error) {
    telegramWorker.lastError = error.message;
    addWorkerLog('telegram', 'error', 'Telegram worker stop failed', errorToLogMeta(error));
  } finally {
    telegramWorker.bot = null;
    telegramWorker.state = 'stopped';
    telegramWorker.stoppedAt = new Date().toISOString();
    setEscalationTelegramBot(null);
  }

  return getTelegramWorkerStatus();
}
