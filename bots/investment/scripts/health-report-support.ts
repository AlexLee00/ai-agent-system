// @ts-nocheck
import { readFileSync, statSync } from 'fs';
import yaml from 'js-yaml';

export function formatGuardScope(scope = '') {
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

export function buildScheduledDeploymentState(deployments = {}) {
  const state = {};
  for (const [label, deployment] of Object.entries(deployments)) {
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

export function loadCapitalPolicySnapshot(configPath) {
  try {
    const raw = yaml.load(readFileSync(configPath, 'utf8'));
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

export function formatLaneLabel(exchange, tradeMode) {
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
  if (code === 'mock_operation_unsupported') return 'mock_policy_limit';
  if (code !== 'capital_guard_rejected') return code;
  if (reason.includes('상관관계 가드')) return 'correlation_guard';
  if (reason.includes('일간 매매 한도')) return 'daily_trade_limit';
  if (reason.includes('최대 동시 포지션') || reason.includes('최대 포지션 도달')) return 'max_concurrent_positions';
  if (reason.includes('reserve') || reason.includes('보유 부족') || reason.includes('현금 보유')) return 'cash_reserve';
  if (reason.includes('최소 주문')) return 'min_order_size';
  if (reason.includes('cooldown')) return 'loss_cooldown';
  return 'capital_guard_other';
}

function formatGuardReasonGroup(group) {
  switch (group) {
    case 'mock_policy_limit':
      return 'mock policy limit';
    case 'correlation_guard':
      return 'correlation guard';
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

function aggregateSignalBlockRows(rows = []) {
  const grouped = new Map();
  const reasonGroups = new Map();

  for (const row of rows) {
    const code = String(row.block_code || 'legacy_unclassified');
    grouped.set(code, (grouped.get(code) || 0) + Number(row.cnt || 0));

    const group = classifyGuardReason(row);
    reasonGroups.set(group, (reasonGroups.get(group) || 0) + Number(row.cnt || 0));
  }

  const top = [...grouped.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code, 'ko'))
    .slice(0, 5);
  const topReasonGroups = [...reasonGroups.entries()]
    .map(([group, count]) => ({ group, count }))
    .sort((a, b) => b.count - a.count || a.group.localeCompare(b.group, 'ko'))
    .slice(0, 5);
  const total = [...grouped.values()].reduce((sum, count) => sum + Number(count || 0), 0);
  const policyOnlyCount = Number(reasonGroups.get('mock_policy_limit') || 0);

  return {
    total,
    actionableTotal: Math.max(0, total - policyOnlyCount),
    policyOnlyCount,
    top,
    topReasonGroups,
  };
}

export function buildGuardHealth(billingGuard) {
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

export async function loadSignalBlockHealth(pgPool) {
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
  return aggregateSignalBlockRows(rows);
}

export async function loadRecentSignalBlockHealth(pgPool, windowMinutes = 60) {
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
  return {
    windowMinutes,
    ...aggregateSignalBlockRows(rows),
  };
}

export async function loadCapitalGuardBreakdown(pgPool, periodDays = 14) {
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

  const total = rows.reduce((sum, row) => sum + Number(row.cnt || 0), 0);
  const reasonRows = [...byReasonGroup.entries()]
    .map(([group, count]) => ({ group, count, label: formatGuardReasonGroup(group) }))
    .sort((a, b) => b.count - a.count || a.group.localeCompare(b.group, 'ko'));
  const tradeModeRows = [...byTradeMode.entries()]
    .map(([tradeMode, count]) => ({ tradeMode, count }))
    .sort((a, b) => b.count - a.count || a.tradeMode.localeCompare(b.tradeMode, 'ko'));
  const validationCount = Number(tradeModeRows.find((row) => row.tradeMode === 'validation')?.count || 0);
  const normalCount = Number(tradeModeRows.find((row) => row.tradeMode === 'normal')?.count || 0);
  const validationRatio = total > 0 ? Number(((validationCount / total) * 100).toFixed(1)) : 0;
  const topReason = reasonRows[0] || null;

  return {
    periodDays,
    total,
    byReasonGroup: reasonRows,
    byTradeMode: tradeModeRows,
    laneSnapshot: {
      validationCount,
      normalCount,
      validationRatio,
      topReason,
    },
  };
}

export async function loadRecentLaneBlockPressure(pgPool, windowMinutes = 60) {
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

export async function loadMockUntradableSymbolHealth(pgPool, windowMinutes = 1440) {
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

export async function loadDomesticCollectPressure(deployments, logLines = 200) {
  const logPath = deployments['ai.investment.domestic']?.errorLogPath;
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
  const ok = [];
  if (latestMetrics?.symbols != null || latestMetrics?.tasks != null) {
    ok.push(`  최신 cycle 메트릭: symbols ${latestMetrics.symbols ?? 'n/a'} / tasks ${latestMetrics.tasks ?? 'n/a'} / concurrency ${latestMetrics.concurrency ?? 'n/a'} / failed ${latestMetrics.failed ?? 'n/a'}`);
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
    const canDowngradeExternalFailures =
      counts.collectOverload === 0 &&
      counts.wideUniverse === 0 &&
      counts.concurrencyGuard === 0 &&
      counts.debateCapacityHot === 0 &&
      counts.dataSparsity === 0 &&
      Number(latestMetrics?.failed || 0) === 0;

    const line = `  외부 시세/순위 조회 실패: ${counts.externalQuoteFailures}건`;
    if (canDowngradeExternalFailures) {
      ok.push(`${line} (보조 랭킹 조회 노이즈)`);
    } else {
      warn.push(line);
    }
  }

  return {
    logLines,
    windowLines: windowLines.length,
    okCount: warn.length === 0 ? 1 : 0,
    warnCount: warn.length,
    ok: warn.length === 0 ? (ok.length ? ok : ['  최근 국내장 수집 압력 신호 없음']) : ok,
    warn,
    counts,
    sparseSymbols: [...sparseSymbols].slice(0, 20),
    latestMetrics,
  };
}

export async function loadDomesticRejectBreakdown(pgPool, windowMinutes = 1440) {
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

export async function loadTradeLaneHealth(pgPool, policy) {
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

export async function loadCryptoValidationSoftBudgetHealth(pgPool, policy, softBudget) {
  const hardCap = resolveLaneTradeLimit(policy, 'binance', 'validation');
  const rows = await pgPool.query(
    'investment',
    `
      SELECT COUNT(*)::int AS cnt
      FROM investment.trades
      WHERE exchange = 'binance'
        AND COALESCE(trade_mode, 'normal') = 'validation'
        AND LOWER(COALESCE(side, '')) = 'buy'
        AND executed_at::date = CURRENT_DATE
    `,
  ).catch(() => []);

  const count = Number(rows[0]?.cnt || 0);
  const reserveSlots = softBudget.reserveDailyBuySlots;
  const softCap = hardCap > 0 ? Math.max(1, hardCap - reserveSlots) : 0;
  const ratio = softCap > 0 ? count / softCap : 0;
  const atSoftCap = softCap > 0 && count >= softCap;
  const nearSoftCap = softCap > 0 && !atSoftCap && ratio >= 0.8;
  const line =
    `  BINANCE / validation BUY ${count}/${softCap || 'n/a'} soft cap` +
    ` (hard ${hardCap || 'n/a'}, reserve ${reserveSlots})`;

  return {
    enabled: softBudget.enabled,
    reserveSlots,
    hardCap,
    softCap,
    count,
    ratio,
    atSoftCap,
    nearSoftCap,
    okCount: softBudget.enabled && !atSoftCap && !nearSoftCap ? 1 : 0,
    warnCount: softBudget.enabled && (atSoftCap || nearSoftCap) ? 1 : 0,
    ok: softBudget.enabled && !atSoftCap && !nearSoftCap ? [line] : [],
    warn: softBudget.enabled && (atSoftCap || nearSoftCap)
      ? [line + (atSoftCap ? ' (soft cap 도달)' : ' (soft cap 근접)')]
      : [],
  };
}

export async function loadCryptoValidationBudgetBlockHealth(pgPool, windowMinutes = 1440) {
  const rows = await pgPool.query(
    'investment',
    `
      SELECT
        symbol,
        COUNT(*)::int AS cnt,
        MAX(created_at) AS last_seen_at
      FROM investment.signals
      WHERE exchange = 'binance'
        AND created_at > now() - INTERVAL '1 minute' * $1
        AND status IN ('failed', 'blocked', 'rejected')
        AND COALESCE(block_code, '') = 'validation_daily_budget_soft_cap'
      GROUP BY 1
      ORDER BY cnt DESC, symbol ASC
    `,
    [windowMinutes],
  ).catch(() => []);

  const total = rows.reduce((sum, row) => sum + Number(row.cnt || 0), 0);
  const warn = rows.slice(0, 8).map((row) => `  ${row.symbol} validation soft cap ${Number(row.cnt || 0)}건`);

  return {
    windowMinutes,
    total,
    okCount: total === 0 ? 1 : 0,
    warnCount: total > 0 ? rows.length : 0,
    ok: total === 0 ? ['  최근 crypto validation soft cap 차단 없음'] : [],
    warn,
    rows,
  };
}

export async function loadCryptoSentinelFallbackHealth(pgPool, windowMinutes = 1440) {
  const rows = await pgPool.query(
    'investment',
    `
      SELECT metadata
      FROM investment.pipeline_node_runs
      WHERE node_id = 'L03'
        AND started_at > (extract(epoch from now() - INTERVAL '1 minute' * $1) * 1000)::bigint
        AND status = 'completed'
    `,
    [windowMinutes],
  ).catch(() => []);

  let partialFallbackCount = 0;
  const sourceCounts = new Map();

  for (const row of rows) {
    const meta = row?.metadata || {};
    const inlinePayload = meta.inline_payload || null;
    const payload = inlinePayload && typeof inlinePayload === 'object'
      ? inlinePayload
      : null;
    const errors = Array.isArray(payload?.errors)
      ? payload.errors
      : Array.isArray(inlinePayload?.errors)
        ? inlinePayload.errors
        : [];
    const partialFallback = Boolean(payload?.partialFallback || inlinePayload?.partialFallback || errors.length > 0);
    if (!partialFallback) continue;

    partialFallbackCount += 1;
    for (const err of errors) {
      const source = String(err?.source || 'unknown');
      sourceCounts.set(source, (sourceCounts.get(source) || 0) + 1);
    }
  }

  const sources = [...sourceCounts.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source, 'ko'));

  const warn = partialFallbackCount > 0
    ? [
        `  최근 ${Math.round(windowMinutes / 60)}시간 센티널 부분 폴백 ${partialFallbackCount}건`,
        ...sources.slice(0, 5).map((row) => `  ${row.source}: ${row.count}건`),
      ]
    : [];

  return {
    windowMinutes,
    total: partialFallbackCount,
    okCount: partialFallbackCount === 0 ? 1 : 0,
    warnCount: partialFallbackCount > 0 ? 1 : 0,
    ok: partialFallbackCount === 0 ? ['  최근 센티널 부분 폴백 없음'] : [],
    warn,
    sources,
  };
}

export function loadCryptoValidationBudgetPolicyHealth(
  cryptoValidationBudgetBlockHealth,
  cryptoLiveGateHealth,
  capitalGuardBreakdown,
) {
  const validationRatio = Number(capitalGuardBreakdown?.laneSnapshot?.validationRatio || 0);
  const closedReviews = Number(cryptoLiveGateHealth?.review?.metrics?.closedReviews || 0);
  const weak = Number(cryptoLiveGateHealth?.review?.metrics?.pipeline?.weak || 0);
  const gateDecision = String(cryptoLiveGateHealth?.review?.liveGate?.decision || 'unknown');
  const softCapBlocks = Number(cryptoValidationBudgetBlockHealth?.total || 0);

  let decision = 'hold_current_structure';
  let decisionLabel = '현 구조 유지';
  const reasons = [
    `  soft cap 차단: ${softCapBlocks}건`,
    `  validation capital guard 비중: ${validationRatio}%`,
    `  LIVE gate: ${gateDecision}`,
    `  closed review: ${closedReviews}건 / weak: ${weak}건`,
  ];

  if (softCapBlocks > 0 && gateDecision !== 'blocked' && weak <= 20 && closedReviews >= 3) {
    decision = 'consider_raise_validation_budget';
    decisionLabel = '상향 검토 가능';
    reasons.unshift('  판단: validation daily budget 상향 검토 가능');
  } else if (validationRatio >= 80) {
    decision = 'consider_policy_split';
    decisionLabel = '정책 분리 검토';
    reasons.unshift('  판단: 총량 상향보다 validation 전용 budget 구조 분리 검토 우선');
  } else {
    reasons.unshift('  판단: 현재 값 유지 및 추가 관찰');
  }

  return {
    decision,
    decisionLabel,
    okCount: decision === 'hold_current_structure' ? 1 : 0,
    warnCount: decision !== 'hold_current_structure' ? 1 : 0,
    ok: decision === 'hold_current_structure' ? reasons : [],
    warn: decision !== 'hold_current_structure' ? reasons : [],
  };
}
