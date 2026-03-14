'use strict';

const path = require('path');
const {
  buildHealthReport,
  buildHealthDecision,
  buildHealthDecisionSection,
} = require('../../../packages/core/lib/health-core');
const { runHealthCli } = require('../../../packages/core/lib/health-runner');
const {
  DEFAULT_NORMAL_EXIT_CODES,
  getLaunchctlStatus,
  buildServiceRows,
  checkHttp,
  fetchJson,
  checkFileStaleness,
} = require('../../../packages/core/lib/health-provider');

const CONTINUOUS = ['ai.blog.node-server'];
const ALL_SERVICES = ['ai.blog.daily', 'ai.blog.node-server'];
const NORMAL_EXIT_CODES = DEFAULT_NORMAL_EXIT_CODES;
const BLOG_ROOT = path.join(__dirname, '..');
const DAILY_LOG = path.join(BLOG_ROOT, 'blog-daily.log');
const DAILY_LOG_STALE_MS = 36 * 60 * 60 * 1000;

async function buildNodeHealth() {
  const apiOk = await checkHttp('http://127.0.0.1:3100/health');
  const apiJson = await fetchJson('http://127.0.0.1:3100/health');
  const n8nJson = await fetchJson('http://127.0.0.1:5678/healthz', 2500);

  const ok = [];
  const warn = [];

  if (apiOk && apiJson?.ok) ok.push(`  node-server API: 정상 (port ${apiJson.port || 3100})`);
  else warn.push('  node-server API: 응답 없음');

  if (n8nJson?.status === 'ok') ok.push('  n8n healthz: 정상');
  else warn.push('  n8n healthz: 응답 없음');

  return {
    ok,
    warn,
    nodeServerOk: apiOk && Boolean(apiJson?.ok),
    n8nOk: n8nJson?.status === 'ok',
  };
}

function buildDailyRunHealth() {
  const logState = checkFileStaleness(DAILY_LOG, DAILY_LOG_STALE_MS);
  const ok = [];
  const warn = [];

  if (!logState.exists) {
    warn.push('  daily log: 파일 없음');
  } else if (logState.stale) {
    warn.push(`  daily log: ${logState.minutesAgo}분 무활동`);
  } else {
    ok.push(`  daily log: 최근 ${logState.minutesAgo}분 이내 활동`);
  }

  return {
    ok,
    warn,
    minutesAgo: logState.minutesAgo,
  };
}

function buildDecision(serviceRows, nodeHealth, dailyRunHealth) {
  return buildHealthDecision({
    warnings: [
      {
        active: serviceRows.warn.length > 0,
        level: 'high',
        reason: `launchd 경고 ${serviceRows.warn.length}건이 있어 블로팀 서비스 점검이 필요합니다.`,
      },
      {
        active: nodeHealth.warn.length > 0,
        level: 'medium',
        reason: `node-server/n8n 경고 ${nodeHealth.warn.length}건이 있어 실행 백엔드 상태 확인이 필요합니다.`,
      },
      {
        active: dailyRunHealth.warn.length > 0,
        level: 'medium',
        reason: 'daily run 로그 활동성이 오래돼 최근 자동 실행 상태 확인이 필요합니다.',
      },
    ],
    okReason: '블로팀 실행기와 daily run 상태가 현재는 안정 구간입니다.',
  });
}

function formatText(report) {
  return buildHealthReport({
    title: '📰 블로 운영 헬스 리포트',
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
        title: '■ 실행 백엔드 상태',
        lines: [
          `  정상 ${report.nodeHealth.okCount}건 / 경고 ${report.nodeHealth.warnCount}건`,
          ...report.nodeHealth.warn.slice(0, 8),
          ...report.nodeHealth.ok.slice(0, 3),
        ],
      },
      {
        title: '■ daily run 상태',
        lines: [
          `  정상 ${report.dailyRunHealth.okCount}건 / 경고 ${report.dailyRunHealth.warnCount}건`,
          ...report.dailyRunHealth.warn.slice(0, 4),
          ...report.dailyRunHealth.ok.slice(0, 2),
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
    footer: ['실행: node bots/blog/scripts/health-report.js --json'],
  });
}

async function buildReport() {
  const status = getLaunchctlStatus();
  const serviceRows = buildServiceRows(status, {
    labels: ALL_SERVICES,
    continuous: CONTINUOUS,
    normalExitCodes: NORMAL_EXIT_CODES,
    shortLabel: (label) => label.replace('ai.blog.', ''),
  });
  const nodeHealth = await buildNodeHealth();
  const dailyRunHealth = buildDailyRunHealth();
  const decision = buildDecision(serviceRows, nodeHealth, dailyRunHealth);

  return {
    serviceHealth: {
      okCount: serviceRows.ok.length,
      warnCount: serviceRows.warn.length,
      ok: serviceRows.ok,
      warn: serviceRows.warn,
    },
    nodeHealth: {
      okCount: nodeHealth.ok.length,
      warnCount: nodeHealth.warn.length,
      ok: nodeHealth.ok,
      warn: nodeHealth.warn,
    },
    dailyRunHealth: {
      okCount: dailyRunHealth.ok.length,
      warnCount: dailyRunHealth.warn.length,
      ok: dailyRunHealth.ok,
      warn: dailyRunHealth.warn,
      minutesAgo: dailyRunHealth.minutesAgo,
    },
    decision,
  };
}

runHealthCli({
  buildReport,
  formatText,
  errorPrefix: '[블로 운영 헬스 리포트]',
});
