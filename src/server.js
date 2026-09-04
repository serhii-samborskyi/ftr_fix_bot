import fs from 'node:fs/promises';
import path from 'node:path';
import cookieSession from 'cookie-session';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { fileURLToPath } from 'node:url';
import { config, validateConfigForStart } from './config.js';
import { closeDb, runMigrations } from './db.js';
import { apiRouter } from './routes/api.js';
import { authRouter, requireAuth } from './routes/auth.js';
import { webhookRouter } from './routes/webhooks.js';
import { startTelegramBot, stopTelegramBot } from './telegramBot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');

function sessionSecret() {
  if (config.admin.sessionSecret) return config.admin.sessionSecret;
  if (config.nodeEnv !== 'production') return 'dev-session-secret-change-me';
  return '';
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  console.error('[http]', error);
  const status = error.status || error.statusCode || 500;
  res.status(status).json({ error: error.message || 'Server error' });
}

async function createApp() {
  await fs.mkdir(path.join(config.dataDir, 'images'), { recursive: true });

  const app = express();
  app.set('trust proxy', 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'"]
        }
      }
    })
  );
  app.use(morgan(config.nodeEnv === 'production' ? 'combined' : 'dev'));
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(
    cookieSession({
      name: 'ftr_fix_session',
      keys: [sessionSecret()],
      httpOnly: true,
      sameSite: 'lax',
      secure: config.nodeEnv === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000
    })
  );

  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.get('/favicon.ico', (req, res) => res.status(204).end());
  app.get('/login', (req, res) => res.sendFile(path.join(publicDir, 'login.html')));
  app.use('/assets', express.static(path.join(publicDir, 'assets'), { maxAge: '1h' }));
  app.use('/auth', authRouter);
  app.use('/webhooks', webhookRouter);
  app.use('/api', requireAuth, apiRouter);
  app.get('/', requireAuth, (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
  app.use(errorHandler);
  return app;
}

async function main() {
  validateConfigForStart();
  await runMigrations();

  if (process.argv.includes('--migrate-only')) {
    await closeDb();
    return;
  }

  const app = await createApp();
  const server = app.listen(config.port, () => {
    console.log(`[http] listening on :${config.port}`);
  });
  await startTelegramBot({ reason: 'startup' });

  const shutdown = async () => {
    console.log('[shutdown] stopping');
    server.close(async () => {
      await stopTelegramBot({ reason: 'shutdown' });
      await closeDb();
      process.exit(0);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch(async (error) => {
  console.error(error);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
