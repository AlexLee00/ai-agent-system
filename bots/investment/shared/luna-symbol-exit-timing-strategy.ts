// @ts-nocheck

const P0 = 'P0';
const P1 = 'P1';
const P2 = 'P2';

const EXIT_POLICY_EFFECTS = {
  peak_reversal_partial_trailing: {
    exitPatience: 'tighten_on_peak_reversal_tags',
    partialProfit: 'prefer_partial_lock',
    trailingStop: 'tighten',
    nonHardLossRecheck: 'standard',
  },
  loss_exit_recheck_before_sell: {
    exitPatience: 'extend_when_recovery_signals_improve',
    partialProfit: 'standard',
    trailingStop: 'standard',
    nonHardLossRecheck: 'required',
  },
  winner_continuation_trailing: {
    exitPatience: 'extend_winner_if_trend_valid',
    partialProfit: 'prefer_partial_take_profit',
    trailingStop: 'loosen_for_continuation',
    nonHardLossRecheck: 'standard',
  },
  entry_downweight_or_probe_only: {
    exitPatience: 'standard',
    partialProfit: 'standard',
    trailingStop: 'standard',
    nonHardLossRecheck: 'standard',
    entryBias: 'downweight_or_probe_only',
  },
  preserve_current_exit_rule: {
    exitPatience: 'preserve',
    partialProfit: 'preserve',
    trailingStop: 'preserve',
    nonHardLossRecheck: 'standard',
  },
  collect_more_samples_with_exit_labels: {
    exitPatience: 'observe',
    partialProfit: 'observe',
    trailingStop: 'observe',
    nonHardLossRecheck: 'standard',
  },
  review_only_excluded_from_learning: {
    exitPatience: 'review_only',
    partialProfit: 'review_only',
    trailingStop: 'review_only',
    nonHardLossRecheck: 'standard',
  },
};

function num(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 4) {
  const parsed = num(value, null);
  if (parsed == null) return null;
  const scale = 10 ** digits;
  return Math.round(parsed * scale) / scale;
}

function pct(from, to) {
  const start = num(from, null);
  const end = num(to, null);
  if (!(start > 0) || end == null) return null;
  return ((end - start) / start) * 100;
}

function mean(values = []) {
  const nums = values.map((value) => num(value, null)).filter((value) => value != null);
  if (!nums.length) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function countBy(rows = [], keyFn) {
  const counts = {};
  for (const row of rows) {
    const key = keyFn(row) || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function normalizePolicyRow(row = {}, generatedAt = null, source = null) {
  const policy = row.recommendedExitPolicy || row.policy || 'collect_more_samples_with_exit_labels';
  return {
    symbolKey: row.symbolKey || `${row.market}:${row.symbol}`,
    market: row.market || null,
    exchange: row.exchange || null,
    symbol: row.symbol || null,
    priority: row.priority || P2,
    policy,
    rationale: row.rationale || null,
    effects: EXIT_POLICY_EFFECTS[policy] || EXIT_POLICY_EFFECTS.collect_more_samples_with_exit_labels,
    learningEligibleTrades: num(row.learningEligibleTrades, 0),
    policyClosed: num(row.policyClosed, 0),
    policyMissedDuringHoldAvgPct: row.policyMissedDuringHoldAvgPct ?? row.missedDuringHoldAvgPct ?? null,
    policyCurrentFromExitAvgPct: row.policyCurrentFromExitAvgPct ?? null,
    policyTimingCategories: row.policyTimingCategories || {},
    topTechnicalTags: row.topTechnicalTags || [],
    generatedAt,
    source,
  };
}

export function normalizeSymbolExitPolicyKey({ market = null, exchange = null, symbol = null } = {}) {
  const normalizedSymbol = String(symbol || '').trim();
  if (!normalizedSymbol) return null;
  const normalizedMarket = String(market || '').trim().toLowerCase()
    || (exchange === 'binance'
      ? 'crypto'
      : exchange === 'kis'
        ? 'domestic'
        : exchange === 'kis_overseas'
          ? 'overseas'
          : '');
  if (!normalizedMarket) return null;
  return `${normalizedMarket}:${normalizedSymbol}`;
}

export function materializeSymbolExitPolicyMatrix(symbolRows = [], {
  generatedAt = new Date().toISOString(),
  source = 'symbol_exit_timing_strategy',
} = {}) {
  const rows = (Array.isArray(symbolRows) ? symbolRows : [])
    .map((row) => normalizePolicyRow(row, generatedAt, source))
    .filter((row) => row.symbolKey && row.symbolKey !== 'null:null');
  const actionableRows = rows.filter((row) => row.priority === P0 || row.priority === P1);
  const bySymbol = Object.fromEntries(rows.map((row) => [row.symbolKey, row]));
  return {
    schemaVersion: 1,
    status: rows.length === 0 ? 'empty' : actionableRows.length > 0 ? 'materialized' : 'observe_only',
    generatedAt,
    source,
    liveTradeImpact: false,
    decisionOwner: 'deterministic_exit_policy',
    symbols: rows.length,
    actionableSymbols: actionableRows.length,
    p0Symbols: rows.filter((row) => row.priority === P0).length,
    p1Symbols: rows.filter((row) => row.priority === P1).length,
    byPolicy: countBy(rows, (row) => row.policy),
    actionableSymbolKeys: actionableRows.map((row) => row.symbolKey),
    bySymbol,
  };
}

export function resolveSymbolExitPolicy(matrixOrReport = null, input = {}) {
  if (!matrixOrReport || typeof matrixOrReport !== 'object') return null;
  const key = normalizeSymbolExitPolicyKey(input);
  if (!key) return null;
  const matrix = matrixOrReport.bySymbol
    ? matrixOrReport
    : matrixOrReport.symbolExitPolicyMatrix
      ? matrixOrReport.symbolExitPolicyMatrix
      : Array.isArray(matrixOrReport.symbolList)
        ? materializeSymbolExitPolicyMatrix(matrixOrReport.symbolList, {
          generatedAt: matrixOrReport.generatedAt || null,
          source: matrixOrReport.source || 'symbol_exit_timing_strategy_report',
        })
        : null;
  return matrix?.bySymbol?.[key] || null;
}

function topObjectEntries(obj = {}, limit = 5) {
  return Object.entries(obj || {})
    .map(([key, count]) => ({ key, count: num(count, 0) }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, limit);
}

function ratio(count, total) {
  const denominator = num(total, 0);
  return denominator > 0 ? round(num(count, 0) / denominator, 4) : 0;
}

function compactTrade(record = {}) {
  const currentFromExitPct = record.closed ? pct(record.exitPrice, record.currentPrice) : null;
  return {
    tradeId: record.tradeId,
    market: record.market,
    exchange: record.exchange,
    symbol: record.symbol,
    status: record.status,
    learningEligible: record.learningEligible,
    strategyFamily: record.strategyFamily,
    marketRegime: record.marketRegime,
    entryDay: record.entryDay,
    entryPrice: record.entryPrice,
    exitDay: record.exitDay,
    exitPrice: record.exitPrice,
    actualPnlPct: record.actualPnlPct,
    currentDate: record.currentDate,
    currentClose: record.currentPrice,
    currentFromEntryPct: record.currentFromEntryPct,
    currentFromExitPct: round(currentFromExitPct),
    bestDuringHoldCloseDate: record.bestDuringHoldCloseDate,
    bestDuringHoldClose: record.bestDuringHoldClose,
    bestDuringHoldClosePnlPct: record.bestDuringHoldClosePnlPct,
    bestToNowCloseDate: record.bestToNowCloseDate,
    bestToNowClose: record.bestToNowClose,
    bestToNowClosePnlPct: record.bestToNowClosePnlPct,
    missedDuringHoldClosePct: record.missedDuringHoldClosePct,
    missedToNowClosePct: record.missedToNowClosePct,
    timingCategory: record.timingCategory,
    bestToNowTags: record.bestToNowTechnical?.tags || [],
    bestToNowReason: record.bestToNowReason,
  };
}

function chooseExitPolicy(row = {}) {
  const closed = num(row.closed, 0);
  const lateRatio = ratio(row.timingCategories?.late_exit_after_peak, closed);
  const earlyRecoveredRatio = ratio(row.timingCategories?.early_loss_exit_recovered_later, closed);
  const profitLeftUpsideRatio = ratio(row.timingCategories?.early_profit_exit_left_upside, closed);
  const nearOptimalRatio = ratio(row.timingCategories?.near_optimal_within_hold, closed);
  const lossNoRecoveryRatio = ratio(row.timingCategories?.loss_exit_no_clear_recovery, closed);
  const missedHold = num(row.missedDuringHoldAvgPct, 0);
  const currentFromExit = num(row.currentFromExitAvgPct, 0);
  const actual = num(row.actualAvgPnlPct, 0);
  const currentFromEntry = num(row.currentFromEntryAvgPct, 0);

  if (closed >= 3 && (lateRatio >= 0.35 || missedHold >= 8)) {
    return {
      priority: P0,
      policy: 'peak_reversal_partial_trailing',
      rationale: 'Best close frequently occurred before the actual sell; lock partial profit and tighten trailing stops when peak/reversal tags rise.',
    };
  }
  if (closed >= 3 && (earlyRecoveredRatio >= 0.2 || (actual < 0 && currentFromExit > 5))) {
    return {
      priority: P1,
      policy: 'loss_exit_recheck_before_sell',
      rationale: 'Several loss exits later recovered; require a technical recheck unless hard stop, safety, or reconciliation rules force exit.',
    };
  }
  if (closed >= 3 && (profitLeftUpsideRatio >= 0.15 || currentFromExit >= 8)) {
    return {
      priority: P1,
      policy: 'winner_continuation_trailing',
      rationale: 'Selling often left upside versus current close; use partial take-profit rather than full exit while trend remains valid.',
    };
  }
  if (closed >= 3 && lossNoRecoveryRatio >= 0.2 && actual < 0 && currentFromEntry < 0) {
    return {
      priority: P1,
      policy: 'entry_downweight_or_probe_only',
      rationale: 'Loss exits did not recover and current close remains below entry; reduce new-entry bias for this symbol.',
    };
  }
  if (closed >= 3 && nearOptimalRatio >= 0.5 && currentFromExit <= 3) {
    return {
      priority: P2,
      policy: 'preserve_current_exit_rule',
      rationale: 'Actual exits were usually near the best hold-window close; preserve current exit logic and monitor.',
    };
  }
  return {
    priority: P2,
    policy: 'collect_more_samples_with_exit_labels',
    rationale: 'Sample or signal is not decisive; keep collecting dual-horizon labels before changing live exit behavior.',
  };
}

function summarizeSymbol(symbolKey, rows = []) {
  const closedRows = rows.filter((row) => row.closed);
  const learningRows = rows.filter((row) => row.learningEligible);
  const policyRows = learningRows.length > 0 ? learningRows : [];
  const policyClosedRows = policyRows.filter((row) => row.closed);
  const policyTimingCategories = countBy(policyRows, (row) => row.timingCategory);
  const latest = [...rows]
    .filter((row) => row.currentPrice != null && row.currentDate)
    .sort((a, b) => String(b.currentDate).localeCompare(String(a.currentDate)))[0] || rows[0] || {};
  const timingCategories = countBy(rows, (row) => row.timingCategory);
  const tags = {};
  for (const row of rows) {
    for (const tag of row.bestToNowTechnical?.tags || []) tags[tag] = (tags[tag] || 0) + 1;
  }

  const policyMetrics = policyRows.length > 0 ? {
    closed: policyClosedRows.length,
    timingCategories: policyTimingCategories,
    actualAvgPnlPct: round(mean(policyClosedRows.map((row) => row.actualPnlPct))),
    currentFromEntryAvgPct: round(mean(policyRows.map((row) => row.currentFromEntryPct))),
    currentFromExitAvgPct: round(mean(policyClosedRows.map((row) => pct(row.exitPrice, row.currentPrice)))),
    missedDuringHoldAvgPct: round(mean(policyRows.map((row) => row.missedDuringHoldClosePct))),
    missedToNowAvgPct: round(mean(policyRows.map((row) => row.missedToNowClosePct))),
  } : null;

  const summary = {
    symbolKey,
    market: latest.market || rows[0]?.market || null,
    exchange: latest.exchange || rows[0]?.exchange || null,
    symbol: latest.symbol || rows[0]?.symbol || null,
    trades: rows.length,
    closed: closedRows.length,
    open: rows.length - closedRows.length,
    learningEligibleTrades: learningRows.length,
    firstEntryDay: rows.map((row) => row.entryDay).filter(Boolean).sort()[0] || null,
    lastExitDay: closedRows.map((row) => row.exitDay).filter(Boolean).sort().at(-1) || null,
    currentDate: latest.currentDate || null,
    currentClose: latest.currentPrice ?? null,
    avgEntryPrice: round(mean(rows.map((row) => row.entryPrice))),
    avgExitPrice: round(mean(closedRows.map((row) => row.exitPrice))),
    actualAvgPnlPct: round(mean(closedRows.map((row) => row.actualPnlPct))),
    winRate: closedRows.length
      ? round(closedRows.filter((row) => num(row.actualPnlPct, 0) > 0).length / closedRows.length, 4)
      : null,
    currentFromEntryAvgPct: round(mean(rows.map((row) => row.currentFromEntryPct))),
    currentFromExitAvgPct: round(mean(closedRows.map((row) => pct(row.exitPrice, row.currentPrice)))),
    bestDuringHoldAvgPct: round(mean(rows.map((row) => row.bestDuringHoldClosePnlPct))),
    bestToNowAvgPct: round(mean(rows.map((row) => row.bestToNowClosePnlPct))),
    missedDuringHoldAvgPct: round(mean(rows.map((row) => row.missedDuringHoldClosePct))),
    missedToNowAvgPct: round(mean(rows.map((row) => row.missedToNowClosePct))),
    timingCategories,
    dominantTimingCategory: Object.keys(timingCategories)[0] || null,
    topTechnicalTags: topObjectEntries(tags, 6),
    policySample: policyRows.length > 0 ? 'learning_eligible' : 'review_only_excluded_or_unlabeled',
    policyClosed: policyMetrics?.closed ?? 0,
    policyCurrentFromExitAvgPct: policyMetrics?.currentFromExitAvgPct ?? null,
    policyMissedDuringHoldAvgPct: policyMetrics?.missedDuringHoldAvgPct ?? null,
    policyTimingCategories: policyMetrics?.timingCategories || {},
  };
  const decision = policyMetrics
    ? chooseExitPolicy({ ...summary, ...policyMetrics })
    : {
      priority: P2,
      policy: 'review_only_excluded_from_learning',
      rationale: 'This symbol has no learning-eligible trade rows; keep it in the full list but do not use it to change exit policy.',
    };
  return {
    ...summary,
    priority: decision.priority,
    recommendedExitPolicy: decision.policy,
    rationale: decision.rationale,
  };
}

function summarizeRows(rows = []) {
  const closed = rows.filter((row) => row.closed);
  return {
    symbols: new Set(rows.map((row) => `${row.market}:${row.symbol}`)).size,
    trades: rows.length,
    closed: closed.length,
    open: rows.length - closed.length,
    learningEligibleTrades: rows.filter((row) => row.learningEligible).length,
    actualAvgPnlPct: round(mean(closed.map((row) => row.actualPnlPct))),
    currentFromEntryAvgPct: round(mean(rows.map((row) => row.currentFromEntryPct))),
    currentFromExitAvgPct: round(mean(closed.map((row) => pct(row.exitPrice, row.currentPrice)))),
    missedDuringHoldAvgPct: round(mean(rows.map((row) => row.missedDuringHoldClosePct))),
    missedToNowAvgPct: round(mean(rows.map((row) => row.missedToNowClosePct))),
    timingCategories: countBy(rows, (row) => row.timingCategory),
  };
}

function buildStrategyActions(symbolRows = []) {
  const byPolicy = countBy(symbolRows, (row) => row.recommendedExitPolicy);
  const p0Symbols = symbolRows.filter((row) => row.priority === P0).slice(0, 15);
  const p1Symbols = symbolRows.filter((row) => row.priority === P1).slice(0, 15);
  return [
    {
      id: 'symbol_exit_policy_matrix',
      priority: p0Symbols.length > 0 ? P0 : P1,
      title: 'Apply symbol-specific exit policy matrix instead of one global sell rule.',
      evidence: { byPolicy, p0Symbols: p0Symbols.map((row) => row.symbolKey), p1Symbols: p1Symbols.map((row) => row.symbolKey) },
      action: 'Feed recommendedExitPolicy into exit patience, partial-profit, trailing-stop, and recheck gates by symbol.',
      liveMutation: false,
    },
    {
      id: 'current_close_post_exit_label',
      priority: P1,
      title: 'Add post-exit current-close drift as a sell-timing label.',
      evidence: {
        soldTooEarlySymbols: symbolRows.filter((row) => num(row.policyCurrentFromExitAvgPct, 0) >= 8).slice(0, 10).map((row) => ({
          symbolKey: row.symbolKey,
          currentFromExitAvgPct: row.policyCurrentFromExitAvgPct,
        })),
      },
      action: 'For each closed trade, train current/5d/10d/20d post-exit drift labels so the model can distinguish protected exits from premature exits.',
      liveMutation: false,
    },
    {
      id: 'peak_tag_exit_trigger',
      priority: P1,
      title: 'Use peak tags as partial-exit triggers, not just posttrade explanations.',
      evidence: {
        commonTags: topObjectEntries(symbolRows.reduce((acc, row) => {
          for (const item of row.topTechnicalTags || []) acc[item.key] = (acc[item.key] || 0) + item.count;
          return acc;
        }, {}), 8),
      },
      action: 'When RSI overbought, upper Bollinger, SMA20 extension, local peak, volume spike, or MACD cooling clusters appear, lock partial gains and tighten trailing.',
      liveMutation: false,
    },
  ];
}

export function buildLunaSymbolExitTimingStrategyReport({
  optimalExitReport = {},
  records = null,
  generatedAt = new Date().toISOString(),
  source = 'optimal_exit_records',
} = {}) {
  const sourceRecords = Array.isArray(records) ? records : optimalExitReport.records;
  const rawRecords = Array.isArray(sourceRecords) ? sourceRecords : [];
  const compactTrades = rawRecords.map(compactTrade);
  const groups = new Map();
  for (const record of rawRecords) {
    const key = `${record.market}:${record.symbol}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  const symbolList = [...groups.entries()]
    .map(([key, rows]) => summarizeSymbol(key, rows))
    .sort((a, b) => {
      const priorityScore = { P0: 0, P1: 1, P2: 2 };
      return (priorityScore[a.priority] ?? 9) - (priorityScore[b.priority] ?? 9)
        || num(b.policyMissedDuringHoldAvgPct ?? b.missedDuringHoldAvgPct, -Infinity) - num(a.policyMissedDuringHoldAvgPct ?? a.missedDuringHoldAvgPct, -Infinity)
        || a.symbolKey.localeCompare(b.symbolKey);
    });
  const summary = summarizeRows(rawRecords);
  const strategyActions = buildStrategyActions(symbolList);
  const p0Count = symbolList.filter((row) => row.priority === P0).length;
  const p1Count = symbolList.filter((row) => row.priority === P1).length;
  const symbolExitPolicyMatrix = materializeSymbolExitPolicyMatrix(symbolList, { generatedAt, source });
  const runtimeGateIntegration = {
    status: symbolExitPolicyMatrix.status === 'materialized'
      ? 'wired_to_runtime_runner_args'
      : 'waiting_for_materialized_matrix',
    deterministicExitPolicy: symbolExitPolicyMatrix.status === 'materialized',
    runnerAgentPlan: symbolExitPolicyMatrix.status === 'materialized',
    partialAdjustRatioBias: symbolExitPolicyMatrix.status === 'materialized',
    strategyExitNonHardLossRecheck: symbolExitPolicyMatrix.status === 'materialized',
  };

  return {
    ok: rawRecords.length > 0,
    status: rawRecords.length === 0 ? 'insufficient_records' : p0Count > 0 ? 'sell_timing_strategy_required' : 'sell_timing_watch',
    generatedAt,
    readOnly: true,
    liveTradeImpact: false,
    source,
    scope: {
      optimalExitStatus: optimalExitReport.status || null,
      optimalExitGeneratedAt: optimalExitReport.generatedAt || null,
      analyzedTrades: rawRecords.length,
      symbols: symbolList.length,
      p0Symbols: p0Count,
      p1Symbols: p1Count,
    },
    summary,
    allSymbols: symbolList.map((row) => row.symbolKey),
    symbolList,
    symbolExitPolicyMatrix,
    runtimeGateIntegration,
    tradeRows: compactTrades,
    topLateExitAfterPeak: symbolList
      .filter((row) => num(row.timingCategories?.late_exit_after_peak, 0) > 0)
      .slice(0, 20),
    topSoldTooEarlyVsCurrentClose: [...symbolList]
      .filter((row) => num(row.policyCurrentFromExitAvgPct, 0) > 0)
      .sort((a, b) => num(b.policyCurrentFromExitAvgPct, -Infinity) - num(a.policyCurrentFromExitAvgPct, -Infinity))
      .slice(0, 20),
    topExitProtectedDownside: [...symbolList]
      .filter((row) => num(row.policyCurrentFromExitAvgPct, 0) < 0)
      .sort((a, b) => num(a.policyCurrentFromExitAvgPct, Infinity) - num(b.policyCurrentFromExitAvgPct, Infinity))
      .slice(0, 20),
    strategyActions,
    nextCommands: [
      'npm --prefix bots/investment run -s runtime:luna-symbol-exit-timing-strategy-report -- --json --no-write',
      'npm --prefix bots/investment run -s runtime:luna-optimal-exit-analysis -- --json --no-write --include-records',
      'npm --prefix bots/investment run -s smoke:luna-symbol-exit-timing-strategy',
    ],
  };
}

export default {
  buildLunaSymbolExitTimingStrategyReport,
  materializeSymbolExitPolicyMatrix,
  normalizeSymbolExitPolicyKey,
  resolveSymbolExitPolicy,
};
