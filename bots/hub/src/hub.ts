const express = require('express');
const rateLimitModule = require('express-rate-limit');
const rateLimit = rateLimitModule.default || rateLimitModule;
const env = require('../../../packages/core/lib/env');
const { authMiddleware } = require('../lib/auth');
const pgPool = require('../../../packages/core/lib/pg-pool');
const { healthRoute, healthReadyRoute } = require('../lib/routes/health');
const { alarmRoute } = require('../lib/routes/alarm');
const { pgQueryRoute } = require('../lib/routes/pg');
const { n8nWebhookRoute, n8nHealthRoute } = require('../lib/routes/n8n');
const { servicesStatusRoute, envRoute } = require('../lib/routes/services');
const { secretsRoute } = require('../lib/routes/secrets');
const { errorsRecentRoute, errorsSummaryRoute } = require('../lib/routes/errors');
const {
  eventsSearchRoute,
  eventsStatsRoute,
  eventsFeedbackRoute,
  commandEventsRecentRoute,
  commandEventsSummaryRoute,
  commandEventsStuckRoute,
  commandEventsInboxRoute,
  commandEventsLifecycleRoute,
} = require('../lib/routes/events');
const { logsSearchRoute, logsStatsRoute } = require('../lib/routes/logs');
const { darwinCallbackRoute } = require('../lib/routes/darwin-callback');
const { memoryRememberRoute, memoryRecallRoute } = require('../lib/routes/memory');
const {
  agentsListRoute,
  agentsDashboardRoute,
  agentsAlwaysOnRoute,
  agentsTraceStatsRoute,
  agentsSelectRoute,
  agentsLowPerformersRoute,
  agentsHireRoute,
  agentsEvaluateRoute,
  agentsCompetitionStartRoute,
  agentsCompetitionCompleteRoute,
  agentsCompetitionHistoryRoute,
  skillsListRoute,
  skillsSelectRoute,
  skillsEvaluateRoute,
  toolsListRoute,
  toolsSelectRoute,
  toolsEvaluateRoute,
  runtimeSelectRoute,
  agentTraceStatsRoute,
  agentDetailRoute,
} = require('../lib/routes/agents');

env.ensureOps('Resource API Hub');
env.printModeBanner('Resource API Hub');

const app = express();
const PORT = env.HUB_PORT || 7788;
const SHUTDOWN_TIMEOUT_MS = 10000;
const UNCAUGHT_OVERFLOW_LIMIT = 3;
const UNCAUGHT_RESET_MS = 5 * 60 * 1000;

let server: any = null;
let isShuttingDown = false;
let startupComplete = false;
let uncaughtCount = 0;
let uncaughtResetTimer: ReturnType<typeof setTimeout> | null = null;
const activeConnections = new Set<any>();

app.use(express.json({ limit: '1mb' }));
app.use((req: any, res: any, next: any) => {
  if (isShuttingDown) {
    res.set('Connection', 'close');
    return res.status(503).json({ error: 'server shutting down' });
  }
  return next();
});
app.use((req: any, res: any, next: any) => {
  const reqPath = String(req.path || '');
  if (reqPath.length > 500) {
    return res.status(414).json({ error: 'URI too long' });
  }
  if (/(.)\1{50,}/.test(reqPath)) {
    return res.status(400).json({ error: 'invalid path pattern' });
  }
  return next();
});

app.use((req: any, res: any, next: any) => {
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

app.get('/hub/health', generalLimiter, healthRoute);
app.get('/hub/health/live', generalLimiter, (_req: any, res: any) => {
  return res.status(isShuttingDown ? 503 : 200).json({
    status: isShuttingDown ? 'shutting_down' : 'ok',
    live: !isShuttingDown,
    mode: env.MODE,
    uptime_s: Math.round(process.uptime()),
  });
});
app.get('/hub/health/ready', generalLimiter, healthReadyRoute);
app.get('/hub/health/startup', generalLimiter, (_req: any, res: any) => {
  const startupOk = startupComplete && !isShuttingDown;
  return res.status(startupOk ? 200 : 503).json({
    status: startupOk ? 'ok' : (isShuttingDown ? 'shutting_down' : 'starting'),
    startup_complete: startupComplete,
    shutting_down: isShuttingDown,
    mode: env.MODE,
    uptime_s: Math.round(process.uptime()),
  });
});

app.use('/hub', authMiddleware);

app.post('/hub/pg/query', pgLimiter, pgQueryRoute);
app.post('/hub/alarm', generalLimiter, alarmRoute);
app.post('/hub/n8n/webhook/:path', generalLimiter, n8nWebhookRoute);
app.get('/hub/n8n/health', generalLimiter, n8nHealthRoute);
app.get('/hub/services/status', generalLimiter, servicesStatusRoute);
app.get('/hub/env', generalLimiter, envRoute);
app.get('/hub/errors/recent', generalLimiter, errorsRecentRoute);
app.get('/hub/errors/summary', generalLimiter, errorsSummaryRoute);
app.get('/hub/events/search', generalLimiter, eventsSearchRoute);
app.get('/hub/events/commands', generalLimiter, commandEventsRecentRoute);
app.get('/hub/events/commands/summary', generalLimiter, commandEventsSummaryRoute);
app.get('/hub/events/commands/stuck', generalLimiter, commandEventsStuckRoute);
app.get('/hub/events/commands/inbox', generalLimiter, commandEventsInboxRoute);
app.post('/hub/events/commands/lifecycle', generalLimiter, commandEventsLifecycleRoute);
app.get('/hub/events/stats', generalLimiter, eventsStatsRoute);
app.post('/hub/events/feedback', generalLimiter, eventsFeedbackRoute);
app.get('/hub/logs/search', generalLimiter, logsSearchRoute);
app.get('/hub/logs/stats', generalLimiter, logsStatsRoute);
app.post('/hub/darwin/callback', generalLimiter, darwinCallbackRoute);
app.post('/hub/memory/remember', generalLimiter, memoryRememberRoute);
app.post('/hub/memory/recall', generalLimiter, memoryRecallRoute);
app.get('/hub/agents', generalLimiter, agentsListRoute);
app.get('/hub/agents/dashboard', generalLimiter, agentsDashboardRoute);
app.get('/hub/agents/always-on', generalLimiter, agentsAlwaysOnRoute);
app.get('/hub/agents/select', generalLimiter, agentsSelectRoute);
app.get('/hub/agents/low-performers', generalLimiter, agentsLowPerformersRoute);
app.get('/hub/agents/stats/traces', generalLimiter, agentsTraceStatsRoute);
app.post('/hub/agents/hire', generalLimiter, agentsHireRoute);
app.post('/hub/agents/evaluate', generalLimiter, agentsEvaluateRoute);
app.post('/hub/agents/competition/start', generalLimiter, agentsCompetitionStartRoute);
app.post('/hub/agents/competition/complete', generalLimiter, agentsCompetitionCompleteRoute);
app.get('/hub/agents/competition/history', generalLimiter, agentsCompetitionHistoryRoute);
app.get('/hub/skills', generalLimiter, skillsListRoute);
app.get('/hub/skills/select', generalLimiter, skillsSelectRoute);
app.post('/hub/skills/evaluate', generalLimiter, skillsEvaluateRoute);
app.get('/hub/tools', generalLimiter, toolsListRoute);
app.get('/hub/tools/select', generalLimiter, toolsSelectRoute);
app.post('/hub/tools/evaluate', generalLimiter, toolsEvaluateRoute);
app.get('/hub/runtime/select', generalLimiter, runtimeSelectRoute);
app.get('/hub/agents/:name/stats/traces', generalLimiter, agentTraceStatsRoute);
app.get('/hub/agents/:name', generalLimiter, agentDetailRoute);

const secretsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'secrets rate limit exceeded (60/min)' },
});
app.get('/hub/secrets/:category', secretsLimiter, secretsRoute);

app.use('/hub', (req: any, res: any) => {
  res.status(404).json({ error: `unknown endpoint: ${req.method} ${req.path}` });
});

function resetUncaughtOverflowTimer() {
  if (uncaughtResetTimer) clearTimeout(uncaughtResetTimer);
  uncaughtResetTimer = setTimeout(() => {
    uncaughtCount = 0;
    uncaughtResetTimer = null;
  }, UNCAUGHT_RESET_MS);
  uncaughtResetTimer.unref?.();
}

async function gracefulShutdown(reason: string, exitCode = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.error(`[hub] ${reason} → graceful shutdown 시작`);

  const forceTimer = setTimeout(() => {
    console.error(`[hub] 강제 종료 (${SHUTDOWN_TIMEOUT_MS}ms 타임아웃)`);
    for (const socket of activeConnections) {
      try { socket.destroy(); } catch {}
    }
    process.exit(exitCode || 1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceTimer.unref?.();

  try {
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    await pgPool.closeAll?.();
    clearTimeout(forceTimer);
    process.exit(exitCode);
  } catch (error) {
    clearTimeout(forceTimer);
    console.error('[hub] graceful shutdown 실패:', error);
    process.exit(1);
  }
}

server = app.listen(PORT, '0.0.0.0', () => {
  startupComplete = true;
  console.log(`🌐 Resource API Hub 시작 — http://0.0.0.0:${PORT}/hub/health`);
  console.log(`   인증: ${env.HUB_AUTH_TOKEN ? 'Bearer Token 활성' : '⚠️ HUB_AUTH_TOKEN 미설정'}`);
});

server.on('connection', (socket: any) => {
  activeConnections.add(socket);
  socket.on('close', () => activeConnections.delete(socket));
});

process.on('SIGTERM', () => { gracefulShutdown('SIGTERM', 0).catch(() => {}); });
process.on('SIGINT', () => { gracefulShutdown('SIGINT', 0).catch(() => {}); });

process.on('uncaughtException', (error: unknown) => {
  uncaughtCount += 1;
  resetUncaughtOverflowTimer();
  console.error(`[hub] uncaughtException #${uncaughtCount}:`, error);
  if (uncaughtCount >= UNCAUGHT_OVERFLOW_LIMIT) {
    gracefulShutdown('uncaught_overflow', 1).catch(() => {});
  }
});

process.on('unhandledRejection', (error: unknown) => {
  console.error('[hub] unhandledRejection:', error);
});
