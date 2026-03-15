'use strict';

const { execFileSync } = require('child_process');
const { runWithN8nFallback } = require('../../../packages/core/lib/n8n-runner');
const { storeReservationResolution } = require('../../../packages/core/lib/reservation-rag');
const { buildWebhookCandidates } = require('../../../packages/core/lib/n8n-webhook-registry');
const { createSkaReadService } = require('./ska-read-service');

function createSkaCommandHandlers({ pgPool, rag }) {
  const N8N_HEALTH_URL = process.env.N8N_SKA_HEALTH_URL || 'http://localhost:5678/healthz';
  const readService = createSkaReadService({ pgPool, rag });

  async function getCommandWebhookCandidates(command) {
    const scoped = process.env[`N8N_SKA_WEBHOOK_${String(command || '').toUpperCase()}`];
    const shared = process.env.N8N_SKA_COMMAND_WEBHOOK;
    return buildWebhookCandidates({
      workflowName: '스카팀 읽기 명령 intake',
      method: 'POST',
      pathSuffix: 'ska-command',
      configured: [scoped, shared],
      defaults: [
      'http://localhost:3031/api/webhooks/n8n/ska-command',
      'http://localhost:5678/webhook/ska-command',
      'http://localhost:5678/webhook-test/ska-command',
      ],
    });
  }

  async function runCommandWithN8n(command, args, directRunner) {
    return runWithN8nFallback({
      circuitName: `ska:${command}`,
      webhookCandidates: await getCommandWebhookCandidates(command),
      healthUrl: N8N_HEALTH_URL,
      body: {
        team: 'ska',
        command,
        args: args || {},
        source: 'ska-commander',
        requestedAt: new Date().toISOString(),
      },
      directRunner,
      logger: console,
    });
  }

  async function handleQueryReservations(args = {}) {
    return runCommandWithN8n('query_reservations', args, () => readService.queryReservations(args));
  }

  async function handleQueryTodayStats(args = {}) {
    return runCommandWithN8n('query_today_stats', args, () => readService.queryTodayStats(args));
  }

  async function handleQueryAlerts(args = {}) {
    return runCommandWithN8n('query_alerts', args, () => readService.queryAlerts(args));
  }

  async function handleStoreResolution(args = {}) {
    const { issueType = '알람', detail = '', resolution = '처리 완료' } = args;
    try {
      await storeReservationResolution(rag, {
        issueType,
        detail,
        resolution,
        sourceBot: 'ska-commander',
      });
      return { ok: true, message: 'RAG 저장 완료' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  function handleRestartAndy() {
    try {
      execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/ai.ska.naver-monitor`], {
        encoding: 'utf8',
        timeout: 30000,
      });
      return { ok: true, message: '앤디 재시작 완료' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  function handleRestartJimmy() {
    try {
      execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/ai.ska.kiosk-monitor`], {
        encoding: 'utf8',
        timeout: 30000,
      });
      return { ok: true, message: '지미 재시작 완료' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  return {
    query_reservations: handleQueryReservations,
    query_today_stats: handleQueryTodayStats,
    query_alerts: handleQueryAlerts,
    restart_andy: handleRestartAndy,
    restart_jimmy: handleRestartJimmy,
    store_resolution: handleStoreResolution,
  };
}

module.exports = {
  createSkaCommandHandlers,
};
