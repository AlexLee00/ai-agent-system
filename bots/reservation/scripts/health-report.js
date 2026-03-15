'use strict';

/**
 * scripts/health-report.js — 스카팀 운영자용 헬스 리포트
 *
 * 목적:
 *   - launchd 서비스 상태와 naver-monitor 로그 활동성을 사람이 읽기 쉽게 요약
 *   - 공용 health-core 포맷을 사용하는 운영 리포트
 *
 * 실행:
 *   node bots/reservation/scripts/health-report.js [--json]
 */

const {
  buildHealthReport,
  buildHealthDecision,
  buildHealthCountSection,
  buildHealthSampleSection,
  buildHealthDecisionSection,
} = require('../../../packages/core/lib/health-core');
const { runHealthCli } = require('../../../packages/core/lib/health-runner');
const {
  DEFAULT_NORMAL_EXIT_CODES,
  getLaunchctlStatus,
  buildServiceRows,
  buildFileActivityHealth,
  checkHttp,
  checkWebhookRegistration,
} = require('../../../packages/core/lib/health-provider');
const { resolveProductionWebhookUrl } = require('../../../packages/core/lib/n8n-webhook-registry');

const CONTINUOUS = ['ai.ska.naver-monitor', 'ai.ska.commander'];
const CORE_SERVICES = [
  'ai.ska.commander',
  'ai.ska.naver-monitor',
  'ai.ska.kiosk-monitor',
  'ai.ska.health-check',
];
const SCHEDULED_SERVICES = [
  'ai.ska.pickko-verify',
  'ai.ska.pickko-daily-audit',
  'ai.ska.pickko-daily-summary',
  'ai.ska.log-report',
  'ai.ska.db-backup',
  'ai.ska.log-rotate',
];
const NORMAL_EXIT_CODES = DEFAULT_NORMAL_EXIT_CODES;
const NAVER_LOG = '/tmp/naver-ops-mode.log';
const LOG_STALE_MS = 15 * 60 * 1000;
const N8N_HEALTH_URL = process.env.N8N_HEALTH_URL || 'http://127.0.0.1:5678/healthz';
const DEFAULT_N8N_WEBHOOK_URL = process.env.SKA_N8N_WEBHOOK_URL || 'http://127.0.0.1:5678/webhook/ska-command';

function buildMonitorHealth() {
  return buildFileActivityHealth({
    label: 'naver-monitor 로그',
    filePath: NAVER_LOG,
    staleMs: LOG_STALE_MS,
    missingText: '  naver-monitor 로그: 파일 없음',
    staleText: (state) => `  naver-monitor 로그: ${state.minutesAgo}분 무활동`,
    okText: (state) => `  naver-monitor 로그: 최근 ${state.minutesAgo}분 이내 활동`,
  });
}

async function buildN8nCommandHealth() {
  const ok = [];
  const warn = [];
  const n8nHealthy = await checkHttp(N8N_HEALTH_URL, 2500);
  const resolvedWebhookUrl = await resolveProductionWebhookUrl({
    workflowName: '스카팀 읽기 명령 intake',
    method: 'POST',
    pathSuffix: 'ska-command',
  });
  const webhookUrl = resolvedWebhookUrl || DEFAULT_N8N_WEBHOOK_URL;
  const webhook = await checkWebhookRegistration(webhookUrl, {
    command: 'query_today_stats',
    args: { date: new Date().toISOString().slice(0, 10) },
  }, {
    timeoutMs: 5000,
  });

  if (n8nHealthy) ok.push('  n8n healthz: 정상');
  else warn.push('  n8n healthz: 응답 없음');

  if (!webhook.healthy) {
    warn.push(`  ska command webhook: 미도달 (${webhook.error || webhook.reason})`);
  } else if (!webhook.registered) {
    warn.push(`  ska command webhook: 미등록 (${webhook.reason}, status ${webhook.status})`);
  } else {
    ok.push(`  ska command webhook: 등록됨 (${webhook.reason}, status ${webhook.status})`);
  }

  return {
    ok,
    warn,
    n8nHealthy,
    webhookUrl,
    resolvedWebhookUrl,
    webhookRegistered: webhook.registered,
    webhookReason: webhook.reason,
    webhookStatus: webhook.status,
    webhookHealthy: webhook.healthy,
  };
}

function buildDecision(coreServiceRows, monitorHealth, n8nCommandHealth) {
  return buildHealthDecision({
    warnings: [
      {
        active: coreServiceRows.warn.length > 0,
        level: 'high',
        reason: `핵심 스카 서비스 경고 ${coreServiceRows.warn.length}건이 있어 점검이 필요합니다.`,
      },
      {
        active: monitorHealth.warn.length > 0,
        level: 'medium',
        reason: 'naver-monitor 로그 활동성이 멈춰 크래시루프 가능성을 확인해야 합니다.',
      },
      {
        active: !n8nCommandHealth.n8nHealthy,
        level: 'medium',
        reason: 'n8n healthz 응답이 없어 스카 command 노드 경로를 사용할 수 없습니다.',
      },
      {
        active: n8nCommandHealth.n8nHealthy && !n8nCommandHealth.webhookRegistered,
        level: 'medium',
        reason: `n8n은 살아 있지만 ska command webhook이 미등록 상태입니다 (${n8nCommandHealth.webhookReason}).`,
      },
    ],
    okReason: '스카 서비스와 naver-monitor 로그 활동성이 현재는 안정 구간입니다.',
  });
}

function formatText(report) {
  return buildHealthReport({
    title: '📅 스카 운영 헬스 리포트',
    sections: [
      buildHealthCountSection('■ 핵심 서비스 상태', report.coreServiceHealth),
      buildHealthSampleSection('■ 핵심 서비스 샘플', report.coreServiceHealth),
      buildHealthCountSection('■ 스케줄 작업 상태', report.scheduledServiceHealth),
      buildHealthCountSection('■ 모니터 상태', report.monitorHealth, { okLimit: 3 }),
      buildHealthCountSection('■ n8n 명령 경로', report.n8nCommandHealth, { okLimit: 2 }),
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
    footer: ['실행: node bots/reservation/scripts/health-report.js --json'],
  });
}

async function buildReport() {
  const status = getLaunchctlStatus();
  const coreServiceRows = buildServiceRows(status, {
    labels: CORE_SERVICES,
    continuous: CONTINUOUS,
    normalExitCodes: NORMAL_EXIT_CODES,
    shortLabel: (label) => label.replace('ai.ska.', ''),
  });
  const scheduledServiceRows = buildServiceRows(status, {
    labels: SCHEDULED_SERVICES,
    continuous: [],
    normalExitCodes: NORMAL_EXIT_CODES,
    shortLabel: (label) => label.replace('ai.ska.', ''),
  });
  const monitorHealth = buildMonitorHealth();
  const n8nCommandHealth = await buildN8nCommandHealth();
  const decision = buildDecision(coreServiceRows, monitorHealth, n8nCommandHealth);

  const report = {
    coreServiceHealth: {
      okCount: coreServiceRows.ok.length,
      warnCount: coreServiceRows.warn.length,
      ok: coreServiceRows.ok,
      warn: coreServiceRows.warn,
    },
    scheduledServiceHealth: {
      okCount: scheduledServiceRows.ok.length,
      warnCount: scheduledServiceRows.warn.length,
      ok: scheduledServiceRows.ok,
      warn: scheduledServiceRows.warn,
    },
    monitorHealth: {
      okCount: monitorHealth.ok.length,
      warnCount: monitorHealth.warn.length,
      ok: monitorHealth.ok,
      warn: monitorHealth.warn,
      minutesAgo: monitorHealth.minutesAgo,
    },
    n8nCommandHealth: {
      okCount: n8nCommandHealth.ok.length,
      warnCount: n8nCommandHealth.warn.length,
      ok: n8nCommandHealth.ok,
      warn: n8nCommandHealth.warn,
      n8nHealthy: n8nCommandHealth.n8nHealthy,
      webhookRegistered: n8nCommandHealth.webhookRegistered,
      webhookReason: n8nCommandHealth.webhookReason,
      webhookStatus: n8nCommandHealth.webhookStatus,
      webhookUrl: n8nCommandHealth.webhookUrl,
      resolvedWebhookUrl: n8nCommandHealth.resolvedWebhookUrl,
    },
    decision,
  };
  return report;
}

runHealthCli({
  buildReport,
  formatText,
  errorPrefix: '[스카 운영 헬스 리포트]',
});
