import bcrypt from 'bcryptjs';
import express from 'express';
import { config } from '../config.js';

export const authRouter = express.Router();

async function passwordMatches(password) {
  if (config.admin.passwordHash) return bcrypt.compare(password, config.admin.passwordHash);
  if (config.admin.password) return password === config.admin.password;
  return config.nodeEnv !== 'production' && password === 'admin';
}

export function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  if (req.baseUrl === '/api' || req.originalUrl.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return res.redirect('/login');
}

authRouter.post('/login', async (req, res) => {
  const username = String(req.body.username || '');
  const password = String(req.body.password || '');

  if (username === config.admin.username && (await passwordMatches(password))) {
    req.session.user = { username };
    return res.json({ ok: true });
  }

  return res.status(401).json({ error: 'Invalid username or password' });
});

authRouter.post('/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

authRouter.get('/me', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ user: req.session.user });
});
