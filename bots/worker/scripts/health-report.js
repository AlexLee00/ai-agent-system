'use strict';

/**
 * scripts/health-report.js — 워커팀 운영자용 헬스 리포트
 *
 * 목적:
 *   - launchd 서비스 / HTTP / WebSocket 상태를 사람이 읽기 쉽게 요약
 *   - 공용 health-core 포맷을 사용하는 운영 리포트
 *
 * 실행:
 *   node bots/worker/scripts/health-report.js [--json]
 */

const {
  buildHealthReport,
  buildHealthDecision,
  buildHealthCountSection,
  buildHealthSampleSection,
  buildHealthDecisionSection,
} = require('../../../packages/core/lib/health-core');
const { runHealthCli } = require('../../../packages/core/lib/health-runner');
const hsm = require('../../../packages/core/lib/health-state-manager');
const {
  DEFAULT_NORMAL_EXIT_CODES,
  getLaunchctlStatus,
  buildServiceRows,
  buildHttpChecks,
  checkHttp,
  checkWebhookRegistration,
} = require('../../../packages/core/lib/health-provider');
const { resolveProductionWebhookUrl } = require('../../../packages/core/lib/n8n-webhook-registry');

const CONTINUOUS = ['ai.worker.web', 'ai.worker.nextjs', 'ai.worker.lead', 'ai.worker.task-runner'];
const ALL_SERVICES = ['ai.worker.web', 'ai.worker.nextjs', 'ai.worker.lead', 'ai.worker.task-runner'];
const NORMAL_EXIT_CODES = DEFAULT_NORMAL_EXIT_CODES;
const N8N_HEALTH_URL = process.env.N8N_HEALTH_URL || 'http://127.0.0.1:5678/healthz';
const DEFAULT_WORKER_WEBHOOK_URL = process.env.N8N_WORKER_WEBHOOK || 'http://127.0.0.1:5678/webhook/worker-chat-intake';

async function buildEndpointHealth() {
  const checks = await buildHttpChecks([
    {
      label: 'workerWeb',
      url: 'http://127.0.0.1:4000/api/health',
      isOk: Boolean,
      okText: '  worker web API: 정상',
      warnText: '  worker web API: 응답 없음',
    },
    {
      label: 'workerNext',
      url: 'http://127.0.0.1:4001',
      isOk: Boolean,
      okText: '  worker nextjs: 정상',
      warnText: '  worker nextjs: 응답 없음',
    },
    {
      label: 'apiHealth',
      url: 'http://127.0.0.1:4000/api/health',
      expectJson: true,
      isOk: (data) => Boolean(data?.websocket?.enabled && data?.websocket?.ready),
      okText: (data) => `  websocket: 준비됨 (clients ${Number(data?.websocket?.clients || 0)})`,
      warnText: '  websocket: 준비 안 됨',
    },
  ]);
  const apiHealth = checks.results.apiHealth || null;
  const websocketClients = Number(apiHealth?.websocket?.clients || 0);

  return {
    ok: checks.ok,
    warn: checks.warn,
    webOk: Boolean(checks.results.workerWeb),
    nextOk: Boolean(checks.results.workerNext),
    websocketReady: Boolean(apiHealth?.websocket?.enabled && apiHealth?.websocket?.ready),
    websocketClients,
  };
}

async function buildN8nIntakeHealth() {
  const ok = [];
  const warn = [];
  const n8nHealthy = await checkHttp(N8N_HEALTH_URL, 2500);
  const resolvedWebhookUrl = await resolveProductionWebhookUrl({
    workflowName: '워커팀 자연어 업무 intake',
    method: 'POST',
    pathSuffix: 'worker-chat-intake',
  });
  const webhookUrl = resolvedWebhookUrl || DEFAULT_WORKER_WEBHOOK_URL;
  const webhook = await checkWebhookRegistration(webhookUrl, {
    company_id: 'master',
    user_id: 1,
    message: 'n8n intake health probe',
  }, {
    timeoutMs: 5000,
  });

  if (n8nHealthy) ok.push('  n8n healthz: 정상');
  else warn.push('  n8n healthz: 응답 없음');

  if (!webhook.healthy) {
    warn.push(`  worker intake webhook: 미도달 (${webhook.error || webhook.reason})`);
  } else if (!webhook.registered) {
    warn.push(`  worker intake webhook: 미등록 (${webhook.reason}, status ${webhook.status})`);
  } else {
    ok.push(`  worker intake webhook: 등록됨 (${webhook.reason}, status ${webhook.status})`);
  }

  return {
    ok,
    warn,
    n8nHealthy,
    webhookRegistered: webhook.registered,
    webhookReason: webhook.reason,
    webhookStatus: webhook.status,
    webhookUrl,
    resolvedWebhookUrl,
  };
}

function buildDecision(serviceRows, endpointHealth, n8nIntakeHealth) {
  return buildHealthDecision({
    warnings: [
      {
        active: serviceRows.warn.length > 0,
        level: 'high',
        reason: `launchd 경고 ${serviceRows.warn.length}건이 있어 워커 서비스 점검이 필요합니다.`,
      },
      {
        active: endpointHealth.warn.length > 0,
        level: 'medium',
        reason: `HTTP/WebSocket 경고 ${endpointHealth.warn.length}건이 있어 사용자 체감 이슈 가능성이 있습니다.`,
      },
      {
        active: !n8nIntakeHealth.n8nHealthy,
        level: 'medium',
        reason: 'n8n healthz 응답이 없어 워커 intake 워크플로우 경로를 사용할 수 없습니다.',
      },
      {
        active: n8nIntakeHealth.n8nHealthy && !n8nIntakeHealth.webhookRegistered,
        level: 'medium',
        reason: `n8n은 살아 있지만 worker intake webhook이 미등록 상태입니다 (${n8nIntakeHealth.webhookReason}).`,
      },
    ],
    okReason: '워커 서비스와 실시간 채널이 현재는 안정 구간입니다.',
  });
}

function formatText(report) {
  return buildHealthReport({
    title: '🧰 워커 운영 헬스 리포트',
    sections: [
      buildHealthCountSection('■ 서비스 상태', report.serviceHealth),
      buildHealthSampleSection('■ 정상 서비스 샘플', report.serviceHealth),
      buildHealthCountSection('■ 엔드포인트 상태', report.endpointHealth, { okLimit: 3 }),
      buildHealthCountSection('■ n8n intake 경로', report.n8nIntakeHealth, { okLimit: 2 }),
      {
        title: null,
        lines: buildHealthDecisionSection({
          title: '■ 운영 판단',
          recommended: report.decision.recommended,
          level: report.decision.level,
          reasons: report.decision.reasons,
          okText: '현재는 추가 조치보다 관찰 유지',
        }),
      },
    ].filter(Boolean),
    footer: ['실행: node bots/worker/scripts/health-report.js --json'],
  });
}

async function buildReport() {
  const status = getLaunchctlStatus();
  const serviceRows = buildServiceRows(status, {
    labels: ALL_SERVICES,
    continuous: CONTINUOUS,
    normalExitCodes: NORMAL_EXIT_CODES,
    shortLabel: (label) => hsm.shortLabel(label),
  });
  const endpointHealth = await buildEndpointHealth();
  const n8nIntakeHealth = await buildN8nIntakeHealth();
  const decision = buildDecision(serviceRows, endpointHealth, n8nIntakeHealth);

  const report = {
    serviceHealth: {
      okCount: serviceRows.ok.length,
      warnCount: serviceRows.warn.length,
      ok: serviceRows.ok,
      warn: serviceRows.warn,
    },
    endpointHealth: {
      okCount: endpointHealth.ok.length,
      warnCount: endpointHealth.warn.length,
      ok: endpointHealth.ok,
      warn: endpointHealth.warn,
      websocketClients: endpointHealth.websocketClients,
    },
    n8nIntakeHealth: {
      okCount: n8nIntakeHealth.ok.length,
      warnCount: n8nIntakeHealth.warn.length,
      ok: n8nIntakeHealth.ok,
      warn: n8nIntakeHealth.warn,
      webhookRegistered: n8nIntakeHealth.webhookRegistered,
      webhookReason: n8nIntakeHealth.webhookReason,
      webhookStatus: n8nIntakeHealth.webhookStatus,
      webhookUrl: n8nIntakeHealth.webhookUrl,
      resolvedWebhookUrl: n8nIntakeHealth.resolvedWebhookUrl,
    },
    decision,
  };
  return report;
}

runHealthCli({
  buildReport,
  formatText,
  errorPrefix: '[워커 운영 헬스 리포트]',
});
