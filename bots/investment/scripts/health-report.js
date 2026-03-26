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
import {
  getKisExecutionModeInfo,
  getKisMarketStatus,
  getKisOverseasMarketStatus,
} from '../shared/secrets.js';

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

function readLogTailLines(logPath, maxLines = 200) {
  try {
    const raw = readFileSync(logPath, 'utf8');
    const lines = raw.split('\n').map((line) => line.trimEnd()).filter(Boolean);
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

function readLastMatchingLine(logPath, matcher, maxLines = 400) {
  const lines = readLogTailLines(logPath, maxLines);
  for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
    if (matcher(lines[idx])) return lines[idx];
  }
  return null;
}

function sliceLatestDomesticPressureWindow(lines = []) {
  const isDecisionBoundary = (line) =>
    line.includes('[경고] 국내주식 판단 |') && line.includes('debate_capacity_hot');
  const lastDecisionIdx = lines.map((line, idx) => ({ line, idx }))
    .reverse()
    .find(({ line }) => isDecisionBoundary(line))?.idx;
  if (lastDecisionIdx == null) return lines;
  const prevDecisionIdx = lines
    .slice(0, lastDecisionIdx)
    .map((line, idx) => ({ line, idx }))
    .reverse()
    .find(({ line }) => isDecisionBoundary(line))?.idx;
  const start = prevDecisionIdx != null ? prevDecisionIdx + 1 : 0;
  return lines.slice(start, lastDecisionIdx + 1);
}

function parseDomesticCollectMetrics(line = '') {
  if (!line) return null;
  const extractNumber = (pattern) => {
    const match = line.match(pattern);
    return match ? Number(match[1]) : null;
  };
  return {
    symbols: extractNumber(/symbols=(\d+)/),
    tasks: extractNumber(/tasks=(\d+)/),
    concurrency: extractNumber(/concurrency=(\d+)/),
    failed: extractNumber(/failed=(\d+)/),
    coreFailed: extractNumber(/coreFailed=(\d+)/),
    enrichFailed: extractNumber(/enrichFailed=(\d+)/),
  };
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

function collectConfiguredLanes(policy) {
  const lanes = [];
  for (const [exchange, exchangeConfig] of Object.entries(policy.byExchange || {})) {
    lanes.push({ exchange, tradeMode: 'normal' });
    const tradeModes = exchangeConfig?.trade_modes || {};
    const tradeModeNames = Object.keys(tradeModes);
    for (const tradeMode of tradeModeNames) {
      if (tradeMode === 'normal') continue;
      lanes.push({ exchange, tradeMode });
    }
  }
  return lanes;
}

function classifyGuardReason(row = {}) {
  const code = String(row.block_code || '').trim() || 'legacy_unclassified';
  const reason = String(row.block_reason || '').toLowerCase();
  if (code !== 'capital_guard_rejected') return code;
  if (reason.includes('일간 매매 한도')) return 'daily_trade_limit';
  if (reason.includes('최대 동시 포지션') || reason.includes('최대 포지션 도달')) return 'max_concurrent_positions';
  if (reason.includes('reserve') || reason.includes('보유 부족') || reason.includes('현금 보유')) return 'cash_reserve';
  if (reason.includes('최소 주문')) return 'min_order_size';
  if (reason.includes('cooldown')) return 'loss_cooldown';
  return 'capital_guard_other';
}

function formatGuardReasonGroup(group) {
  switch (group) {
    case 'daily_trade_limit':
      return 'daily trade limit';
    case 'max_concurrent_positions':
      return 'max positions';
    case 'cash_reserve':
      return 'cash reserve';
    case 'min_order_size':
      return 'min order size';
    case 'loss_cooldown':
      return 'loss cooldown';
    case 'capital_guard_other':
      return 'capital guard other';
    default:
      return group;
  }
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

async function loadCapitalGuardBreakdown(periodDays = 14) {
  const rows = await pgPool.query(
    'investment',
    `
      SELECT
        COALESCE(NULLIF(block_code, ''), 'legacy_unclassified') AS block_code,
        COALESCE(block_reason, '') AS block_reason,
        COALESCE(trade_mode, 'normal') AS trade_mode,
        COUNT(*)::int AS cnt
      FROM investment.signals
      WHERE exchange = 'binance'
        AND created_at >= NOW() - INTERVAL '1 day' * $1
        AND status IN ('failed', 'blocked', 'rejected')
        AND COALESCE(block_code, '') = 'capital_guard_rejected'
      GROUP BY 1, 2, 3
      ORDER BY cnt DESC, trade_mode ASC, block_reason ASC
    `,
    [periodDays],
  ).catch(() => []);

  const byReasonGroup = new Map();
  const byTradeMode = new Map();
  for (const row of rows) {
    const group = classifyGuardReason(row);
    byReasonGroup.set(group, (byReasonGroup.get(group) || 0) + Number(row.cnt || 0));
    byTradeMode.set(row.trade_mode, (byTradeMode.get(row.trade_mode) || 0) + Number(row.cnt || 0));
  }

  return {
    periodDays,
    total: rows.reduce((sum, row) => sum + Number(row.cnt || 0), 0),
    byReasonGroup: [...byReasonGroup.entries()]
      .map(([group, count]) => ({ group, count, label: formatGuardReasonGroup(group) }))
      .sort((a, b) => b.count - a.count || a.group.localeCompare(b.group, 'ko')),
    byTradeMode: [...byTradeMode.entries()]
      .map(([tradeMode, count]) => ({ tradeMode, count }))
      .sort((a, b) => b.count - a.count || a.tradeMode.localeCompare(b.tradeMode, 'ko')),
  };
}

async function loadRecentLaneBlockPressure(windowMinutes = 60) {
  const rows = await pgPool.query(
    'investment',
    `
      SELECT
        COALESCE(exchange, 'unknown') AS exchange,
        COALESCE(trade_mode, 'normal') AS trade_mode,
        COUNT(*)::int AS cnt
      FROM investment.signals
      WHERE created_at > now() - INTERVAL '1 minute' * $1
        AND status IN ('failed', 'blocked', 'rejected')
        AND COALESCE(block_code, '') = 'capital_guard_rejected'
        AND COALESCE(block_reason, '') ILIKE '%일간 매매 한도%'
      GROUP BY 1, 2
      ORDER BY cnt DESC, exchange ASC, trade_mode ASC
    `,
    [windowMinutes],
  ).catch(() => []);

  const lanes = rows.map((row) => ({
    exchange: row.exchange,
    tradeMode: row.trade_mode,
    count: Number(row.cnt || 0),
    label: formatLaneLabel(row.exchange, row.trade_mode),
  }));

  return {
    windowMinutes,
    total: lanes.reduce((sum, lane) => sum + Number(lane.count || 0), 0),
    lanes,
    topLane: lanes[0] || null,
  };
}

async function loadMockUntradableSymbolHealth(windowMinutes = 1440) {
  const rows = await pgPool.query(
    'investment',
    `
      SELECT
        symbol,
        COALESCE(NULLIF(block_code, ''), 'legacy_unclassified') AS block_code,
        COUNT(*)::int AS cnt,
        MAX(created_at) AS last_seen_at
      FROM investment.signals
      WHERE exchange = 'kis'
        AND created_at > now() - INTERVAL '1 minute' * $1
        AND status IN ('failed', 'blocked', 'rejected')
        AND COALESCE(block_code, '') IN ('mock_untradable_symbol', 'mock_untradable_symbol_cooldown')
      GROUP BY 1, 2
      ORDER BY cnt DESC, symbol ASC, block_code ASC
    `,
    [windowMinutes],
  ).catch(() => []);

  const total = rows.reduce((sum, row) => sum + Number(row.cnt || 0), 0);
  const warn = rows.slice(0, 8).map((row) => {
    const label = row.block_code === 'mock_untradable_symbol_cooldown'
      ? 'mock 재시도 쿨다운'
      : 'mock 주문 불가';
    return `  ${row.symbol} ${label} ${Number(row.cnt || 0)}건`;
  });

  return {
    windowMinutes,
    total,
    okCount: total === 0 ? 1 : 0,
    warnCount: total > 0 ? rows.length : 0,
    ok: total === 0 ? ['  최근 KIS mock 주문 불가 종목 없음'] : [],
    warn,
    rows,
  };
}

async function loadDomesticCollectPressure(logLines = 200) {
  const logPath = SCHEDULED_SERVICE_DEPLOYMENTS['ai.investment.domestic']?.errorLogPath;
  const lines = readLogTailLines(logPath, logLines);
  const windowLines = sliceLatestDomesticPressureWindow(lines);
  const latestMetricLine = readLastMatchingLine(
    '/tmp/investment-domestic.log',
    (line) => line.includes('📈 [메트릭] 국내주식 수집 |'),
    400,
  );
  const latestMetrics = parseDomesticCollectMetrics(latestMetricLine);
  const counts = {
    wideUniverse: 0,
    collectOverload: 0,
    concurrencyGuard: 0,
    debateCapacityHot: 0,
    dataSparsity: 0,
    externalQuoteFailures: 0,
  };
  const sparseSymbols = new Set();

  for (const line of windowLines) {
    if (line.includes('[경고] 국내주식 수집 |')) {
      if (line.includes('wide_universe')) counts.wideUniverse += 1;
      if (line.includes('collect_overload_detected')) counts.collectOverload += 1;
      if (line.includes('concurrency_guard_active')) counts.concurrencyGuard += 1;
    }
    if (line.includes('[경고] 국내주식 판단 |') && line.includes('debate_capacity_hot')) {
      counts.debateCapacityHot += 1;
    }
    if (line.includes('[아리아]') && line.includes('데이터 부족')) {
      counts.dataSparsity += 1;
      const match = line.match(/\[아리아\]\s+([A-Z0-9]+)\s/);
      if (match?.[1]) sparseSymbols.add(match[1]);
    }
    if (line.includes('네이버 시세 API 실패') || line.includes('KIS 빈 응답')) {
      counts.externalQuoteFailures += 1;
    }
  }

  const warn = [];
  if (latestMetrics?.symbols != null || latestMetrics?.tasks != null) {
    warn.push(`  최신 cycle 메트릭: symbols ${latestMetrics.symbols ?? 'n/a'} / tasks ${latestMetrics.tasks ?? 'n/a'} / concurrency ${latestMetrics.concurrency ?? 'n/a'} / failed ${latestMetrics.failed ?? 'n/a'}`);
  }
  if (counts.collectOverload > 0 || counts.wideUniverse > 0 || counts.concurrencyGuard > 0) {
    warn.push(`  수집 압력: overload ${counts.collectOverload} / wide ${counts.wideUniverse} / concurrency ${counts.concurrencyGuard}`);
  }
  if (counts.debateCapacityHot > 0) {
    warn.push(`  판단 압력: debate_capacity_hot ${counts.debateCapacityHot}회`);
  }
  if (counts.dataSparsity > 0) {
    warn.push(`  data_sparsity: ${counts.dataSparsity}건 / 심볼 ${sparseSymbols.size}개`);
  }
  if (counts.externalQuoteFailures > 0) {
    warn.push(`  외부 시세/순위 조회 실패: ${counts.externalQuoteFailures}건`);
  }

  return {
    logLines,
    windowLines: windowLines.length,
    okCount: warn.length === 0 ? 1 : 0,
    warnCount: warn.length,
    ok: warn.length === 0 ? ['  최근 국내장 수집 압력 신호 없음'] : [],
    warn,
    counts,
    sparseSymbols: [...sparseSymbols].slice(0, 20),
    latestMetrics,
  };
}

async function loadDomesticRejectBreakdown(windowMinutes = 1440) {
  const rows = await pgPool.query(
    'investment',
    `
      SELECT
        COALESCE(NULLIF(block_code, ''), 'legacy_unclassified') AS block_code,
        COUNT(*)::int AS cnt
      FROM investment.signals
      WHERE exchange = 'kis'
        AND created_at > now() - INTERVAL '1 minute' * $1
        AND status IN ('failed', 'blocked', 'rejected')
        AND COALESCE(block_code, '') IN (
          'domestic_order_rejected',
          'mock_untradable_symbol',
          'mock_untradable_symbol_cooldown',
          'mock_untradable_symbol_recent',
          'broker_rate_limited',
          'market_closed',
          'quote_lookup_failed',
          'min_order_notional',
          'max_order_notional'
        )
      GROUP BY 1
      ORDER BY cnt DESC, block_code ASC
    `,
    [windowMinutes],
  ).catch(() => []);

  const labels = {
    domestic_order_rejected: '기타 domestic_order_rejected',
    mock_untradable_symbol: 'mock 주문 불가',
    mock_untradable_symbol_cooldown: 'mock 재시도 쿨다운',
    mock_untradable_symbol_recent: 'approval 최근 mock 주문 불가',
    broker_rate_limited: 'KIS rate limit',
    market_closed: '장종료/시장종료',
    quote_lookup_failed: '현재가 조회 실패',
    min_order_notional: '최소 주문금액 미달',
    max_order_notional: '최대 주문금액 초과',
  };

  const total = rows.reduce((sum, row) => sum + Number(row.cnt || 0), 0);
  const warn = rows.length > 0
    ? rows.map((row) => `  ${labels[row.block_code] || row.block_code}: ${Number(row.cnt || 0)}건`)
    : [];

  return {
    windowMinutes,
    total,
    okCount: total === 0 ? 1 : 0,
    warnCount: rows.length,
    ok: total === 0 ? ['  최근 국내장 주문 실패 세부 이슈 없음'] : [],
    warn,
    rows: rows.map((row) => ({
      ...row,
      label: labels[row.block_code] || row.block_code,
    })),
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

  const configured = collectConfiguredLanes(policy);
  const rowMap = new Map(
    rows.map((row) => [`${row.exchange}::${row.trade_mode}`, Number(row.cnt || 0)]),
  );
  const laneKeys = new Set([
    ...configured.map((lane) => `${lane.exchange}::${lane.tradeMode}`),
    ...rows.map((row) => `${row.exchange}::${row.trade_mode}`),
  ]);

  const lanes = [...laneKeys].sort((a, b) => a.localeCompare(b, 'ko')).map((key) => {
    const [exchange, tradeMode] = key.split('::');
    const count = Number(rowMap.get(key) || 0);
    const limit = resolveLaneTradeLimit(policy, exchange, tradeMode);
    const ratio = limit > 0 ? count / limit : 0;
    return {
      exchange,
      tradeMode,
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

function getStalePositionThresholdHours(exchange) {
  if (exchange === 'kis_overseas') return 72;
  if (exchange === 'kis') return 48;
  if (exchange === 'binance') return 48;
  return 48;
}

async function loadStalePositionHealth() {
  const rows = await pgPool.query(
    'investment',
    `
      SELECT
        exchange,
        symbol,
        paper,
        COALESCE(trade_mode, 'normal') AS trade_mode,
        amount,
        avg_price,
        updated_at,
        ROUND((amount * avg_price)::numeric, 2) AS position_value,
        ROUND(EXTRACT(EPOCH FROM (NOW() - updated_at))/3600::numeric, 1) AS age_hours
      FROM investment.positions
      WHERE amount > 0
        AND paper = false
      ORDER BY updated_at ASC
    `,
  ).catch(() => []);

  const staleRows = rows.filter((row) => {
    const ageHours = Number(row.age_hours || 0);
    const thresholdHours = getStalePositionThresholdHours(row.exchange);
    return ageHours >= thresholdHours;
  });

  const warn = staleRows.slice(0, 8).map((row) => {
    const thresholdHours = getStalePositionThresholdHours(row.exchange);
    const value = Number(row.position_value || 0).toFixed(2);
    return `  ${formatLaneLabel(row.exchange, row.trade_mode)} ${row.symbol} ${Number(row.age_hours || 0).toFixed(1)}h / value ${value} (threshold ${thresholdHours}h)`;
  });

  const ok = staleRows.length === 0
    ? ['  장기 미결 LIVE 포지션 없음']
    : [];

  return {
    okCount: staleRows.length === 0 ? 1 : 0,
    warnCount: staleRows.length,
    ok,
    warn,
    staleRows,
  };
}

async function loadCryptoLiveGateHealth() {
  try {
    const modulePath = path.resolve(__dirname, './crypto-live-gate-review.js');
    const mod = await import(pathToFileURL(modulePath).href);
    const review = await mod.loadCryptoLiveGateReview(3);
    const decision = String(review?.liveGate?.decision || 'unknown');
    const lines = [
      `  게이트: ${decision}`,
      `  사유: ${String(review?.liveGate?.reason || 'n/a')}`,
      `  체결: ${Number(review?.metrics?.trades?.total || 0)}건 (LIVE ${Number(review?.metrics?.trades?.live || 0)} / PAPER ${Number(review?.metrics?.trades?.paper || 0)})`,
      `  mode 체결: NORMAL ${Number(review?.metrics?.trades?.byMode?.NORMAL?.total || 0)}건 (LIVE ${Number(review?.metrics?.trades?.byMode?.NORMAL?.live || 0)} / PAPER ${Number(review?.metrics?.trades?.byMode?.NORMAL?.paper || 0)}), VALIDATION ${Number(review?.metrics?.trades?.byMode?.VALIDATION?.total || 0)}건 (LIVE ${Number(review?.metrics?.trades?.byMode?.VALIDATION?.live || 0)} / PAPER ${Number(review?.metrics?.trades?.byMode?.VALIDATION?.paper || 0)})`,
      `  퍼널: decision ${Number(review?.metrics?.pipeline?.decision || 0)} / BUY ${Number(review?.metrics?.pipeline?.buy || 0)} / approved ${Number(review?.metrics?.pipeline?.approved || 0)} / executed ${Number(review?.metrics?.pipeline?.executed || 0)}`,
      `  weak: ${Number(review?.metrics?.pipeline?.weak || 0)}${review?.metrics?.pipeline?.weakTop ? ` (top ${review.metrics.pipeline.weakTop})` : ''}`,
      `  reentry: PAPER ${Number(review?.metrics?.blocks?.paperReentry || 0)} / LIVE ${Number(review?.metrics?.blocks?.liveReentry || 0)} / same-day ${Number(review?.metrics?.blocks?.sameDayReentry || 0)}`,
      `  종료 리뷰: ${Number(review?.metrics?.closedReviews || 0)}건`,
    ];
    return {
      okCount: decision === 'candidate' ? 1 : 0,
      warnCount: decision === 'blocked' ? 1 : 0,
      ok: decision === 'candidate' ? lines : [],
      warn: decision === 'blocked' ? lines : [],
      review,
    };
  } catch (error) {
    return {
      okCount: 0,
      warnCount: 1,
      ok: [],
      warn: [`  LIVE 게이트 리뷰 로드 실패: ${error?.message || String(error)}`],
      review: null,
    };
  }
}

async function loadKisCapabilityHealth() {
  const domesticMode = getKisExecutionModeInfo('국내주식');
  const overseasMode = getKisExecutionModeInfo('해외주식');
  const domesticStatus = await getKisMarketStatus();
  const overseasStatus = getKisOverseasMarketStatus();

  const domesticCapability = domesticMode.brokerAccountMode === 'mock'
    ? (domesticStatus.isOpen ? 'mock SELL 검증 가능' : 'mock SELL 장중에만 가능')
    : 'real SELL 가능';
  const overseasCapability = overseasMode.brokerAccountMode === 'mock'
    ? 'mock SELL 미지원 (KIS 90000000)'
    : 'real SELL 가능';

  return {
    domestic: {
      accountMode: domesticMode.brokerAccountMode,
      executionMode: domesticMode.executionMode,
      marketStatus: domesticStatus,
      capability: domesticCapability,
    },
    overseas: {
      accountMode: overseasMode.brokerAccountMode,
      executionMode: overseasMode.executionMode,
      marketStatus: overseasStatus,
      capability: overseasCapability,
    },
    okCount: overseasMode.brokerAccountMode === 'mock' && !overseasStatus.isOpen ? 1 : 2,
    warnCount: overseasMode.brokerAccountMode === 'mock' && !overseasStatus.isOpen ? 1 : 0,
    ok: [
      `  국내주식 ${domesticMode.executionMode}/${domesticMode.brokerAccountMode} — ${domesticStatus.reason} / ${domesticCapability}`,
      ...(overseasMode.brokerAccountMode === 'mock'
        ? []
        : [`  해외주식 ${overseasMode.executionMode}/${overseasMode.brokerAccountMode} — ${overseasStatus.reason} / ${overseasCapability}`]),
    ],
    warn: overseasMode.brokerAccountMode === 'mock'
      ? [`  해외주식 ${overseasMode.executionMode}/${overseasMode.brokerAccountMode} — ${overseasStatus.reason} / ${overseasCapability}`]
      : [],
  };
}

function buildDecision(
  serviceRows,
  tradeReview,
  guardHealth,
  signalBlockHealth,
  recentSignalBlockHealth,
  recentLaneBlockPressure,
  mockUntradableSymbolHealth,
  domesticCollectPressure,
  domesticRejectBreakdown,
  tradeLaneHealth,
  stalePositionHealth,
  cryptoLiveGateHealth,
  capitalGuardBreakdown,
) {
  const topBlock = signalBlockHealth.top[0] || null;
  const topReasonGroup = signalBlockHealth.topReasonGroups?.[0] || null;
  const recentTopReasonGroup = recentSignalBlockHealth.topReasonGroups?.[0] || null;
  const saturatedLane = tradeLaneHealth.lanes.find((lane) => lane.atLimit);
  const nearLimitLane = tradeLaneHealth.lanes.find((lane) => lane.nearLimit);
  const pressureLane = recentLaneBlockPressure.topLane || null;
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
        active: recentLaneBlockPressure.total >= 1,
        level: pressureLane?.count >= 3 ? 'medium' : 'low',
        reason: `최근 ${recentLaneBlockPressure.windowMinutes}분 일간 한도 압력 ${recentLaneBlockPressure.total}건 — 최다 rail ${pressureLane?.label || 'n/a'} ${pressureLane?.count || 0}건`,
      },
      {
        active: domesticCollectPressure.warnCount > 0,
        level: domesticCollectPressure.counts.collectOverload > 0 || domesticCollectPressure.counts.debateCapacityHot > 0 ? 'medium' : 'low',
        reason: `국내장 최신 cycle(${domesticCollectPressure.windowLines}줄) 기준 수집 압력 — symbols ${domesticCollectPressure.latestMetrics?.symbols ?? 'n/a'}, tasks ${domesticCollectPressure.latestMetrics?.tasks ?? 'n/a'}, overload ${domesticCollectPressure.counts.collectOverload}, wide ${domesticCollectPressure.counts.wideUniverse}, debate ${domesticCollectPressure.counts.debateCapacityHot}, data_sparsity ${domesticCollectPressure.counts.dataSparsity}`,
      },
      {
        active: mockUntradableSymbolHealth.total > 0,
        level: 'low',
        reason: `최근 ${mockUntradableSymbolHealth.windowMinutes / 60}시간 KIS mock 주문 불가 종목 ${mockUntradableSymbolHealth.total}건 — screening/approval 쿨다운 관찰 필요`,
      },
      {
        active: domesticRejectBreakdown.total > 0,
        level: domesticRejectBreakdown.rows[0]?.block_code === 'broker_rate_limited' ? 'medium' : 'low',
        reason: `최근 ${domesticRejectBreakdown.windowMinutes / 60}시간 국내장 주문 실패 ${domesticRejectBreakdown.total}건 — 최다 ${domesticRejectBreakdown.rows[0]?.label || 'n/a'} ${domesticRejectBreakdown.rows[0]?.cnt || 0}건`,
      },
      {
        active: Boolean(saturatedLane || nearLimitLane),
        level: saturatedLane ? 'medium' : 'low',
        reason: saturatedLane
          ? `거래 한도 도달 rail ${formatLaneLabel(saturatedLane.exchange, saturatedLane.tradeMode)} ${saturatedLane.count}/${saturatedLane.limit}`
          : `거래 한도 근접 rail ${formatLaneLabel(nearLimitLane?.exchange, nearLimitLane?.tradeMode)} ${nearLimitLane?.count}/${nearLimitLane?.limit}`,
      },
      {
        active: capitalGuardBreakdown.total > 0,
        level: capitalGuardBreakdown.byReasonGroup[0]?.group === 'daily_trade_limit' ? 'medium' : 'low',
        reason: `최근 ${capitalGuardBreakdown.periodDays}일 crypto capital guard ${capitalGuardBreakdown.total}건 — 최다 ${capitalGuardBreakdown.byReasonGroup[0]?.label || 'n/a'} ${capitalGuardBreakdown.byReasonGroup[0]?.count || 0}건 / mode ${capitalGuardBreakdown.byTradeMode[0]?.tradeMode || 'n/a'} ${capitalGuardBreakdown.byTradeMode[0]?.count || 0}건`,
      },
      {
        active: stalePositionHealth.warnCount > 0,
        level: 'medium',
        reason: `장기 미결 LIVE 포지션 ${stalePositionHealth.warnCount}건 — force-exit/정리 기준 점검 필요`,
      },
      {
        active: cryptoLiveGateHealth.warnCount > 0,
        level: 'medium',
        reason: `암호화폐 LIVE 게이트 ${cryptoLiveGateHealth.review?.liveGate?.decision || 'blocked'} — ${cryptoLiveGateHealth.review?.liveGate?.reason || 'PAPER/LIVE 전환 데이터 부족'}`,
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
    {
      title: `■ crypto capital guard 분해(최근 ${report.capitalGuardBreakdown.periodDays}일)`,
      lines: report.capitalGuardBreakdown.total > 0
        ? [
            `  총 ${report.capitalGuardBreakdown.total}건`,
            ...report.capitalGuardBreakdown.byReasonGroup.map((row) => `  ${row.label}: ${row.count}건`),
            ...report.capitalGuardBreakdown.byTradeMode.map((row) => `  mode ${row.tradeMode}: ${row.count}건`),
          ]
        : ['  최근 crypto capital guard 차단 없음'],
    },
    {
      title: `■ 최근 ${report.recentLaneBlockPressure.windowMinutes}분 rail 압력`,
      lines: report.recentLaneBlockPressure.total > 0
        ? report.recentLaneBlockPressure.lanes.map((lane) => `  ${lane.label}: ${lane.count}건`)
        : ['  최근 일간 한도 rail 압력 없음'],
    },
    buildHealthCountSection(`■ KIS mock 주문 불가 종목(최근 ${Math.round(report.mockUntradableSymbolHealth.windowMinutes / 60)}시간)`, report.mockUntradableSymbolHealth, { okLimit: 1, warnLimit: 8 }),
    buildHealthCountSection(`■ 국내장 수집 압력(최신 cycle / 로그 ${report.domesticCollectPressure.windowLines}줄, tail ${report.domesticCollectPressure.logLines}줄)`, report.domesticCollectPressure, { okLimit: 1, warnLimit: 8 }),
    buildHealthCountSection(`■ 국내장 주문 실패 분해(최근 ${Math.round(report.domesticRejectBreakdown.windowMinutes / 60)}시간)`, report.domesticRejectBreakdown, { okLimit: 1, warnLimit: 10 }),
    buildHealthCountSection('■ 장기 미결 LIVE 포지션', report.stalePositionHealth, { okLimit: 1, warnLimit: 8 }),
    buildHealthCountSection('■ 암호화폐 LIVE 게이트(최근 3일)', report.cryptoLiveGateHealth, { okLimit: 1, warnLimit: 1 }),
    buildHealthCountSection('■ KIS 실행 capability', report.kisCapabilityHealth, { okLimit: 1, warnLimit: 2 }),
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
  const recentLaneBlockPressure = await loadRecentLaneBlockPressure();
  const mockUntradableSymbolHealth = await loadMockUntradableSymbolHealth();
  const domesticCollectPressure = await loadDomesticCollectPressure();
  const domesticRejectBreakdown = await loadDomesticRejectBreakdown();
  const tradeLaneHealth = await loadTradeLaneHealth();
  const stalePositionHealth = await loadStalePositionHealth();
  const cryptoLiveGateHealth = await loadCryptoLiveGateHealth();
  const capitalGuardBreakdown = await loadCapitalGuardBreakdown();
  const kisCapabilityHealth = await loadKisCapabilityHealth();
  const decision = buildDecision(
    serviceRows,
    tradeReview,
    guardHealth,
    signalBlockHealth,
    recentSignalBlockHealth,
    recentLaneBlockPressure,
    mockUntradableSymbolHealth,
    domesticCollectPressure,
    domesticRejectBreakdown,
    tradeLaneHealth,
    stalePositionHealth,
    cryptoLiveGateHealth,
    capitalGuardBreakdown,
  );

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
    recentLaneBlockPressure,
    mockUntradableSymbolHealth,
    domesticCollectPressure,
    domesticRejectBreakdown,
    tradeLaneHealth,
    stalePositionHealth,
    cryptoLiveGateHealth,
    capitalGuardBreakdown,
    kisCapabilityHealth,
    decision,
  };
  return report;
}

runHealthCli({
  buildReport,
  formatText,
  errorPrefix: '[루나 운영 헬스 리포트]',
});
