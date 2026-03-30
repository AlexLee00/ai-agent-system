'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const env = require('../../../packages/core/lib/env');
const { authMiddleware } = require('../lib/auth');
const { healthRoute } = require('../lib/routes/health');
const { pgQueryRoute } = require('../lib/routes/pg');
const { n8nWebhookRoute, n8nHealthRoute } = require('../lib/routes/n8n');
const { servicesStatusRoute, envRoute } = require('../lib/routes/services');
const { secretsRoute } = require('../lib/routes/secrets');
const { errorsRecentRoute, errorsSummaryRoute } = require('../lib/routes/errors');

env.ensureOps('Resource API Hub');
env.printModeBanner('Resource API Hub');

const app = express();
const PORT = env.HUB_PORT || 7788;

app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - started;
    const tag = res.statusCode >= 400 ? '⚠️' : '✅';
    console.log(`${tag} ${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
  });
  next();
});

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate limit exceeded (100/min)' },
});

const pgLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'DB query rate limit exceeded (30/min)' },
});

app.get('/hub/health', generalLimiter, healthRoute);

app.use('/hub', authMiddleware);

app.post('/hub/pg/query', pgLimiter, pgQueryRoute);
app.post('/hub/n8n/webhook/:path', generalLimiter, n8nWebhookRoute);
app.get('/hub/n8n/health', generalLimiter, n8nHealthRoute);
app.get('/hub/services/status', generalLimiter, servicesStatusRoute);
app.get('/hub/env', generalLimiter, envRoute);
app.get('/hub/errors/recent', generalLimiter, errorsRecentRoute);
app.get('/hub/errors/summary', generalLimiter, errorsSummaryRoute);

const secretsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'secrets rate limit exceeded (10/min)' },
});
app.get('/hub/secrets/:category', secretsLimiter, secretsRoute);

app.use('/hub', (req, res) => {
  res.status(404).json({ error: `unknown endpoint: ${req.method} ${req.path}` });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Resource API Hub 시작 — http://0.0.0.0:${PORT}/hub/health`);
  console.log(`   인증: ${env.HUB_AUTH_TOKEN ? 'Bearer Token 활성' : '⚠️ HUB_AUTH_TOKEN 미설정'}`);
});

process.on('uncaughtException', (error) => {
  console.error('[hub] uncaughtException:', error);
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  console.error('[hub] unhandledRejection:', error);
});
