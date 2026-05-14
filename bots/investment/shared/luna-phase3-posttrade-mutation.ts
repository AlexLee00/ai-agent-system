// @ts-nocheck

import { query, run } from './db/core.ts';

const DEFAULT_CONFIRM = 'luna-phase3-posttrade-mutation';

function n(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function round(value, digits = 6) {
  return Number(n(value, 0).toFixed(digits));
}

function normalizeMarket(row = {}) {
  const market = String(row.market || '').toLowerCase();
  const exchange = String(row.exchange || '').toLowerCase();
  if (market === 'crypto' || exchange === 'binance') return 'crypto';
  if (market === 'domestic' || exchange === 'kis') return 'domestic';
  if (market === 'overseas' || exchange === 'kis_overseas') return 'overseas';
  return market || 'crypto';
}

function exitTimeToIso(value) {
  if (value == null) return null;
  const raw = Number(value);
  if (!Number.isFinite(raw)) {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  const ms = raw > 10_000_000_000 ? raw : raw * 1000;
  return new Date(ms).toISOString();
}

function resolvePnlPct(row = {}) {
  const direct = n(row.pnl_percent ?? row.pnlPercent, NaN);
  if (Number.isFinite(direct)) return direct;
  const entry = n(row.entry_price ?? row.entryPrice, NaN);
  const exit = n(row.exit_price ?? row.exitPrice, NaN);
  if (!Number.isFinite(entry) || !Number.isFinite(exit) || entry <= 0) return 0;
  const direction = String(row.direction || 'long').toLowerCase();
  const sign = direction === 'short' || direction === 'sell' ? -1 : 1;
  return ((exit - entry) / entry) * 100 * sign;
}

function normalizeTrade(row = {}) {
  const pnlPct = resolvePnlPct(row);
  return {
    id: row.id || row.trade_id || row.tradeId || null,
    tradeId: row.trade_id || row.tradeId || row.id || null,
    symbol: String(row.symbol || '').trim().toUpperCase(),
    market: normalizeMarket(row),
    exchange: row.exchange || (normalizeMarket(row) === 'crypto' ? 'binance' : normalizeMarket(row) === 'domestic' ? 'kis' : 'kis_overseas'),
    strategyFamily: row.strategy_family || row.strategyFamily || row.setup_type || row.setupType || 'unknown',
    pnlPct,
    pnlNet: n(row.pnl_net ?? row.pnl_amount ?? row.pnlNet ?? row.pnlAmount, 0),
    exitReason: row.exit_reason || row.exitReason || null,
    exitAt: exitTimeToIso(row.exit_time ?? row.exitTime ?? row.created_at ?? row.createdAt),
    isPaper: row.is_paper === true || row.isPaper === true || String(row.is_paper).toLowerCase() === 'true',
  };
}

function bucketKey(...parts) {
  return parts.map((part) => String(part || 'unknown')).join('|');
}

function addBucket(map, key, trade) {
  if (!map.has(key)) {
    map.set(key, {
      symbol: trade.symbol,
      market: trade.market,
      exchange: trade.exchange,
      strategyFamily: trade.strategyFamily,
      trades: [],
      losses: [],
    });
  }
  const bucket = map.get(key);
  bucket.trades.push(trade);
  if (trade.pnlPct < 0) bucket.losses.push(trade);
}

function summarizeBucket(bucket) {
  const closedCount = bucket.trades.length;
  const lossCount = bucket.losses.length;
  const pnlValues = bucket.trades.map((trade) => trade.pnlPct);
  const lossValues = bucket.losses.map((trade) => trade.pnlPct);
  const avgPnl = pnlValues.length ? pnlValues.reduce((sum, value) => sum + value, 0) / pnlValues.length : 0;
  const avgLoss = lossValues.length ? lossValues.reduce((sum, value) => sum + value, 0) / lossValues.length : 0;
  const worst = pnlValues.length ? Math.min(...pnlValues) : 0;
  const lastLoss = [...bucket.losses].sort((a, b) => String(b.exitAt || '').localeCompare(String(a.exitAt || '')))[0] || null;
  const severity = Math.min(1, Math.abs(Math.min(avgLoss, worst, 0)) / 5 + Math.min(0.35, lossCount * 0.08));
  return {
    closedCount,
    lossCount,
    avgPnlPct: round(avgPnl, 4),
    avgLossPct: round(avgLoss, 4),
    worstPnlPct: round(worst, 4),
    lastLossAt: lastLoss?.exitAt || null,
    severity: round(severity, 4),
    sourceTradeIds: bucket.losses.map((trade) => trade.tradeId).filter(Boolean),
  };
}

function mutationCandidate({ bucket, summary, mutationType, proposedValue, reason }) {
  return {
    symbol: bucket.symbol,
    market: bucket.market,
    exchange: bucket.exchange,
    strategyFamily: bucket.strategyFamily,
    mutationType,
    proposedValue,
    lossCount: summary.lossCount,
    closedCount: summary.closedCount,
    avgPnlPct: summary.avgPnlPct,
    worstPnlPct: summary.worstPnlPct,
    lastLossAt: summary.lastLossAt,
    severity: summary.severity,
    confidence: round(Math.min(0.95, 0.35 + summary.severity * 0.45 + Math.min(0.15, summary.lossCount * 0.05)), 4),
    status: 'staged',
    requiresMasterConfirm: true,
    confirmToken: DEFAULT_CONFIRM,
    shadowOnly: true,
    sourceTradeIds: summary.sourceTradeIds,
    evidence: {
      phase: 'luna_phase3_codex_p1',
      source: 'posttrade_staged_mutation',
      reason,
      applyRequires: `--apply --confirm=${DEFAULT_CONFIRM}`,
      liveMutation: false,
    },
  };
}

export function buildPosttradeMutationCandidates(trades = [], options = {}) {
  const minLossCount = Math.max(1, Number(options.minLossCount || 1));
  const setupBlockMinLossCount = Math.max(2, Number(options.setupBlockMinLossCount || 2));
  const severeLossPct = -Math.abs(Number(options.severeLossPct || 3));
  const normalized = trades.map(normalizeTrade).filter((trade) => trade.symbol && trade.pnlPct < 0);
  const symbolBuckets = new Map();
  const setupBuckets = new Map();
  for (const trade of normalized) {
    addBucket(symbolBuckets, bucketKey(trade.symbol, trade.market), trade);
    addBucket(setupBuckets, bucketKey(trade.symbol, trade.market, trade.strategyFamily), trade);
  }

  const candidates = [];
  for (const bucket of symbolBuckets.values()) {
    const summary = summarizeBucket(bucket);
    if (summary.lossCount < minLossCount) continue;
    const downweightFactor = Math.max(0.25, 1 - (summary.severity * 0.45 + Math.min(0.20, summary.lossCount * 0.04)));
    candidates.push(mutationCandidate({
      bucket,
      summary,
      mutationType: 'candidate_downweight',
      proposedValue: { candidateScoreMultiplier: round(downweightFactor, 4), ttlHours: 168 },
      reason: `recent_symbol_loss_cluster:${summary.lossCount}`,
    }));
    const sizeMultiplier = Math.max(0.25, 1 - (summary.severity * 0.55 + Math.min(0.25, summary.lossCount * 0.05)));
    candidates.push(mutationCandidate({
      bucket,
      summary,
      mutationType: 'size_multiplier',
      proposedValue: { sizeMultiplier: round(sizeMultiplier, 4), ttlHours: 168 },
      reason: `recent_loss_size_relief:${summary.lossCount}`,
    }));
  }

  for (const bucket of setupBuckets.values()) {
    const summary = summarizeBucket(bucket);
    if (summary.lossCount < setupBlockMinLossCount && summary.worstPnlPct > severeLossPct) continue;
    candidates.push(mutationCandidate({
      bucket,
      summary,
      mutationType: 'setup_block',
      proposedValue: {
        blocked: true,
        setupType: bucket.strategyFamily,
        ttlHours: summary.worstPnlPct <= severeLossPct ? 72 : 168,
      },
      reason: `setup_loss_guard:${bucket.strategyFamily}:${summary.lossCount}`,
    }));
  }

  return candidates.sort((a, b) => b.severity - a.severity || b.lossCount - a.lossCount);
}

export async function ensureLunaPhase3Schema() {
  await run(`
    CREATE TABLE IF NOT EXISTS luna_posttrade_mutation_shadow (
      id                       BIGSERIAL PRIMARY KEY,
      symbol                   TEXT NOT NULL,
      market                   TEXT NOT NULL,
      exchange                 TEXT NOT NULL,
      strategy_family          TEXT,
      mutation_type            TEXT NOT NULL,
      proposed_value           JSONB DEFAULT '{}'::jsonb,
      loss_count               INTEGER DEFAULT 0,
      closed_count             INTEGER DEFAULT 0,
      avg_pnl_pct              DOUBLE PRECISION DEFAULT 0,
      worst_pnl_pct            DOUBLE PRECISION DEFAULT 0,
      last_loss_at             TIMESTAMPTZ,
      severity                 DOUBLE PRECISION DEFAULT 0,
      confidence               DOUBLE PRECISION DEFAULT 0,
      status                   TEXT NOT NULL DEFAULT 'staged',
      requires_master_confirm  BOOLEAN DEFAULT TRUE,
      confirm_token            TEXT,
      shadow_only              BOOLEAN DEFAULT TRUE,
      source_trade_ids         JSONB DEFAULT '[]'::jsonb,
      evidence                 JSONB DEFAULT '{}'::jsonb,
      observed_at              TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_posttrade_mutation_shadow_symbol ON luna_posttrade_mutation_shadow(symbol, market, observed_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_posttrade_mutation_shadow_type ON luna_posttrade_mutation_shadow(mutation_type, status, observed_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_posttrade_mutation_shadow_evidence ON luna_posttrade_mutation_shadow USING GIN (evidence)`);

  await run(`
    CREATE TABLE IF NOT EXISTS luna_deployment_spec_shadow (
      id                         BIGSERIAL PRIMARY KEY,
      spec_hash                  TEXT NOT NULL,
      spec_version               TEXT NOT NULL,
      mode                       TEXT NOT NULL DEFAULT 'paper',
      symbol                     TEXT,
      market                     TEXT,
      exchange                   TEXT,
      decision_spec              JSONB DEFAULT '{}'::jsonb,
      live_backtest_consistent   BOOLEAN DEFAULT FALSE,
      inconsistency_reasons      JSONB DEFAULT '[]'::jsonb,
      shadow_only                BOOLEAN DEFAULT TRUE,
      observed_at                TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_deployment_spec_shadow_hash ON luna_deployment_spec_shadow(spec_hash, observed_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_deployment_spec_shadow_symbol ON luna_deployment_spec_shadow(symbol, market, observed_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_deployment_spec_shadow_consistency ON luna_deployment_spec_shadow(live_backtest_consistent, observed_at DESC)`);
}

export async function loadRecentLossTrades({ days = 14, limit = 200, includePaper = false, market = null } = {}) {
  const params = [Number(days), Number(limit)];
  const paperWhere = includePaper ? '' : 'AND COALESCE(is_paper, false) = false';
  const marketWhere = market ? `AND market = $${params.push(String(market))}` : '';
  return query(`
    SELECT id, trade_id, market, exchange, symbol, is_paper, direction,
           exit_time, exit_price, entry_price, exit_reason,
           pnl_percent, pnl_amount, pnl_net, strategy_family, trade_mode, status
      FROM trade_journal
     WHERE (LOWER(COALESCE(status, '')) = 'closed' OR exit_time IS NOT NULL)
       AND COALESCE(exclude_from_learning, false) = false
       ${paperWhere}
       ${marketWhere}
       AND COALESCE(pnl_percent, pnl_net, pnl_amount, 0) < 0
       AND to_timestamp(COALESCE(exit_time, created_at, 0) / 1000.0) >= NOW() - ($1::int * INTERVAL '1 day')
     ORDER BY COALESCE(exit_time, created_at, 0) DESC
     LIMIT $2
  `, params);
}

export async function insertPosttradeMutationShadow(candidate = {}) {
  await run(`
    INSERT INTO luna_posttrade_mutation_shadow
      (symbol, market, exchange, strategy_family, mutation_type, proposed_value,
       loss_count, closed_count, avg_pnl_pct, worst_pnl_pct, last_loss_at,
       severity, confidence, status, requires_master_confirm, confirm_token,
       shadow_only, source_trade_ids, evidence)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,true,$17::jsonb,$18::jsonb)
  `, [
    candidate.symbol,
    candidate.market,
    candidate.exchange,
    candidate.strategyFamily || null,
    candidate.mutationType,
    JSON.stringify(candidate.proposedValue || {}),
    candidate.lossCount,
    candidate.closedCount,
    candidate.avgPnlPct,
    candidate.worstPnlPct,
    candidate.lastLossAt,
    candidate.severity,
    candidate.confidence,
    candidate.status || 'staged',
    candidate.requiresMasterConfirm !== false,
    candidate.confirmToken || DEFAULT_CONFIRM,
    JSON.stringify(candidate.sourceTradeIds || []),
    JSON.stringify(candidate.evidence || {}),
  ]);
}

export async function insertDeploymentSpecShadow(row = {}) {
  await run(`
    INSERT INTO luna_deployment_spec_shadow
      (spec_hash, spec_version, mode, symbol, market, exchange, decision_spec,
       live_backtest_consistent, inconsistency_reasons, shadow_only)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,true)
  `, [
    row.specHash,
    row.specVersion,
    row.mode || 'paper',
    row.symbol || null,
    row.market || null,
    row.exchange || null,
    JSON.stringify(row.decisionSpec || {}),
    row.liveBacktestConsistent === true,
    JSON.stringify(row.inconsistencyReasons || []),
  ]);
}

export default {
  buildPosttradeMutationCandidates,
  ensureLunaPhase3Schema,
  loadRecentLossTrades,
  insertPosttradeMutationShadow,
  insertDeploymentSpecShadow,
};
