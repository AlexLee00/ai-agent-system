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
  buildHealthDecisionSection,
} = require('../../../packages/core/lib/health-core');
const { runHealthCli } = require('../../../packages/core/lib/health-runner');
const hsm = require('../../../packages/core/lib/health-state-manager');
const {
  DEFAULT_NORMAL_EXIT_CODES,
  getLaunchctlStatus,
  buildServiceRows,
  checkHttp,
  fetchJson,
} = require('../../../packages/core/lib/health-provider');

const CONTINUOUS = ['ai.worker.web', 'ai.worker.nextjs', 'ai.worker.lead', 'ai.worker.task-runner'];
const ALL_SERVICES = ['ai.worker.web', 'ai.worker.nextjs', 'ai.worker.lead', 'ai.worker.task-runner'];
const NORMAL_EXIT_CODES = DEFAULT_NORMAL_EXIT_CODES;

async function buildEndpointHealth() {
  const webOk = await checkHttp('http://127.0.0.1:4000/api/health');
  const nextOk = await checkHttp('http://127.0.0.1:4001');
  const apiHealth = await fetchJson('http://127.0.0.1:4000/api/health');
  const websocketReady = Boolean(apiHealth?.websocket?.enabled && apiHealth?.websocket?.ready);
  const websocketClients = Number(apiHealth?.websocket?.clients || 0);

  const ok = [];
  const warn = [];

  if (webOk) ok.push('  worker web API: 정상');
  else warn.push('  worker web API: 응답 없음');

  if (nextOk) ok.push('  worker nextjs: 정상');
  else warn.push('  worker nextjs: 응답 없음');

  if (websocketReady) ok.push(`  websocket: 준비됨 (clients ${websocketClients})`);
  else warn.push('  websocket: 준비 안 됨');

  return {
    ok,
    warn,
    webOk,
    nextOk,
    websocketReady,
    websocketClients,
  };
}

function buildDecision(serviceRows, endpointHealth) {
  const reasons = [];
  let recommended = false;
  let level = 'hold';

  if (serviceRows.warn.length > 0) {
    recommended = true;
    level = 'high';
    reasons.push(`launchd 경고 ${serviceRows.warn.length}건이 있어 워커 서비스 점검이 필요합니다.`);
  }

  if (endpointHealth.warn.length > 0) {
    recommended = true;
    level = level === 'high' ? 'high' : 'medium';
    reasons.push(`HTTP/WebSocket 경고 ${endpointHealth.warn.length}건이 있어 사용자 체감 이슈 가능성이 있습니다.`);
  }

  if (!recommended) {
    reasons.push('워커 서비스와 실시간 채널이 현재는 안정 구간입니다.');
  }

  return { recommended, level, reasons };
}

function formatText(report) {
  return buildHealthReport({
    title: '🧰 워커 운영 헬스 리포트',
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
        title: '■ 엔드포인트 상태',
        lines: [
          `  정상 ${report.endpointHealth.okCount}건 / 경고 ${report.endpointHealth.warnCount}건`,
          ...report.endpointHealth.warn.slice(0, 8),
          ...report.endpointHealth.ok.slice(0, 3),
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
  const decision = buildDecision(serviceRows, endpointHealth);

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
    decision,
  };
  return report;
}

runHealthCli({
  buildReport,
  formatText,
  errorPrefix: '[워커 운영 헬스 리포트]',
});
