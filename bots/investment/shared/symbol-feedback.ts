// @ts-nocheck
import * as journalDb from './trade-journal-db.ts';
import { query as dbQuery } from './db/core.ts';
import { getLunaOperatingEpoch } from './luna-operating-epoch.ts';

function numEnv(name, fallback = 0, env = process.env) {
  const value = Number(env?.[name]);
  return Number.isFinite(value) ? value : fallback;
}

function finiteNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function normalizeSymbolFeedbackStats(insight = null, { symbol = null, exchange = null } = {}) {
  const sampleCount = finiteNumber(insight?.closedTrades ?? insight?.sampleCount, 0);
  const winRate = finiteNumber(insight?.winRate, null);
  const avgPnl = finiteNumber(insight?.avgPnlPercent ?? insight?.avgPnl, null);
  return {
    symbol,
    exchange,
    sampleCount,
    closedTrades: sampleCount,
    winRate,
    avgPnl,
    avgPnlPercent: avgPnl,
  };
}

export async function loadSymbolFeedbackStats(symbol, exchange, { days = 90, insightProvider = journalDb.getTradeReviewInsight } = {}) {
  const insight = await insightProvider(symbol, exchange, days);
  return normalizeSymbolFeedbackStats(insight, { symbol, exchange });
}

export async function loadSymbolFeedbackStatsBatch(symbols = [], exchange = 'binance', { days = 90, queryFn = dbQuery } = {}) {
  const normalizedSymbols = [...new Set((symbols || []).map((symbol) => String(symbol || '').trim().toUpperCase()).filter(Boolean))];
  if (normalizedSymbols.length === 0) return new Map();
  const epoch = getLunaOperatingEpoch();
  const historySince = Date.now() - days * 24 * 60 * 60 * 1000;
  const since = epoch.enabled && epoch.valid
    ? Math.max(historySince, Number(epoch.startedAtMs || 0))
    : historySince;
  const rows = await queryFn(
    `SELECT
       j.symbol,
       COUNT(*) AS closed_trades,
       COUNT(*) FILTER (WHERE j.pnl_percent > 0) AS wins,
       ROUND(AVG(j.pnl_percent)::numeric, 4) AS avg_pnl_percent
     FROM trade_journal j
     WHERE j.symbol = ANY($1::text[])
       AND j.exchange = $2
       AND j.status = 'closed'
       AND j.exit_time IS NOT NULL
       AND j.created_at >= $3
       AND COALESCE(j.exclude_from_learning, false) = false
       AND COALESCE(j.quality_flag, 'trusted') <> 'exclude_from_learning'
     GROUP BY j.symbol`,
    [normalizedSymbols, exchange, since],
  );
  return new Map((rows || []).map((row) => {
    const closedTrades = Number(row.closed_trades || 0);
    const wins = Number(row.wins || 0);
    const symbol = String(row.symbol || '').trim().toUpperCase();
    return [symbol, normalizeSymbolFeedbackStats({
      closedTrades,
      sampleCount: closedTrades,
      winRate: closedTrades > 0 ? wins / closedTrades : null,
      avgPnlPercent: row.avg_pnl_percent != null ? Number(row.avg_pnl_percent) : null,
    }, { symbol, exchange })];
  }));
}

export function buildSymbolFeedbackBiasFromStats(stats = null, exchange = 'binance') {
  const notes = [];
  const bias = {};
  const sampleCount = Number(stats?.sampleCount ?? stats?.closedTrades ?? 0);
  if (!stats || sampleCount < 3) return { bias, notes };

  const winRate = finiteNumber(stats.winRate, null);
  const avgPnl = finiteNumber(stats.avgPnl ?? stats.avgPnlPercent, null);
  if (winRate != null && winRate >= 0.62) {
    bias[exchange === 'binance' ? 'momentum_rotation' : 'equity_swing'] = 0.08;
    notes.push(`symbol feedback winRate ${(winRate * 100).toFixed(0)}%`);
  } else if (winRate != null && winRate < 0.38) {
    bias.defensive_rotation = 0.10;
    notes.push(`symbol feedback weak winRate ${(winRate * 100).toFixed(0)}%`);
  }
  if (avgPnl != null && avgPnl < 0) {
    bias.defensive_rotation = (bias.defensive_rotation || 0) + 0.06;
    notes.push(`symbol feedback avgPnl ${avgPnl.toFixed(2)}%`);
  }
  return { bias, notes };
}

export function getWeakFeedbackSymbolThresholds(env = process.env) {
  return {
    minWinRate: numEnv('LUNA_WEAK_SYMBOL_MIN_WINRATE', 0.35, env),
    maxAvgPnl: numEnv('LUNA_WEAK_SYMBOL_MAX_AVGPNL', 0, env),
    minSamples: Math.max(1, Math.floor(numEnv('LUNA_WEAK_SYMBOL_MIN_SAMPLES', 3, env))),
  };
}

export function buildWeakFeedbackSymbolEvidence(symbol, stats = null, env = process.env) {
  const thresholds = getWeakFeedbackSymbolThresholds(env);
  const normalizedStats = normalizeSymbolFeedbackStats(stats, { symbol, exchange: stats?.exchange || null });
  const weak = Boolean(
    normalizedStats.winRate != null
      && normalizedStats.avgPnl != null
      && normalizedStats.sampleCount >= thresholds.minSamples
      && normalizedStats.winRate < thresholds.minWinRate
      && normalizedStats.avgPnl <= thresholds.maxAvgPnl,
  );
  return {
    weak,
    symbol,
    sampleCount: normalizedStats.sampleCount,
    winRate: normalizedStats.winRate,
    avgPnl: normalizedStats.avgPnl,
    thresholds,
  };
}

export function isWeakFeedbackSymbol(symbol, stats = null, env = process.env) {
  return buildWeakFeedbackSymbolEvidence(symbol, stats, env).weak;
}
