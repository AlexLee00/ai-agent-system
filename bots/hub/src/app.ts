const express = require('express');
const rateLimitModule = require('express-rate-limit');
const rateLimit = rateLimitModule.default || rateLimitModule;
const { authMiddleware } = require('../lib/auth');
const { llmAdmissionMiddleware } = require('../lib/llm/admission-control');
const { hubRequestContextMiddleware } = require('./middleware/request-context');
const { registerHubRoutes } = require('./route-registry');

function parsePositiveIntEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export function createHubApp(options) {
  const app = express();
  const isShuttingDown = options?.isShuttingDown || (() => false);
  const isStartupComplete = options?.isStartupComplete || (() => true);

  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    if (isShuttingDown()) {
      res.set('Connection', 'close');
      return res.status(503).json({ error: 'server shutting down' });
    }
    return next();
  });
  app.use((req, res, next) => {
    const reqPath = String(req.path || '');
    if (reqPath.length > 500) {
      return res.status(414).json({ error: 'URI too long' });
    }
    if (/(.)\1{50,}/.test(reqPath)) {
      return res.status(400).json({ error: 'invalid path pattern' });
    }
    return next();
  });
  app.use(hubRequestContextMiddleware);
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - started;
      const tag = res.statusCode >= 400 ? '⚠️' : '✅';
      const traceId = req.hubRequestContext?.traceId || '-';
      console.log(`${tag} ${req.method} ${req.path} → ${res.statusCode} (${ms}ms) trace=${traceId}`);
    });
    next();
  });

  const generalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'rate limit exceeded (200/min)' },
  });

  const pgLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'DB query rate limit exceeded (120/min)' },
  });

  const secretsRateLimitPerMinute = parsePositiveIntEnv('HUB_SECRETS_RATE_LIMIT_PER_MIN', 240);
  const secretsLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: secretsRateLimitPerMinute,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: `secrets rate limit exceeded (${secretsRateLimitPerMinute}/min)` },
  });

  const llmRateLimitPerMinute = parsePositiveIntEnv('HUB_LLM_RATE_LIMIT_PER_MIN', 120);
  const llmLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: llmRateLimitPerMinute,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: `LLM rate limit exceeded (${llmRateLimitPerMinute}/min)` },
    skip: (req) => String(req.headers['x-hub-load-test'] || '').trim() === '1',
  });

  registerHubRoutes(app, {
    isShuttingDown,
    isStartupComplete,
    authMiddleware,
    generalLimiter,
    pgLimiter,
    secretsLimiter,
    llmLimiter,
    llmAdmissionMiddleware,
  });

  return app;
}
