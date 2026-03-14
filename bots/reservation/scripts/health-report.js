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
  buildHealthDecisionSection,
} = require('../../../packages/core/lib/health-core');
const { runHealthCli } = require('../../../packages/core/lib/health-runner');
const {
  DEFAULT_NORMAL_EXIT_CODES,
  getLaunchctlStatus,
  buildServiceRows,
  checkFileStaleness,
} = require('../../../packages/core/lib/health-provider');

const CONTINUOUS = ['ai.ska.naver-monitor'];
const ALL_SERVICES = [
  'ai.ska.naver-monitor',
  'ai.ska.kiosk-monitor',
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

function checkNaverLogStaleness() {
  return checkFileStaleness(NAVER_LOG, LOG_STALE_MS);
}

function buildMonitorHealth(logState) {
  const ok = [];
  const warn = [];

  if (!logState.exists) {
    warn.push('  naver-monitor 로그: 파일 없음');
    return { ok, warn, minutesAgo: null };
  }

  if (logState.stale) {
    warn.push(`  naver-monitor 로그: ${logState.minutesAgo}분 무활동`);
  } else {
    ok.push(`  naver-monitor 로그: 최근 ${logState.minutesAgo}분 이내 활동`);
  }

  return {
    ok,
    warn,
    minutesAgo: logState.minutesAgo,
  };
}

function buildDecision(serviceRows, monitorHealth) {
  const reasons = [];
  let recommended = false;
  let level = 'hold';

  if (serviceRows.warn.length > 0) {
    recommended = true;
    level = 'high';
    reasons.push(`launchd 경고 ${serviceRows.warn.length}건이 있어 스카 서비스 점검이 필요합니다.`);
  }

  if (monitorHealth.warn.length > 0) {
    recommended = true;
    level = level === 'high' ? 'high' : 'medium';
    reasons.push('naver-monitor 로그 활동성이 멈춰 크래시루프 가능성을 확인해야 합니다.');
  }

  if (!recommended) {
    reasons.push('스카 서비스와 naver-monitor 로그 활동성이 현재는 안정 구간입니다.');
  }

  return { recommended, level, reasons };
}

function formatText(report) {
  return buildHealthReport({
    title: '📅 스카 운영 헬스 리포트',
    sections: [
      {
        title: '■ 서비스 상태',
        lines: [
          `  정상 ${report.serviceHealth.okCount}건 / 경고 ${report.serviceHealth.warnCount}건`,
          ...report.serviceHealth.warn.slice(0, 8),
        ],
      },
      report.serviceHealth.ok.length > 0
        ? {
            title: '■ 정상 서비스 샘플',
            lines: report.serviceHealth.ok.slice(0, 5),
          }
        : null,
      {
        title: '■ 모니터 상태',
        lines: [
          `  정상 ${report.monitorHealth.okCount}건 / 경고 ${report.monitorHealth.warnCount}건`,
          ...report.monitorHealth.warn.slice(0, 8),
          ...report.monitorHealth.ok.slice(0, 3),
        ],
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
    footer: ['실행: node bots/reservation/scripts/health-report.js --json'],
  });
}

async function buildReport() {
  const status = getLaunchctlStatus();
  const serviceRows = buildServiceRows(status, {
    labels: ALL_SERVICES,
    continuous: CONTINUOUS,
    normalExitCodes: NORMAL_EXIT_CODES,
    shortLabel: (label) => label.replace('ai.ska.', ''),
  });
  const monitorHealth = buildMonitorHealth(checkNaverLogStaleness());
  const decision = buildDecision(serviceRows, monitorHealth);

  const report = {
    serviceHealth: {
      okCount: serviceRows.ok.length,
      warnCount: serviceRows.warn.length,
      ok: serviceRows.ok,
      warn: serviceRows.warn,
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
