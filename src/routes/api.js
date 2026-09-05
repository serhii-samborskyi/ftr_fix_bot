import express from 'express';
import fs from 'node:fs/promises';
import multer from 'multer';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db.js';
import { pingBlueBubbles } from '../services/bluebubbles.js';
import { addWorkerLog, getWorkerLogs } from '../services/workerLogs.js';
import { errorToLogMeta } from '../utils/errors.js';
import {
  createJobFromImage,
  deleteJob,
  getDashboardStats,
  getConversation,
  getJob,
  listRecentConversations,
  listJobs,
  processJobOcr,
  refreshJobDeliveryStatus,
  saveIncomingImage,
  sendManualJobMessage,
  sendInitialFollowup,
  updateJob
} from '../services/jobs.js';
import { getPublicSettings, updatePublicSettings } from '../services/settings.js';
import { createTechnician, deleteTechnician, listTechnicians, updateTechnician } from '../services/techs.js';
import { getTelegramWorkerStatus, startTelegramBot, stopTelegramBot } from '../telegramBot.js';
import { dateRangeForFilter } from '../utils/time.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

export const apiRouter = express.Router();

function filterParams(req) {
  return {
    range: String(req.query.range || 'today'),
    from: String(req.query.from || ''),
    to: String(req.query.to || ''),
    techId: String(req.query.techId || '')
  };
}

async function countFiles(dir) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }

  let count = 0;
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) count += await countFiles(fullPath);
    else if (entry.isFile()) count += 1;
  }
  return count;
}

function databaseTarget() {
  try {
    const url = new URL(config.databaseUrl);
    return {
      host: url.hostname,
      port: url.port,
      database: url.pathname.replace(/^\/+/, '')
    };
  } catch {
    return { host: '', port: '', database: '' };
  }
}

apiRouter.get('/jobs', async (req, res, next) => {
  try {
    const jobs = await listJobs(filterParams(req));
    res.json({ jobs });
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/stats', async (req, res, next) => {
  try {
    res.json({ stats: await getDashboardStats(filterParams(req)) });
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/conversations/recent', async (req, res, next) => {
  try {
    res.json({ conversations: await listRecentConversations(filterParams(req)) });
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/jobs/upload', upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Image file is required.' });
    const imagePath = await saveIncomingImage(req.file.buffer, req.file.originalname || 'upload.jpg');
    const job = await createJobFromImage({ source: 'manual', imagePath, imageMime: req.file.mimetype });
    processJobOcr(job.id).catch((error) => {
      addWorkerLog('ocr', 'error', 'Manual OCR job failed', errorToLogMeta(error, { jobId: job.id }));
    });
    res.status(201).json({ job });
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/jobs/:id', async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({ job });
  } catch (error) {
    next(error);
  }
});

apiRouter.patch('/jobs/:id', async (req, res, next) => {
  try {
    const schema = z.object({
      customerName: z.string().optional(),
      phone: z.string().optional(),
      primaryPhone: z.string().optional(),
      accountNumber: z.string().optional(),
      address: z.string().optional(),
      status: z.string().optional(),
      followupStatus: z.string().optional(),
      aiIgnore: z.boolean().optional()
    });
    const job = await updateJob(req.params.id, schema.parse(req.body));
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({ job });
  } catch (error) {
    next(error);
  }
});

apiRouter.delete('/jobs/:id', async (req, res, next) => {
  try {
    const job = await deleteJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({ ok: true, job });
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/jobs/:id/reprocess', async (req, res, next) => {
  try {
    const job = await processJobOcr(req.params.id);
    res.json({ job });
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/jobs/:id/send-followup', async (req, res, next) => {
  try {
    const job = await sendInitialFollowup(req.params.id);
    res.json({ job });
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/jobs/:id/check-delivery', async (req, res, next) => {
  try {
    const result = await refreshJobDeliveryStatus(req.params.id);
    res.json({ job: result.job, delivery: result.delivery });
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/jobs/:id/conversation', async (req, res, next) => {
  try {
    const schema = z.object({
      message: z.string().trim().min(1)
    });
    const result = await sendManualJobMessage(req.params.id, schema.parse(req.body).message);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/jobs/:id/conversation', async (req, res, next) => {
  try {
    const messages = await getConversation(req.params.id);
    res.json({ messages });
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/jobs/:id/image', async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.sendFile(job.imagePath);
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/settings', async (req, res, next) => {
  try {
    res.json({ settings: await getPublicSettings() });
  } catch (error) {
    next(error);
  }
});

apiRouter.patch('/settings', async (req, res, next) => {
  try {
    res.json({ settings: await updatePublicSettings(req.body || {}) });
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/technicians', async (req, res, next) => {
  try {
    res.json({ technicians: await listTechnicians() });
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/technicians', async (req, res, next) => {
  try {
    const schema = z.object({
      name: z.string().trim().min(1),
      techId: z.string().trim().min(1),
      telegramId: z.string().trim().min(1)
    });
    res.status(201).json({ technician: await createTechnician(schema.parse(req.body)) });
  } catch (error) {
    next(error);
  }
});

apiRouter.patch('/technicians/:id', async (req, res, next) => {
  try {
    const schema = z.object({
      name: z.string().trim().min(1),
      techId: z.string().trim().min(1),
      telegramId: z.string().trim().min(1)
    });
    const technician = await updateTechnician(req.params.id, schema.parse(req.body));
    if (!technician) return res.status(404).json({ error: 'Technician not found' });
    res.json({ technician });
  } catch (error) {
    next(error);
  }
});

apiRouter.delete('/technicians/:id', async (req, res, next) => {
  try {
    const technician = await deleteTechnician(req.params.id);
    if (!technician) return res.status(404).json({ error: 'Technician not found' });
    res.json({ ok: true, technician });
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/system/status', async (req, res, next) => {
  try {
    const settings = await getPublicSettings();
    const today = dateRangeForFilter({ range: 'today', timeZone: settings.appTimeZone });
    const result = await query(`
      SELECT current_database() AS database_name,
             current_setting('TimeZone') AS db_timezone,
             now() AS db_now,
             count(*)::int AS total_jobs,
             count(*) FILTER (WHERE created_at >= $1 AND created_at < $2)::int AS today_jobs,
             max(created_at) AS newest_job_at
      FROM jobs
    `, [today.start, today.end]);
    res.json({
      system: {
        appTimeZone: settings.appTimeZone,
        database: {
          ...databaseTarget(),
          ...result.rows[0]
        },
        storage: {
          dataDir: config.dataDir,
          imageCount: await countFiles(path.join(config.dataDir, 'images'))
        }
      }
    });
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/settings/test-bluebubbles', async (req, res, next) => {
  try {
    const result = await pingBlueBubbles();
    addWorkerLog('bluebubbles', 'info', 'BlueBubbles ping succeeded', { message: result.message || '' });
    res.json({ result });
  } catch (error) {
    addWorkerLog('bluebubbles', 'error', 'BlueBubbles ping failed', errorToLogMeta(error));
    next(error);
  }
});

apiRouter.get('/workers/status', async (req, res, next) => {
  try {
    res.json({ telegram: await getTelegramWorkerStatus(), logs: getWorkerLogs({ limit: 125 }) });
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/workers/telegram/start', async (req, res, next) => {
  try {
    res.json({ telegram: await startTelegramBot({ reason: 'ui' }) });
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/workers/telegram/stop', async (req, res, next) => {
  try {
    res.json({ telegram: await stopTelegramBot({ reason: 'ui' }) });
  } catch (error) {
    next(error);
  }
});
