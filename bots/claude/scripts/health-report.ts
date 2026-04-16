// @ts-nocheck
'use strict';

/**
 * scripts/health-report.js — 클로드팀 운영자용 헬스 리포트
 *
 * 목적:
 *   - launchd 서비스 상태와 health-dashboard 요약을 사람이 읽기 쉽게 출력
 *   - 공용 health-core 포맷을 사용하는 운영 리포트
 *
 * 실행:
 *   node bots/claude/scripts/health-report.js [--json]
 */

const fs = require('fs');
const path = require('path');
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
  buildResolvedWebhookHealth,
} = require('../../../packages/core/lib/health-provider');

const CONTINUOUS = ['ai.claude.commander'];
const ALL_SERVICES = [
  'ai.claude.commander',
  'ai.claude.dexter.quick',
  'ai.claude.dexter',
  'ai.claude.dexter.daily',
  'ai.claude.archer',
  'ai.claude.health-dashboard',
];
const NORMAL_EXIT_CODES = DEFAULT_NORMAL_EXIT_CODES;
const CLAUDE_ROOT = path.join(__dirname, '..');

function hasRecentDexterReport() {
  try {
    const logPath = path.join(CLAUDE_ROOT, 'dexter.log');
    const stat = fs.statSync(logPath);
    if (Date.now() - stat.mtimeMs > 90 * 60 * 1000) return false;

    const tail = fs.readFileSync(logPath, 'utf8').split('\n').slice(-80).join('\n');
    return (
      tail.includes('📋 요약:') ||
      tail.includes('🎉 모든 체크 통과') ||
      tail.includes('이상 없음 — 텔레그램 발송 생략')
    );
  } catch {
    return false;
  }
}

function isExpectedExit(label, exitCode) {
  if (label === 'ai.claude.dexter' && exitCode === 1) {
    return hasRecentDexterReport();
  }
  return false;
}

async function buildDashboardHealth() {
  const checks = await buildHttpChecks([
    {
      label: 'dashboard',
      url: 'http://127.0.0.1:3032/api/health',
      expectJson: true,
      isOk: Boolean,
      okText: '  health-dashboard API: 정상',
      warnText: '  health-dashboard API: 응답 없음',
    },
  ]);
  const data = checks.results.dashboard || null;

  if (!data) {
    return {
      ok: checks.ok,
      warn: checks.warn,
      leadMode: null,
      runningBots: 0,
      totalBots: 0,
      mismatched: 0,
    };
  }

  const ok = [...checks.ok];
  const warn = [...checks.warn];
  const leadMode = data.lead_mode || 'unknown';
  const runningBots = Number(data.bot_summary?.running || 0);
  const totalBots = Number(data.bot_summary?.total || 0);
  const shadowTotal = Number(data.shadow_stats?.total || 0);
  const mismatched = Number(data.shadow_stats?.mismatched || 0);
  const mismatchRate = shadowTotal > 0 ? (mismatched / shadowTotal) * 100 : 0;

  ok.push(`  lead mode: ${leadMode}`);
  ok.push(`  bot summary: ${runningBots}/${totalBots} running`);

  if (mismatched <= 0) {
    ok.push('  shadow mismatch: 없음');
  } else if (shadowTotal < 5) {
    ok.push(`  shadow mismatch: ${mismatched}건 (표본 ${shadowTotal}건, 관찰 유지)`);
  } else if (mismatchRate >= 20 || mismatched >= 3) {
    warn.push(`  shadow mismatch: ${mismatched}/${shadowTotal}건 (${mismatchRate.toFixed(1)}%)`);
  } else {
    ok.push(`  shadow mismatch: ${mismatched}/${shadowTotal}건 (${mismatchRate.toFixed(1)}%, 관찰 유지)`);
  }

  return {
    ok,
    warn,
    leadMode,
    runningBots,
    totalBots,
    shadowTotal,
    mismatched,
    mismatchRate,
  };
}

async function buildN8nHealth() {
  const webhookHealth = await buildResolvedWebhookHealth({
    workflowName: 'CRITICAL 알림 에스컬레이션',
    pathSuffix: 'critical',
    defaultUrl: 'http://127.0.0.1:5678/webhook/critical',
    label: 'critical webhook',
    body: {
      severity: 'critical',
      service: 'claude-health-report',
      status: 'probe',
      detail: 'n8n critical webhook health probe',
    },
    timeoutMs: 5000,
  });

  return {
    ok: webhookHealth.ok,
    warn: webhookHealth.warn,
  };
}

function buildDecision(serviceRows, dashboardHealth, n8nHealth) {
  return buildHealthDecision({
    warnings: [
      {
        active: serviceRows.warn.length > 0,
        level: 'high',
        reason: `launchd 경고 ${serviceRows.warn.length}건이 있어 클로드 서비스 점검이 필요합니다.`,
      },
      {
        active: dashboardHealth.warn.length > 0,
        level: 'medium',
        reason: `health-dashboard 경고 ${dashboardHealth.warn.length}건이 있어 리드 모드/그림자 상태 확인이 필요합니다.`,
      },
      {
        active: n8nHealth.warn.length > 0,
        level: 'high',
        reason: `n8n 경고 ${n8nHealth.warn.length}건이 있어 critical webhook 경로 점검이 필요합니다.`,
      },
    ],
    okReason: '클로드 핵심 서비스와 health-dashboard가 현재는 안정 구간입니다.',
  });
}

function formatText(report) {
  return buildHealthReport({
    title: '🛡 클로드 운영 헬스 리포트',
    sections: [
      buildHealthCountSection('■ 서비스 상태', report.serviceHealth),
      buildHealthSampleSection('■ 정상 서비스 샘플', report.serviceHealth),
      buildHealthCountSection('■ health-dashboard 상태', report.dashboardHealth, { okLimit: 4 }),
      buildHealthCountSection('■ n8n 경로 상태', report.n8nHealth, { okLimit: 4 }),
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
    footer: ['실행: node bots/claude/scripts/health-report.js --json'],
  });
}

async function buildReport() {
  const status = getLaunchctlStatus();
  const serviceRows = buildServiceRows(status, {
    labels: ALL_SERVICES,
    continuous: CONTINUOUS,
    normalExitCodes: NORMAL_EXIT_CODES,
    shortLabel: (label) => hsm.shortLabel(label),
    isExpectedExit,
  });
  const dashboardHealth = await buildDashboardHealth();
  const n8nHealth = await buildN8nHealth();
  const decision = buildDecision(serviceRows, dashboardHealth, n8nHealth);

  const report = {
    serviceHealth: {
      okCount: serviceRows.ok.length,
      warnCount: serviceRows.warn.length,
      ok: serviceRows.ok,
      warn: serviceRows.warn,
    },
    dashboardHealth: {
      okCount: dashboardHealth.ok.length,
      warnCount: dashboardHealth.warn.length,
      ok: dashboardHealth.ok,
      warn: dashboardHealth.warn,
      leadMode: dashboardHealth.leadMode,
      runningBots: dashboardHealth.runningBots,
      totalBots: dashboardHealth.totalBots,
      shadowTotal: dashboardHealth.shadowTotal,
      mismatched: dashboardHealth.mismatched,
      mismatchRate: dashboardHealth.mismatchRate,
    },
    n8nHealth: {
      okCount: n8nHealth.ok.length,
      warnCount: n8nHealth.warn.length,
      ok: n8nHealth.ok,
      warn: n8nHealth.warn,
    },
    decision,
  };
  return report;
}

runHealthCli({
  buildReport,
  formatText,
  errorPrefix: '[클로드 운영 헬스 리포트]',
});
