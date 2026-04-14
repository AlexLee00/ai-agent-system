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
const { getWorkerHealthRuntimeConfig, getWorkerN8nRuntimeConfig } = require('../lib/runtime-config');
const {
  DEFAULT_NORMAL_EXIT_CODES,
  getLaunchctlStatus,
  buildServiceRows,
  buildHttpChecks,
  buildResolvedWebhookHealth,
} = require('../../../packages/core/lib/health-provider');
const { createAgentMemory } = require('../../../packages/core/lib/agent-memory');

const CONTINUOUS = ['ai.worker.web', 'ai.worker.nextjs', 'ai.worker.lead', 'ai.worker.task-runner'];
const ALL_SERVICES = ['ai.worker.web', 'ai.worker.nextjs', 'ai.worker.lead', 'ai.worker.task-runner'];
const NORMAL_EXIT_CODES = DEFAULT_NORMAL_EXIT_CODES;
const healthRuntimeConfig = getWorkerHealthRuntimeConfig();
const n8nRuntimeConfig = getWorkerN8nRuntimeConfig();
const N8N_HEALTH_URL = process.env.N8N_HEALTH_URL || n8nRuntimeConfig.healthUrl;
const DEFAULT_WORKER_WEBHOOK_URL = process.env.N8N_WORKER_WEBHOOK || n8nRuntimeConfig.workerWebhookUrl;
const HTTP_TIMEOUT_MS = Number(healthRuntimeConfig.httpTimeoutMs || 5000);
const healthReportMemory = createAgentMemory({ agentId: 'worker.health-report', team: 'worker' });

function buildHealthReportMemoryQuery(report) {
  return [
    'worker health report',
    report.decision?.recommended ? 'attention-needed' : 'stable',
    `${report.serviceHealth?.warnCount || 0}-service-warn`,
    `${report.endpointHealth?.warnCount || 0}-endpoint-warn`,
    `${report.n8nIntakeHealth?.warnCount || 0}-intake-warn`,
  ].filter(Boolean).join(' ');
}

function buildHealthReportMemorySummary(report) {
  return [
    '워커 운영 헬스 리포트',
    `서비스 경고: ${report.serviceHealth?.warnCount || 0}건`,
    `엔드포인트 경고: ${report.endpointHealth?.warnCount || 0}건`,
    `n8n intake 경고: ${report.n8nIntakeHealth?.warnCount || 0}건`,
    `운영 판단: ${report.decision?.recommended ? `주의 필요 (${report.decision.level})` : '안정'}`,
    Array.isArray(report.decision?.reasons) && report.decision.reasons.length
      ? `주요 사유: ${report.decision.reasons.slice(0, 2).join(' | ')}`
      : null,
  ].filter(Boolean).join('\n');
}

async function buildEndpointHealth() {
  const checks = await buildHttpChecks([
    {
      label: 'workerWeb',
      url: 'http://127.0.0.1:4000/api/health',
      timeoutMs: HTTP_TIMEOUT_MS,
      isOk: Boolean,
      okText: '  worker web API: 정상',
      warnText: '  worker web API: 응답 없음',
    },
    {
      label: 'workerNext',
      url: 'http://127.0.0.1:4001',
      timeoutMs: HTTP_TIMEOUT_MS,
      isOk: Boolean,
      okText: '  worker nextjs: 정상',
      warnText: '  worker nextjs: 응답 없음',
    },
    {
      label: 'apiHealth',
      url: 'http://127.0.0.1:4000/api/health',
      timeoutMs: HTTP_TIMEOUT_MS,
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
  return buildResolvedWebhookHealth({
    workflowName: '워커팀 자연어 업무 intake',
    pathSuffix: 'worker-chat-intake',
    healthUrl: N8N_HEALTH_URL,
    defaultWebhookUrl: DEFAULT_WORKER_WEBHOOK_URL,
    probeBody: {
      company_id: 'master',
      user_id: 1,
      message: 'n8n intake health probe',
    },
    okLabel: 'worker intake webhook',
    warnLabel: 'worker intake webhook',
  });
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
      report.memoryHints?.episodicHint
        ? {
            title: '■ 최근 유사 리포트',
            lines: report.memoryHints.episodicHint.trimStart().split('\n'),
          }
        : null,
      report.memoryHints?.semanticHint
        ? {
            title: '■ 최근 통합 패턴',
            lines: report.memoryHints.semanticHint.trimStart().split('\n'),
          }
        : null,
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

  const memoryQuery = buildHealthReportMemoryQuery(report);
  const episodicHint = await healthReportMemory.recallCountHint(memoryQuery, {
    type: 'episodic',
    limit: 2,
    threshold: 0.33,
    title: '최근 유사 리포트',
    separator: 'pipe',
    metadataKey: 'kind',
    labels: {
      report: '리포트',
    },
    order: ['report'],
  }).catch(() => '');
  const semanticHint = await healthReportMemory.recallHint(`${memoryQuery} consolidated worker health pattern`, {
    type: 'semantic',
    limit: 2,
    threshold: 0.28,
    title: '최근 통합 패턴',
    separator: 'newline',
  }).catch(() => '');

  report.memoryHints = {
    episodicHint,
    semanticHint,
  };

  await healthReportMemory.remember(buildHealthReportMemorySummary(report), 'episodic', {
    importance: report.decision.recommended ? 0.72 : 0.6,
    expiresIn: 1000 * 60 * 60 * 24 * 30,
    metadata: {
      kind: 'report',
      serviceWarnCount: report.serviceHealth.warnCount,
      endpointWarnCount: report.endpointHealth.warnCount,
      intakeWarnCount: report.n8nIntakeHealth.warnCount,
      recommended: report.decision.recommended,
      level: report.decision.level,
    },
  }).catch(() => {});
  await healthReportMemory.consolidate({
    olderThanDays: 14,
    limit: 10,
  }).catch(() => {});

  return report;
}

runHealthCli({
  buildReport,
  formatText,
  errorPrefix: '[워커 운영 헬스 리포트]',
});
