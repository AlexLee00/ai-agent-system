// @ts-nocheck
import { JOURNAL_PNL_OUTLIER_THRESHOLD, safeJournalPnlPercent } from './trade-journal-db.ts';
import { parseTradeHoldMs, resolveEffectiveStrategyFamily } from './strategy-family-classifier.ts';

function normalizeMarket(row = {}) {
  const market = String(row.market || '').toLowerCase();
  const exchange = String(row.exchange || '').toLowerCase();
  if (['crypto', 'binance'].includes(market) || exchange.includes('binance')) return 'crypto';
  if (['domestic', 'krx', 'kis_domestic'].includes(market) || exchange.includes('krx')) return 'domestic';
  if (['overseas', 'us', 'kis_overseas'].includes(market) || exchange.includes('kis')) return 'overseas';
  return market || 'unknown';
}

function isClosed(row = {}) {
  return row.status === 'closed' || row.exit_time != null || row.exitTime != null;
}

function createBucket(name) {
  return {
    name,
    total: 0,
    closed: 0,
    wins: 0,
    losses: 0,
    pnlSum: 0,
    pnlCount: 0,
    avgPnlPercent: null,
    winRate: null,
  };
}

function addToBucket(bucket, row, pnlPercent) {
  bucket.total += 1;
  if (!isClosed(row)) return;
  bucket.closed += 1;
  if (pnlPercent == null) return;
  if (pnlPercent > 0) bucket.wins += 1;
  if (pnlPercent < 0) bucket.losses += 1;
  bucket.pnlSum += pnlPercent;
  bucket.pnlCount += 1;
}

function finalizeBucket(bucket) {
  return {
    ...bucket,
    avgPnlPercent: bucket.pnlCount > 0 ? Number((bucket.pnlSum / bucket.pnlCount).toFixed(4)) : null,
    winRate: bucket.pnlCount > 0 ? Number((bucket.wins / bucket.pnlCount).toFixed(4)) : null,
  };
}

function bucketMapToArray(map) {
  return Object.values(map).map(finalizeBucket).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

function getBucket(map, key) {
  const bucketKey = key || 'unknown';
  if (!map[bucketKey]) map[bucketKey] = createBucket(bucketKey);
  return map[bucketKey];
}

function resolvePnl(row = {}) {
  const raw = Number(row.pnl_percent ?? row.pnlPercent);
  const rawFinite = Number.isFinite(raw) ? raw : null;
  const rawOutlier = rawFinite != null && Math.abs(rawFinite) > JOURNAL_PNL_OUTLIER_THRESHOLD;
  const safe = safeJournalPnlPercent({
    entryPrice: row.entry_price ?? row.entryPrice,
    exitPrice: row.exit_price ?? row.exitPrice,
    entryValue: row.entry_value ?? row.entryValue,
    exitValue: row.exit_value ?? row.exitValue,
    direction: row.direction,
    pnlPercent: rawFinite,
  });
  return {
    raw: rawFinite,
    safe,
    rawOutlier,
    corrected: rawOutlier && safe != null,
  };
}

function findBucket(buckets = [], name) {
  return (buckets || []).find((bucket) => bucket.name === name) || null;
}

function buildActions({ summary, strategyFamily, tpSl, marketRegime, earlyExit }) {
  const trendFollowing = findBucket(strategyFamily.buckets, 'trend_following');
  const actions = [
    {
      id: 'stop_loss_required_for_closed_trades',
      status: tpSl.unset.closed > 0 ? 'warning' : 'ok',
      evidence: { closedWithoutTpSl: tpSl.unset.closed },
    },
    {
      id: 'trending_bull_entry_quality_gate',
      status: marketRegime.trendingBullLosses > 0 ? 'watch' : 'ok',
      evidence: { trendingBullLosses: marketRegime.trendingBullLosses },
    },
    {
      id: 'trend_following_quality_review',
      status: trendFollowing?.closed >= 3 && Number(trendFollowing.avgPnlPercent) < 0 ? 'warning' : 'ok',
      evidence: {
        closed: trendFollowing?.closed || 0,
        avgPnlPercent: trendFollowing?.avgPnlPercent ?? null,
        winRate: trendFollowing?.winRate ?? null,
      },
    },
    {
      id: 'early_exit_cluster_review',
      status: earlyExit.total > 0 ? 'watch' : 'ok',
      evidence: earlyExit,
    },
    {
      id: 'strategy_family_required',
      status: strategyFamily.unknownCount > 0 ? 'warning' : 'ok',
      evidence: { unknownCount: strategyFamily.unknownCount, coverage: strategyFamily.coverage },
    },
    {
      id: 'symbol_loss_streak_reflexion',
      status: 'ok',
      evidence: { contract: 'symbol-level loss streak guard is source-backed by reflexion-guard' },
    },
    {
      id: 'pnl_percent_rebuild_and_outlier_guard',
      status: summary.rawPnlOutlierCount > 0 ? 'warning' : 'ok',
      evidence: {
        rawPnlOutlierCount: summary.rawPnlOutlierCount,
        potentiallyCorrectedPnlCount: summary.potentiallyCorrectedPnlCount,
        threshold: JOURNAL_PNL_OUTLIER_THRESHOLD,
      },
    },
    {
      id: 'short_term_strategy_families',
      status: strategyFamily.shortTermCount > 0 ? 'ok' : 'watch',
      evidence: { shortTermCount: strategyFamily.shortTermCount },
    },
    {
      id: 'domestic_trending_bear_block',
      status: 'ok',
      evidence: { contract: 'domestic trending_bear pre-epoch losses are advisory; hard block requires current operating-epoch evidence or explicit override' },
    },
    {
      id: 'autotune_learning_data_expansion',
      status: summary.closed >= 30 ? 'ok' : 'watch',
      evidence: { closedTradeCount: summary.closed, minimumForStableLearning: 30 },
    },
  ];
  return actions;
}

export function buildTradeAnalyticsReport(rows = [], { generatedAt = new Date().toISOString(), includeMarketSegments = true } = {}) {
  const marketBuckets = {};
  const regimeBuckets = {};
  const strategyBuckets = {};
  const symbolBuckets = {};
  const rowsByMarket = {};
  const tpSlBuckets = { set: createBucket('set'), unset: createBucket('unset') };
  let closed = 0;
  let rawPnlOutlierCount = 0;
  let potentiallyCorrectedPnlCount = 0;
  let shortTermCount = 0;
  let horizonAdjustedCount = 0;
  let strategyUnknownCount = 0;
  let trendingBullLosses = 0;
  const earlyExit = {
    total: 0,
    smallProfit: 0,
    losses: 0,
    underOneHour: true,
    samples: [],
  };

  for (const row of rows) {
    const pnl = resolvePnl(row);
    if (isClosed(row)) closed += 1;
    if (pnl.rawOutlier) rawPnlOutlierCount += 1;
    if (pnl.corrected) potentiallyCorrectedPnlCount += 1;

    const market = normalizeMarket(row);
    if (includeMarketSegments) {
      if (!rowsByMarket[market]) rowsByMarket[market] = [];
      rowsByMarket[market].push(row);
    }
    const regime = row.market_regime || row.marketRegime || 'unknown';
    const effectiveFamily = resolveEffectiveStrategyFamily(row);
    const originalStrategyFamily = effectiveFamily.originalFamily;
    const strategyFamily = effectiveFamily.family;
    const symbol = row.symbol || 'unknown';
    if (originalStrategyFamily === 'unknown') strategyUnknownCount += 1;
    if (strategyFamily === 'short_term_scalping' || strategyFamily === 'micro_swing') shortTermCount += 1;
    if (effectiveFamily.horizonAdjusted) horizonAdjustedCount += 1;
    if (regime === 'trending_bull' && pnl.safe != null && pnl.safe < 0) trendingBullLosses += 1;
    const holdMs = parseTradeHoldMs(row);
    if (isClosed(row) && holdMs != null && holdMs < 60 * 60 * 1000) {
      earlyExit.total += 1;
      if (pnl.safe != null && pnl.safe >= 0 && pnl.safe < 1) earlyExit.smallProfit += 1;
      if (pnl.safe != null && pnl.safe < 0) earlyExit.losses += 1;
      if (earlyExit.samples.length < 5) {
        earlyExit.samples.push({
          symbol: row.symbol || 'unknown',
          holdMinutes: Number((holdMs / 60000).toFixed(2)),
          pnlPercent: pnl.safe,
          strategyFamily,
          originalStrategyFamily,
          horizonAdjusted: effectiveFamily.horizonAdjusted,
          marketRegime: regime,
        });
      }
    }

    addToBucket(getBucket(marketBuckets, market), row, pnl.safe);
    addToBucket(getBucket(regimeBuckets, regime), row, pnl.safe);
    addToBucket(getBucket(strategyBuckets, strategyFamily), row, pnl.safe);
    addToBucket(getBucket(symbolBuckets, symbol), row, pnl.safe);
    addToBucket(row.tp_sl_set === true || row.tpSlSet === true ? tpSlBuckets.set : tpSlBuckets.unset, row, pnl.safe);
  }

  const summary = {
    total: rows.length,
    closed,
    open: rows.length - closed,
    rawPnlOutlierCount,
    potentiallyCorrectedPnlCount,
    pnlOutlierThreshold: JOURNAL_PNL_OUTLIER_THRESHOLD,
  };
  const markets = bucketMapToArray(marketBuckets);
  const strategyFamily = {
    coverage: rows.length > 0 ? Number(((rows.length - strategyUnknownCount) / rows.length).toFixed(4)) : 1,
    unknownCount: strategyUnknownCount,
    shortTermCount,
    horizonAdjustedCount,
    buckets: bucketMapToArray(strategyBuckets),
  };
  const tpSl = {
    set: finalizeBucket(tpSlBuckets.set),
    unset: finalizeBucket(tpSlBuckets.unset),
  };
  const marketRegime = {
    trendingBullLosses,
    buckets: bucketMapToArray(regimeBuckets),
  };
  const actions = buildActions({ summary, strategyFamily, tpSl, marketRegime, earlyExit });
  const nextActions = [];
  if (rawPnlOutlierCount > 0) nextActions.push('npx tsx bots/investment/scripts/rebuild-pnl-percent.ts --dry-run, then apply after review');
  if (strategyUnknownCount > 0) nextActions.push('npx tsx bots/investment/scripts/backfill-trade-strategy-family.ts --json, then apply after review');
  if (tpSl.unset.closed > 0) nextActions.push('review closed trades without tp_sl_set=true');
  if (marketRegime.trendingBullLosses > 0) nextActions.push('tighten trending_bull entries with chart/MTF confirmation or route to validation until current-epoch win rate recovers');
  if (findBucket(strategyFamily.buckets, 'trend_following')?.avgPnlPercent < 0) nextActions.push('reduce trend_following live sizing or require pullback/volume evidence before new entries');
  if (earlyExit.total > 0) nextActions.push('review sub-1h exits and keep early small-profit/loss HOLD guard active before closing fresh positions');
  if (summary.closed < 30) nextActions.push('keep autotune in sample-collection mode until at least 30 current-epoch closed trades');

  const report = {
    ok: true,
    status: actions.some((action) => action.status === 'warning') ? 'needs_attention' : 'ready',
    generatedAt,
    summary,
    tpSl,
    markets,
    marketRegime,
    strategyFamily,
    earlyExit,
    symbols: bucketMapToArray(symbolBuckets).slice(0, 20),
    reinforcementActions: actions,
    nextActions,
  };
  if (includeMarketSegments) {
    report.marketSegments = Object.fromEntries(
      Object.entries(rowsByMarket).map(([market, marketRows]) => [
        market,
        buildTradeAnalyticsReport(marketRows, { generatedAt, includeMarketSegments: false }),
      ]),
    );
  }
  return report;
}

export default {
  buildTradeAnalyticsReport,
};
