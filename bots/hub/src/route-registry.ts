const path = require('path');
const express = require('express');
const {
  healthRoute,
  healthReadyRoute,
} = require('../lib/routes/health');
const {
  alarmRoute,
  alarmNoisyProducersRoute,
  alarmSuppressDryRunRoute,
  alarmDigestFlushRoute,
  alarmAutoRepairCallbackRoute,
} = require('../lib/routes/alarm');
const { pgQueryRoute } = require('../lib/routes/pg');
const {
  n8nWebhookRoute,
  n8nHealthRoute,
  n8nWorkflowsRoute,
  n8nTriggerWorkflowRoute,
} = require('../lib/routes/n8n');
const { servicesStatusRoute, envRoute } = require('../lib/routes/services');
const { secretsRoute, secretsMetaRoute, secretsMetaAllRoute } = require('../lib/routes/secrets');
const { errorsRecentRoute, errorsSummaryRoute } = require('../lib/routes/errors');
const {
  eventsSearchRoute,
  eventsStatsRoute,
  eventsFeedbackRoute,
  commandEventsRecentRoute,
  commandEventsSummaryRoute,
  commandEventsStuckRoute,
  commandEventsFailedRoute,
  commandEventsInboxRoute,
  commandEventsLifecycleRoute,
} = require('../lib/routes/events');
const { logsSearchRoute, logsStatsRoute } = require('../lib/routes/logs');
const { darwinCallbackRoute } = require('../lib/routes/darwin-callback');
const { memoryRememberRoute, memoryRecallRoute } = require('../lib/routes/memory');
const {
  legalCaseCreateRoute,
  legalCasesListRoute,
  legalCaseDetailRoute,
  legalCaseStatusRoute,
  legalCaseApproveRoute,
  legalCaseFeedbackRoute,
  legalCaseReportRoute,
} = require('../lib/routes/legal');
const {
  llmCallRoute,
  llmOAuthRoute,
  llmGroqRoute,
  llmStatsRoute,
  llmLoadTestsRoute,
  llmCircuitRoute,
} = require('../lib/routes/llm');
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
const { llmDashboardRoute, llmCacheStatsRoute } = require('../lib/routes/llm-dashboard');
const { llmHealthRoute } = require('../lib/routes/llm-health');
const { reserveBudgetRoute, budgetUsageRoute } = require('../lib/routes/budget');
const { metricsRoute, metricsJsonRoute } = require('../lib/metrics/prometheus-exporter');
const {
  oauthStartRoute,
  oauthCallbackRoute,
  oauthRefreshRoute,
  oauthStatusRoute,
  oauthImportLocalRoute,
  oauthRevokeLocalRoute,
} = require('../lib/oauth/routes');
const {
  controlToolsListRoute,
  controlToolCallRoute,
  controlPlanRoute,
  controlExecuteRoute,
  controlRunStatusRoute,
  controlRunApproveRoute,
  controlRunCancelRoute,
  controlCallbackRoute,
} = require('../lib/routes/control');

export function registerHubRoutes(app, opts) {
  const {
    isShuttingDown,
    isStartupComplete,
    authMiddleware,
    generalLimiter,
    pgLimiter,
    secretsLimiter,
    llmLimiter,
    llmAdmissionMiddleware,
  } = opts;

  app.get('/hub/health', generalLimiter, healthRoute);
  app.get('/hub/health/live', generalLimiter, (_req, res) => {
    const shuttingDown = isShuttingDown();
    return res.status(shuttingDown ? 503 : 200).json({
      status: shuttingDown ? 'shutting_down' : 'ok',
      live: !shuttingDown,
      mode: process.env.MODE || 'unknown',
      uptime_s: Math.round(process.uptime()),
    });
  });
  app.get('/hub/health/ready', generalLimiter, healthReadyRoute);
  app.get('/hub/health/startup', generalLimiter, (_req, res) => {
    const startupOk = isStartupComplete() && !isShuttingDown();
    return res.status(startupOk ? 200 : 503).json({
      status: startupOk ? 'ok' : (isShuttingDown() ? 'shutting_down' : 'starting'),
      startup_complete: isStartupComplete(),
      shutting_down: isShuttingDown(),
      mode: process.env.MODE || 'unknown',
      uptime_s: Math.round(process.uptime()),
    });
  });

  app.use('/hub', authMiddleware);

  app.post('/hub/pg/query', pgLimiter, pgQueryRoute);
  app.post('/hub/alarm', generalLimiter, alarmRoute);
  app.get('/hub/alarm/noisy-producers', generalLimiter, alarmNoisyProducersRoute);
  app.post('/hub/alarm/suppress/dry-run', generalLimiter, alarmSuppressDryRunRoute);
  app.post('/hub/alarm/digest/flush', generalLimiter, alarmDigestFlushRoute);
  app.post('/hub/alarm/auto-repair/callback', generalLimiter, alarmAutoRepairCallbackRoute);
  app.post('/hub/n8n/webhook/:path', generalLimiter, n8nWebhookRoute);
  app.get('/hub/n8n/health', generalLimiter, n8nHealthRoute);
  app.get('/hub/n8n/workflows', generalLimiter, n8nWorkflowsRoute);
  app.post('/hub/n8n/workflows/:workflowId/run', generalLimiter, n8nTriggerWorkflowRoute);
  app.get('/hub/services/status', generalLimiter, servicesStatusRoute);
  app.get('/hub/env', generalLimiter, envRoute);
  app.get('/hub/errors/recent', generalLimiter, errorsRecentRoute);
  app.get('/hub/errors/summary', generalLimiter, errorsSummaryRoute);
  app.get('/hub/events/search', generalLimiter, eventsSearchRoute);
  app.get('/hub/events/commands', generalLimiter, commandEventsRecentRoute);
  app.get('/hub/events/commands/summary', generalLimiter, commandEventsSummaryRoute);
  app.get('/hub/events/commands/stuck', generalLimiter, commandEventsStuckRoute);
  app.get('/hub/events/commands/failed', generalLimiter, commandEventsFailedRoute);
  app.get('/hub/events/commands/inbox', generalLimiter, commandEventsInboxRoute);
  app.post('/hub/events/commands/lifecycle', generalLimiter, commandEventsLifecycleRoute);
  app.get('/hub/events/stats', generalLimiter, eventsStatsRoute);
  app.post('/hub/events/feedback', generalLimiter, eventsFeedbackRoute);
  app.get('/hub/logs/search', generalLimiter, logsSearchRoute);
  app.get('/hub/logs/stats', generalLimiter, logsStatsRoute);
  app.post('/hub/darwin/callback', generalLimiter, darwinCallbackRoute);
  app.post('/hub/memory/remember', generalLimiter, memoryRememberRoute);
  app.post('/hub/memory/recall', generalLimiter, memoryRecallRoute);
  app.post('/hub/legal/case', generalLimiter, legalCaseCreateRoute);
  app.get('/hub/legal/cases', generalLimiter, legalCasesListRoute);
  app.post('/hub/legal/case/:id/approve', generalLimiter, legalCaseApproveRoute);
  app.post('/hub/legal/case/:id/feedback', generalLimiter, legalCaseFeedbackRoute);
  app.get('/hub/legal/case/:id/status', generalLimiter, legalCaseStatusRoute);
  app.get('/hub/legal/case/:id/report', generalLimiter, legalCaseReportRoute);
  app.get('/hub/legal/case/:id', generalLimiter, legalCaseDetailRoute);
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
  app.get('/hub/control/tools', generalLimiter, controlToolsListRoute);
  app.post('/hub/tools/:name/call', generalLimiter, controlToolCallRoute);
  app.post('/hub/control/plan', generalLimiter, controlPlanRoute);
  app.post('/hub/control/execute', generalLimiter, controlExecuteRoute);
  app.get('/hub/control/runs/:id', generalLimiter, controlRunStatusRoute);
  app.post('/hub/control/runs/:id/approve', generalLimiter, controlRunApproveRoute);
  app.post('/hub/control/runs/:id/cancel', generalLimiter, controlRunCancelRoute);
  app.post('/hub/control/callback', generalLimiter, controlCallbackRoute);

  app.get('/hub/secrets/:category', secretsLimiter, secretsRoute);
  app.get('/hub/secrets-meta', secretsLimiter, secretsMetaAllRoute);
  app.get('/hub/secrets-meta/:category', secretsLimiter, secretsMetaRoute);

  app.post('/hub/llm/call', llmLimiter, llmAdmissionMiddleware, llmCallRoute);
  app.post('/hub/llm/oauth', llmLimiter, llmOAuthRoute);
  app.post('/hub/llm/groq', llmLimiter, llmGroqRoute);
  app.get('/hub/llm/stats', generalLimiter, llmStatsRoute);
  app.get('/hub/llm/load-tests', generalLimiter, llmLoadTestsRoute);
  app.get('/hub/llm/circuit', generalLimiter, llmCircuitRoute);
  app.delete('/hub/llm/circuit', generalLimiter, llmCircuitRoute);

  app.post('/hub/oauth/:provider/start', generalLimiter, oauthStartRoute);
  app.get('/hub/oauth/:provider/callback', generalLimiter, oauthCallbackRoute);
  app.post('/hub/oauth/:provider/refresh', generalLimiter, oauthRefreshRoute);
  app.get('/hub/oauth/:provider/status', generalLimiter, oauthStatusRoute);
  app.post('/hub/oauth/:provider/import-local', generalLimiter, oauthImportLocalRoute);
  app.post('/hub/oauth/:provider/revoke-local', generalLimiter, oauthRevokeLocalRoute);

  app.use('/hub/public', express.static(path.join(__dirname, '../public')));
  app.get('/hub/llm/dashboard', generalLimiter, llmDashboardRoute);
  app.get('/hub/llm/cache-stats', generalLimiter, llmCacheStatsRoute);
  app.get('/hub/llm/health', generalLimiter, llmHealthRoute);
  app.post('/hub/budget/reserve', generalLimiter, reserveBudgetRoute);
  app.get('/hub/budget/usage', generalLimiter, budgetUsageRoute);
  app.get('/hub/metrics', generalLimiter, metricsRoute);
  app.get('/hub/metrics/json', generalLimiter, metricsJsonRoute);

  app.use('/hub', (req, res) => {
    res.status(404).json({ error: `unknown endpoint: ${req.method} ${req.path}` });
  });
}
