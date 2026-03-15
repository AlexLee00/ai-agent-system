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
} = require('../../../packages/core/lib/health-provider');

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

function buildDecision(coreServiceRows, monitorHealth) {
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
  const decision = buildDecision(coreServiceRows, monitorHealth);

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
    decision,
  };
  return report;
}

runHealthCli({
  buildReport,
  formatText,
  errorPrefix: '[스카 운영 헬스 리포트]',
});
