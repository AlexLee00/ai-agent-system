import type { Express } from 'express';

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
const { stageDChaosMiddleware } = require('./middleware/stage-d-chaos');
const { createHubRateLimiters } = require('./rate-limiters');
const { registerHubRoutes } = require('./route-registry');
const { parsePositiveIntEnv } = require('./env-utils');

type RuntimeFlag = () => boolean;

type HubAppOptions = {
  isShuttingDown?: RuntimeFlag;
  isStartupComplete?: RuntimeFlag;
};

function jsonLimitMb(name: string, fallback: number): string {
  return `${parsePositiveIntEnv(name, fallback)}mb`;
}

function createJsonParser(limit: string) {
  return express.json({
    limit,
    verify: (req: any, _res: any, buf: Buffer) => { req.rawBody = buf; },
  });
}

export function routeClassForBodyLimit(pathname: string): 'llm' | 'events' | 'memory' | 'default' {
  const p = String(pathname || '');
  if (p.startsWith('/hub/llm/')) return 'llm';
  if (p === '/hub/events/publish' || p === '/events/publish') return 'events';
  if (p.startsWith('/hub/memory/')) return 'memory';
  return 'default';
}

export function createHubApp(options: HubAppOptions = {}): Express {
  const app = express();
  const isShuttingDown = options?.isShuttingDown || (() => false);
  const isStartupComplete = options?.isStartupComplete || (() => true);
  const jsonParsers = {
    default: createJsonParser(jsonLimitMb('HUB_JSON_LIMIT_MB', 1)),
    events: createJsonParser(jsonLimitMb('HUB_EVENTS_JSON_LIMIT_MB', 4)),
    llm: createJsonParser(jsonLimitMb('HUB_LLM_JSON_LIMIT_MB', 8)),
    memory: createJsonParser(jsonLimitMb('HUB_MEMORY_JSON_LIMIT_MB', 8)),
  };

  app.use(createShutdownGuard(isShuttingDown));
  app.use(pathGuardMiddleware);
  app.use(hubRequestContextMiddleware);
  app.use(requestLoggingMiddleware);
  app.use((req: any, res: any, next: any) => {
    const routeClass = routeClassForBodyLimit(req.path || req.originalUrl || '');
    req.hubBodyRouteClass = routeClass;
    return jsonParsers[routeClass](req, res, next);
  });
  app.use(stageDChaosMiddleware);

  const {
    generalLimiter,
    alarmLimiter,
    eventsLimiter,
    pgLimiter,
    secretsLimiter,
    llmLimiter,
  } = createHubRateLimiters();

  registerHubRoutes(app, {
    isShuttingDown,
    isStartupComplete,
    authMiddleware,
    generalLimiter,
    alarmLimiter,
    eventsLimiter,
    pgLimiter,
    secretsLimiter,
    llmLimiter,
    llmAdmissionMiddleware,
  });

  app.use(hubErrorHandler);

  return app;
}
