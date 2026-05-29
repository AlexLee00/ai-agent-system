// @ts-nocheck
'use strict';

/**
 * scripts/health-report.js — 오케스트레이터 운영자용 헬스 리포트
 *
 * 목적:
 *   - launchd 서비스 상태를 사람이 읽기 쉽게 요약
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
const { getOrchestratorHealthConfig } = require('../lib/runtime-config.ts');
const { getJayBudgetPolicy, getJayGrowthPolicy } = require('../lib/jay-runtime-policy.ts');
const {
  DEFAULT_NORMAL_EXIT_CODES,
  getLaunchctlStatus,
  buildServiceRows,
} = require('../../../packages/core/lib/health-provider');

const CONTINUOUS = ['ai.jay.runtime'];
const ALL_SERVICES = ['ai.jay.runtime'];
const NORMAL_EXIT_CODES = DEFAULT_NORMAL_EXIT_CODES;
const ORCHESTRATOR_HEALTH_CONFIG = getOrchestratorHealthConfig();

function buildDecision(serviceRows, payloadWarningHealth) {
  return buildHealthDecision({
    warnings: [
      {
        active: serviceRows.warn.length > 0,
        level: 'high',
        reason: `오케스트레이터 launchd 경고 ${serviceRows.warn.length}건이 있어 서비스 점검이 필요합니다.`,
      },
      {
        active: payloadWarningHealth.warnCount > 0,
        level: 'medium',
        reason: `reporting payload 스키마 경고 ${payloadWarningHealth.warnCount}건이 있어 producer 규격 점검이 필요합니다.`,
      },
    ],
    okReason: '오케스트레이터 서비스가 현재는 안정 구간입니다.',
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
    lines.push('  - launchd 경고 서비스 확인: launchctl list | rg "ai\\.jay\\.runtime"');
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
      buildHealthCountSection('■ Jay 운영 정책', report.jayPolicyHealth),
      buildHealthSampleSection('■ 정상 서비스 샘플', report.serviceHealth),
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
  const growthPolicy = getJayGrowthPolicy();
  const budgetPolicy = getJayBudgetPolicy();
  const payloadWarnings = getRecentPayloadWarnings({
    withinHours: ORCHESTRATOR_HEALTH_CONFIG.payloadWarningWithinHours,
    limit: ORCHESTRATOR_HEALTH_CONFIG.payloadWarningLimit,
  });
  const payloadWarningSummary = summarizePayloadWarnings(payloadWarnings);
  const payloadWarningHealth = buildPayloadWarningHealth(payloadWarningSummary);
  const decision = buildDecision(serviceRows, payloadWarningHealth);

  return {
    serviceHealth: {
      okCount: serviceRows.ok.length,
      warnCount: serviceRows.warn.length,
      ok: serviceRows.ok,
      warn: serviceRows.warn,
    },
    jayPolicyHealth: {
      okCount: 2,
      warnCount: 0,
      ok: [
        `  ${growthPolicy.serviceLabel}: ${growthPolicy.enabled ? 'enabled' : `disabled (${growthPolicy.disabledReason})`}`,
        `  Jay LLM daily budget: $${budgetPolicy.dailyBudgetUsd.toFixed(2)} (${budgetPolicy.source})`,
      ],
      warn: [],
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
