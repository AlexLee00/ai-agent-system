'use strict';

/**
 * scripts/health-report.js — 오케스트레이터 운영자용 헬스 리포트
 *
 * 목적:
 *   - launchd 서비스 상태와 n8n critical webhook 경로를 사람이 읽기 쉽게 요약
 *   - 공용 health-core 포맷을 사용하는 운영 리포트
 *
 * 실행:
 *   node bots/orchestrator/scripts/health-report.js [--json]
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
  getRecentPayloadWarnings,
  summarizePayloadWarnings,
} = require('../../../packages/core/lib/reporting-hub');
const { getOrchestratorHealthConfig } = require('../lib/runtime-config');
const {
  DEFAULT_NORMAL_EXIT_CODES,
  getLaunchctlStatus,
  buildServiceRows,
  buildResolvedWebhookHealth,
} = require('../../../packages/core/lib/health-provider');

const CONTINUOUS = ['ai.orchestrator', 'ai.openclaw.gateway', 'ai.n8n.server'];
const ALL_SERVICES = ['ai.orchestrator', 'ai.openclaw.gateway', 'ai.n8n.server'];
const NORMAL_EXIT_CODES = DEFAULT_NORMAL_EXIT_CODES;
const ORCHESTRATOR_HEALTH_CONFIG = getOrchestratorHealthConfig();
const N8N_HEALTH_URL = process.env.N8N_HEALTH_URL || ORCHESTRATOR_HEALTH_CONFIG.n8nHealthUrl;
const DEFAULT_CRITICAL_WEBHOOK_URL = process.env.N8N_CRITICAL_WEBHOOK || ORCHESTRATOR_HEALTH_CONFIG.criticalWebhookUrl;

async function buildCriticalWebhookHealth() {
  return buildResolvedWebhookHealth({
    workflowName: 'CRITICAL 알림 에스컬레이션',
    pathSuffix: 'critical',
    healthUrl: N8N_HEALTH_URL,
    defaultWebhookUrl: DEFAULT_CRITICAL_WEBHOOK_URL,
    probeBody: {
      severity: 'critical',
      service: 'orchestrator-health-report',
      status: 'probe',
      detail: 'n8n critical webhook health probe',
    },
    okLabel: 'critical webhook',
    warnLabel: 'critical webhook',
  });
}

function buildDecision(serviceRows, criticalWebhookHealth, payloadWarningHealth) {
  return buildHealthDecision({
    warnings: [
      {
        active: serviceRows.warn.length > 0,
        level: 'high',
        reason: `오케스트레이터 launchd 경고 ${serviceRows.warn.length}건이 있어 서비스 점검이 필요합니다.`,
      },
      {
        active: !criticalWebhookHealth.n8nHealthy,
        level: 'high',
        reason: 'n8n healthz 응답이 없어 critical 알림 경로를 신뢰할 수 없습니다.',
      },
      {
        active: criticalWebhookHealth.n8nHealthy && !criticalWebhookHealth.webhookRegistered,
        level: 'high',
        reason: `n8n은 살아 있지만 critical webhook이 비정상입니다 (${criticalWebhookHealth.webhookReason}).`,
      },
      {
        active: payloadWarningHealth.warnCount > 0,
        level: 'medium',
        reason: `reporting payload 스키마 경고 ${payloadWarningHealth.warnCount}건이 있어 producer 규격 점검이 필요합니다.`,
      },
    ],
    okReason: '오케스트레이터 서비스와 critical 알림 경로가 현재는 안정 구간입니다.',
  });
}

function buildPayloadWarningHealth(summary) {
  if (!summary || summary.count === 0) {
    return {
      okCount: 1,
      warnCount: 0,
      ok: ['  reporting payload 스키마 경고 없음'],
      warn: [],
    };
  }

  const latestWarning = Array.isArray(summary.latest?.warnings) && summary.latest.warnings.length > 0
    ? summary.latest.warnings.join(', ')
    : 'latest_unknown';
  return {
    okCount: 0,
    warnCount: summary.count,
    ok: [],
    warn: [
      `  reporting payload 스키마 경고 ${summary.count}건`,
      ...summary.topProducers,
      `  최근 경고: ${summary.latest?.team || 'general'}/${summary.latest?.from_bot || 'unknown'} - ${latestWarning}`,
    ],
  };
}

function buildActionLines(report) {
  const lines = [];

  if (report.serviceHealth.warnCount > 0) {
    lines.push('  - launchd 경고 서비스 확인: launchctl list | rg "ai\\.(orchestrator|openclaw\\.gateway|n8n\\.server)"');
  }
  if (!report.criticalWebhookHealth.n8nHealthy) {
    lines.push('  - n8n 서버 상태 확인: /ops-health alerts 또는 launchctl print gui/$(id -u)/ai.n8n.server');
  }
  if (report.criticalWebhookHealth.n8nHealthy && !report.criticalWebhookHealth.webhookRegistered) {
    lines.push('  - critical webhook 재설치: node bots/orchestrator/n8n/setup-n8n.js');
  }
  if (report.payloadWarningHealth.warnCount > 0) {
    lines.push('  - reporting producer payload 스키마 점검: title/summary/details/action 규격 확인');
  }
  if (lines.length === 0) {
    lines.push('  - 현재는 관찰 유지. 상세 점검이 필요하면 /ops-health alerts 확인');
  }

  return lines;
}

function formatText(report) {
  return buildHealthReport({
    title: '🧭 오케스트레이터 운영 헬스 리포트',
    sections: [
      buildHealthCountSection('■ 서비스 상태', report.serviceHealth),
      buildHealthSampleSection('■ 정상 서비스 샘플', report.serviceHealth),
      buildHealthCountSection('■ critical 알림 경로', report.criticalWebhookHealth, { okLimit: 3 }),
      buildHealthCountSection('■ reporting payload 경고', report.payloadWarningHealth, { okLimit: 2 }),
      {
        title: '■ 권장 조치',
        lines: buildActionLines(report),
      },
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
    footer: ['실행: node bots/orchestrator/scripts/health-report.js --json'],
  });
}

async function buildReport() {
  const status = getLaunchctlStatus(ALL_SERVICES);
  const serviceRows = buildServiceRows(status, {
    labels: ALL_SERVICES,
    continuous: CONTINUOUS,
    normalExitCodes: NORMAL_EXIT_CODES,
    shortLabel: (label) => hsm.shortLabel(label),
  });
  const criticalWebhookHealth = await buildCriticalWebhookHealth();
  const payloadWarnings = getRecentPayloadWarnings({
    withinHours: ORCHESTRATOR_HEALTH_CONFIG.payloadWarningWithinHours,
    limit: ORCHESTRATOR_HEALTH_CONFIG.payloadWarningLimit,
  });
  const payloadWarningSummary = summarizePayloadWarnings(payloadWarnings);
  const payloadWarningHealth = buildPayloadWarningHealth(payloadWarningSummary);
  const decision = buildDecision(serviceRows, criticalWebhookHealth, payloadWarningHealth);

  return {
    serviceHealth: {
      okCount: serviceRows.ok.length,
      warnCount: serviceRows.warn.length,
      ok: serviceRows.ok,
      warn: serviceRows.warn,
    },
    criticalWebhookHealth: {
      okCount: criticalWebhookHealth.ok.length,
      warnCount: criticalWebhookHealth.warn.length,
      ok: criticalWebhookHealth.ok,
      warn: criticalWebhookHealth.warn,
      n8nHealthy: criticalWebhookHealth.n8nHealthy,
      webhookRegistered: criticalWebhookHealth.webhookRegistered,
      webhookReason: criticalWebhookHealth.webhookReason,
      webhookStatus: criticalWebhookHealth.webhookStatus,
      webhookUrl: criticalWebhookHealth.webhookUrl,
      resolvedWebhookUrl: criticalWebhookHealth.resolvedWebhookUrl,
    },
    payloadWarningHealth,
    decision,
  };
}

runHealthCli({
  buildReport,
  formatText,
  errorPrefix: '[오케스트레이터 운영 헬스 리포트]',
});
