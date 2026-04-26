const express = require('express');
const { authMiddleware } = require('../lib/auth');
const { llmAdmissionMiddleware } = require('../lib/llm/admission-control');
const { hubErrorHandler } = require('./middleware/error-handler');
const {
  createShutdownGuard,
  pathGuardMiddleware,
  requestLoggingMiddleware,
} = require('./middleware/request-lifecycle');
const { hubRequestContextMiddleware } = require('./middleware/request-context');
const { createHubRateLimiters } = require('./rate-limiters');
const { registerHubRoutes } = require('./route-registry');

export function createHubApp(options) {
  const app = express();
  const isShuttingDown = options?.isShuttingDown || (() => false);
  const isStartupComplete = options?.isStartupComplete || (() => true);

  app.use(express.json({ limit: '1mb' }));
  app.use(createShutdownGuard(isShuttingDown));
  app.use(pathGuardMiddleware);
  app.use(hubRequestContextMiddleware);
  app.use(requestLoggingMiddleware);

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
