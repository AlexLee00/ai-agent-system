/**
 * scripts/health-report.js — 루나팀 운영자용 헬스 리포트
 *
 * 목적:
 *   - launchd 상태와 trade_review 정합성을 사람이 읽기 좋은 형태로 요약
 *   - 공용 health-core 포맷을 사용하는 1차 report 스크립트
 *
 * 실행:
 *   node bots/investment/scripts/health-report.js [--json]
 */

import { readFileSync, statSync } from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import yaml from 'js-yaml';

const require = createRequire(import.meta.url);
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
} = require('../../../packages/core/lib/health-provider');
const billingGuard = require('../../../packages/core/lib/billing-guard');
const pgPool = require('../../../packages/core/lib/pg-pool');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONTINUOUS = [
  'ai.investment.commander',
];

const ALL_SERVICES = [
  'ai.investment.commander',
  'ai.investment.crypto',
  'ai.investment.domestic',
  'ai.investment.overseas',
  'ai.investment.argos',
  'ai.investment.market-alert-crypto-daily',
  'ai.investment.market-alert-domestic-open',
  'ai.investment.market-alert-domestic-close',
  'ai.investment.market-alert-overseas-open',
  'ai.investment.market-alert-overseas-close',
  'ai.investment.prescreen-domestic',
  'ai.investment.prescreen-overseas',
  'ai.investment.reporter',
];

const NORMAL_EXIT_CODES = DEFAULT_NORMAL_EXIT_CODES;
const SCHEDULED_SERVICE_DEPLOYMENTS = {
  'ai.investment.crypto': {
    scriptPath: path.resolve(__dirname, '..', 'markets', 'crypto.js'),
    errorLogPath: '/tmp/investment-crypto.err.log',
  },
  'ai.investment.domestic': {
    scriptPath: path.resolve(__dirname, '..', 'markets', 'domestic.js'),
    errorLogPath: '/tmp/investment-domestic.err.log',
  },
  'ai.investment.overseas': {
    scriptPath: path.resolve(__dirname, '..', 'markets', 'overseas.js'),
    errorLogPath: '/tmp/investment-overseas.err.log',
  },
};

function formatGuardScope(scope = '') {
  const normalized = String(scope || '').trim().toLowerCase();
  if (normalized === 'investment.normal.crypto') return '암호화폐';
  if (normalized === 'investment.normal.domestic') return '국내주식';
  if (normalized === 'investment.normal.overseas') return '해외주식';
  if (normalized.startsWith('investment.normal.crypto.')) return `암호화폐/${normalized.split('.').pop()}`;
  if (normalized.startsWith('investment.normal.domestic.')) return `국내주식/${normalized.split('.').pop()}`;
  if (normalized.startsWith('investment.normal.overseas.')) return `해외주식/${normalized.split('.').pop()}`;
  return normalized || 'unknown';
}

function formatGuardExpiry(expiresAt) {
  if (!expiresAt) return '수동 해제';
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return '수동 해제';
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

function formatGuardReason(reason = '') {
  const text = String(reason || '').trim();
  if (!text) return '';
  return text
    .replace(/^\[(.*?)\]\s*/i, '$1 ')
    .replace(/10분 급등\s*/g, '급등 ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildScheduledDeploymentState() {
  const state = {};
  for (const [label, deployment] of Object.entries(SCHEDULED_SERVICE_DEPLOYMENTS)) {
    try {
      const scriptMtimeMs = statSync(deployment.scriptPath).mtimeMs;
      const logMtimeMs = statSync(deployment.errorLogPath).mtimeMs;
      state[label] = {
        staleFailure: scriptMtimeMs > logMtimeMs,
        scriptMtimeMs,
        logMtimeMs,
      };
    } catch {
      state[label] = {
        staleFailure: false,
        scriptMtimeMs: null,
        logMtimeMs: null,
      };
    }
  }
  return state;
}

function loadCapitalPolicySnapshot() {
  try {
    const raw = yaml.load(readFileSync(path.resolve(__dirname, '..', 'config.yaml'), 'utf8'));
    const capital = raw?.capital_management || {};
    return {
      defaultLimit: Number(capital.max_daily_trades || 0),
      byExchange: capital.by_exchange || {},
    };
  } catch {
    return {
      defaultLimit: 0,
      byExchange: {},
    };
  }
}

function resolveLaneTradeLimit(policy, exchange, tradeMode) {
  const exchangeConfig = policy.byExchange?.[exchange] || {};
  const tradeModeConfig = exchangeConfig.trade_modes?.[tradeMode] || {};
  return Number(
    tradeModeConfig.max_daily_trades
    ?? exchangeConfig.max_daily_trades
    ?? policy.defaultLimit
    ?? 0,
  );
}

function formatLaneLabel(exchange, tradeMode) {
  return `${String(exchange || 'unknown').toUpperCase()} / ${String(tradeMode || 'normal')}`;
}

function classifyGuardReason(row = {}) {
  const code = String(row.block_code || '').trim() || 'legacy_unclassified';
  const reason = String(row.block_reason || '').toLowerCase();
  if (code !== 'capital_guard_rejected') return code;
  if (reason.includes('일간 매매 한도')) return 'daily_trade_limit';
  if (reason.includes('최대 동시 포지션')) return 'max_concurrent_positions';
  if (reason.includes('reserve') || reason.includes('보유 부족') || reason.includes('현금 보유')) return 'cash_reserve';
  if (reason.includes('최소 주문')) return 'min_order_size';
  if (reason.includes('cooldown')) return 'loss_cooldown';
  return 'capital_guard_other';
}

function buildGuardHealth() {
  const rows = billingGuard.listActiveGuards('investment.normal');
  if (rows.length === 0) {
    return {
      okCount: 1,
      warnCount: 0,
      ok: ['  투자 LLM guard 없음'],
      warn: [],
    };
  }
  return {
    okCount: 0,
    warnCount: rows.length,
    ok: [],
    warn: rows.flatMap((row) => {
      const expires = formatGuardExpiry(row.expires_at);
      const lines = [`  ${formatGuardScope(row.scope)} 차단 / 해제 ${expires}`];
      const reason = formatGuardReason(row.reason);
      if (reason) lines.push(`    사유: ${reason}`);
      return lines;
    }),
  };
}

async function loadTradeReviewHealth() {
  const modulePath = path.resolve(__dirname, './validate-trade-review.js');
  const mod = await import(pathToFileURL(modulePath).href);
  const result = await mod.validateTradeReview({ days: 90, fix: false });
  return {
    findings: result.findings || 0,
    closedTrades: result.closedTrades || 0,
  };
}

async function loadSignalBlockHealth() {
  const rows = await pgPool.query(
    'investment',
    `
      SELECT
        COALESCE(NULLIF(block_code, ''), 'legacy_unclassified') AS block_code,
        COALESCE(block_reason, '') AS block_reason,
        COUNT(*)::int AS cnt
      FROM investment.signals
      WHERE created_at::date = CURRENT_DATE
        AND status IN ('failed', 'blocked', 'rejected')
      GROUP BY 1, 2
      ORDER BY cnt DESC, block_code ASC
    `,
  ).catch(() => []);

  const grouped = new Map();
  for (const row of rows) {
    const code = String(row.block_code || 'legacy_unclassified');
    grouped.set(code, (grouped.get(code) || 0) + Number(row.cnt || 0));
  }
  const top = [...grouped.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code, 'ko'))
    .slice(0, 5);

  const reasonGroups = new Map();
  for (const row of rows) {
    const group = classifyGuardReason(row);
    reasonGroups.set(group, (reasonGroups.get(group) || 0) + Number(row.cnt || 0));
  }
  const topReasonGroups = [...reasonGroups.entries()]
    .map(([group, count]) => ({ group, count }))
    .sort((a, b) => b.count - a.count || a.group.localeCompare(b.group, 'ko'))
    .slice(0, 5);

  const total = [...grouped.values()].reduce((sum, count) => sum + Number(count || 0), 0);
  return {
    total,
    top,
    topReasonGroups,
  };
}

async function loadRecentSignalBlockHealth(windowMinutes = 60) {
  const rows = await pgPool.query(
    'investment',
    `
      SELECT
        COALESCE(NULLIF(block_code, ''), 'legacy_unclassified') AS block_code,
        COALESCE(block_reason, '') AS block_reason,
        COUNT(*)::int AS cnt
      FROM investment.signals
      WHERE created_at > now() - INTERVAL '1 minute' * $1
        AND status IN ('failed', 'blocked', 'rejected')
      GROUP BY 1, 2
      ORDER BY cnt DESC, block_code ASC
    `,
    [windowMinutes],
  ).catch(() => []);

  const grouped = new Map();
  for (const row of rows) {
    const code = String(row.block_code || 'legacy_unclassified');
    grouped.set(code, (grouped.get(code) || 0) + Number(row.cnt || 0));
  }

  const reasonGroups = new Map();
  for (const row of rows) {
    const group = classifyGuardReason(row);
    reasonGroups.set(group, (reasonGroups.get(group) || 0) + Number(row.cnt || 0));
  }

  return {
    windowMinutes,
    total: [...grouped.values()].reduce((sum, count) => sum + Number(count || 0), 0),
    top: [...grouped.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code, 'ko'))
      .slice(0, 5),
    topReasonGroups: [...reasonGroups.entries()]
      .map(([group, count]) => ({ group, count }))
      .sort((a, b) => b.count - a.count || a.group.localeCompare(b.group, 'ko'))
      .slice(0, 5),
  };
}

async function loadTradeLaneHealth() {
  const policy = loadCapitalPolicySnapshot();
  const rows = await pgPool.query(
    'investment',
    `
      SELECT
        exchange,
        COALESCE(trade_mode, 'normal') AS trade_mode,
        COUNT(*)::int AS cnt
      FROM investment.trades
      WHERE executed_at::date = CURRENT_DATE
        AND LOWER(COALESCE(side, '')) = 'buy'
      GROUP BY 1, 2
      ORDER BY exchange ASC, trade_mode ASC
    `,
  ).catch(() => []);

  const lanes = rows.map((row) => {
    const count = Number(row.cnt || 0);
    const limit = resolveLaneTradeLimit(policy, row.exchange, row.trade_mode);
    const ratio = limit > 0 ? count / limit : 0;
    return {
      exchange: row.exchange,
      tradeMode: row.trade_mode,
      count,
      limit,
      ratio,
      nearLimit: limit > 0 && ratio >= 0.8,
      atLimit: limit > 0 && count >= limit,
    };
  });

  const warn = lanes
    .filter((lane) => lane.nearLimit)
    .map((lane) => {
      const status = lane.atLimit ? '한도 도달' : '한도 근접';
      return `  ${formatLaneLabel(lane.exchange, lane.tradeMode)} ${lane.count}/${lane.limit} (${status})`;
    });

  const ok = lanes
    .filter((lane) => !lane.nearLimit)
    .map((lane) => `  ${formatLaneLabel(lane.exchange, lane.tradeMode)} ${lane.count}/${lane.limit}`);

  return {
    okCount: ok.length,
    warnCount: warn.length,
    ok,
    warn,
    lanes,
  };
}

function buildDecision(serviceRows, tradeReview, guardHealth, signalBlockHealth, recentSignalBlockHealth, tradeLaneHealth) {
  const topBlock = signalBlockHealth.top[0] || null;
  const topReasonGroup = signalBlockHealth.topReasonGroups?.[0] || null;
  const recentTopReasonGroup = recentSignalBlockHealth.topReasonGroups?.[0] || null;
  const saturatedLane = tradeLaneHealth.lanes.find((lane) => lane.atLimit);
  const nearLimitLane = tradeLaneHealth.lanes.find((lane) => lane.nearLimit);
  return buildHealthDecision({
    warnings: [
      {
        active: serviceRows.warn.length > 0,
        level: 'high',
        reason: `launchd 경고 ${serviceRows.warn.length}건이 있어 서비스 상태 점검이 필요합니다.`,
      },
      {
        active: tradeReview.findings > 0,
        level: 'medium',
        reason: `trade_review 정합성 이슈 ${tradeReview.findings}건이 남아 있습니다.`,
      },
      {
        active: guardHealth.warnCount > 0,
        level: 'medium',
        reason: `투자 LLM guard ${guardHealth.warnCount}건이 활성 상태입니다.`,
      },
      {
        active: signalBlockHealth.total >= 5,
        level: topReasonGroup?.group === 'daily_trade_limit' ? 'medium' : 'low',
        reason: `오늘 차단/거부 신호 ${signalBlockHealth.total}건 — 최다 코드 ${topBlock?.code || 'n/a'} ${topBlock?.count || 0}건 / 최다 세부 그룹 ${topReasonGroup?.group || 'n/a'} ${topReasonGroup?.count || 0}건`,
      },
      {
        active: recentSignalBlockHealth.total >= 1,
        level: recentTopReasonGroup?.group === 'daily_trade_limit' ? 'medium' : 'low',
        reason: `최근 ${recentSignalBlockHealth.windowMinutes}분 차단/거부 ${recentSignalBlockHealth.total}건 — 최다 세부 그룹 ${recentTopReasonGroup?.group || 'n/a'} ${recentTopReasonGroup?.count || 0}건`,
      },
      {
        active: Boolean(saturatedLane || nearLimitLane),
        level: saturatedLane ? 'medium' : 'low',
        reason: saturatedLane
          ? `거래 한도 도달 rail ${formatLaneLabel(saturatedLane.exchange, saturatedLane.tradeMode)} ${saturatedLane.count}/${saturatedLane.limit}`
          : `거래 한도 근접 rail ${formatLaneLabel(nearLimitLane?.exchange, nearLimitLane?.tradeMode)} ${nearLimitLane?.count}/${nearLimitLane?.limit}`,
      },
    ],
    okReason: '핵심 서비스와 trade_review 정합성이 현재는 안정 구간입니다.',
  });
}

function formatText(report) {
  const sections = [
    buildHealthCountSection('■ 서비스 상태', report.serviceHealth),
    {
      title: '■ trade_review 정합성',
      lines: [
        `  종료 거래 ${report.tradeReview.closedTrades}건`,
        `  점검 필요 ${report.tradeReview.findings}건`,
      ],
    },
    buildHealthCountSection('■ 투자 LLM guard', report.guardHealth, { okLimit: 1 }),
    {
      title: '■ 신호 차단 코드(오늘)',
      lines: report.signalBlockHealth.total > 0
        ? [
            `  총 ${report.signalBlockHealth.total}건`,
            ...report.signalBlockHealth.top.map((row) => `  ${row.code}: ${row.count}건`),
          ]
        : ['  오늘 차단/거부 신호 없음'],
    },
    {
      title: '■ 자본/가드 차단 세부(오늘)',
      lines: report.signalBlockHealth.topReasonGroups?.length > 0
        ? report.signalBlockHealth.topReasonGroups.map((row) => `  ${row.group}: ${row.count}건`)
        : ['  세부 차단 그룹 없음'],
    },
    {
      title: `■ 최근 ${report.recentSignalBlockHealth.windowMinutes}분 차단 세부`,
      lines: report.recentSignalBlockHealth.total > 0
        ? [
            `  총 ${report.recentSignalBlockHealth.total}건`,
            ...report.recentSignalBlockHealth.topReasonGroups.map((row) => `  ${row.group}: ${row.count}건`),
          ]
        : ['  최근 차단/거부 신호 없음'],
    },
    buildHealthCountSection('■ rail별 신규 진입 한도(오늘)', report.tradeLaneHealth, { okLimit: 6, warnLimit: 6 }),
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
  ];

  const sampleSection = buildHealthSampleSection('■ 정상 서비스 샘플', report.serviceHealth);
  if (sampleSection) sections.splice(1, 0, sampleSection);

  return buildHealthReport({
    title: '📊 루나 운영 헬스 리포트',
    sections,
    footer: ['실행: node bots/investment/scripts/health-report.js --json'],
  });
}

async function buildReport() {
  const status = getLaunchctlStatus();
  const scheduledDeploymentState = buildScheduledDeploymentState();
  const serviceRows = buildServiceRows(status, {
    labels: ALL_SERVICES,
    continuous: CONTINUOUS,
    normalExitCodes: NORMAL_EXIT_CODES,
    shortLabel: (label) => hsm.shortLabel(label),
    isExpectedExit: (label, exitCode, svc) => {
      if (svc?.running) return false;
      if (NORMAL_EXIT_CODES.has(exitCode)) return true;
      return scheduledDeploymentState[label]?.staleFailure === true;
    },
  });
  const tradeReview = await loadTradeReviewHealth();
  const guardHealth = buildGuardHealth();
  const signalBlockHealth = await loadSignalBlockHealth();
  const recentSignalBlockHealth = await loadRecentSignalBlockHealth();
  const tradeLaneHealth = await loadTradeLaneHealth();
  const decision = buildDecision(serviceRows, tradeReview, guardHealth, signalBlockHealth, recentSignalBlockHealth, tradeLaneHealth);

  const report = {
    serviceHealth: {
      okCount: serviceRows.ok.length,
      warnCount: serviceRows.warn.length,
      ok: serviceRows.ok,
      warn: serviceRows.warn,
    },
    tradeReview,
    guardHealth,
    signalBlockHealth,
    recentSignalBlockHealth,
    tradeLaneHealth,
    decision,
  };
  return report;
}

runHealthCli({
  buildReport,
  formatText,
  errorPrefix: '[루나 운영 헬스 리포트]',
});
