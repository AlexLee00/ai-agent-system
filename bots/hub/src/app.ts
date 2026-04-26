const express = require('express');
const { authMiddleware } = require('../lib/auth');
const { llmAdmissionMiddleware } = require('../lib/llm/admission-control');
const { hubErrorHandler } = require('./middleware/error-handler');
const { hubRequestContextMiddleware } = require('./middleware/request-context');
const { createHubRateLimiters } = require('./rate-limiters');
const { registerHubRoutes } = require('./route-registry');

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

  const {
    generalLimiter,
    pgLimiter,
    secretsLimiter,
    llmLimiter,
  } = createHubRateLimiters();

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

  app.use(hubErrorHandler);

  return app;
}
