// @ts-nocheck

import { get, query, run } from './db/core.ts';
import { buildLunaDeploymentDecisionSpec } from './luna-deployment-spec.ts';
import {
  DEFAULT_LUNA_WEIGHT_POLICY,
  normalizeLunaWeightPolicy,
} from './luna-autonomous-weight-feedback.ts';

const VALID_MARKETS = new Set(['crypto', 'domestic', 'overseas']);

function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min = 0, max = 1, fallback = 0) {
  return Math.max(min, Math.min(max, finiteNumber(value, fallback)));
}

function round(value, digits = 6) {
  return Number(Number(value || 0).toFixed(digits));
}

function parseJsonMaybe(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function roundWeightMap(weights = {}) {
  return Object.fromEntries(
    Object.entries(weights || {}).map(([key, value]) => [key, round(value, 6)]),
  );
}

export function normalizeLunaPhase2Market(value = '') {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'binance') return 'crypto';
  if (raw === 'kis') return 'domestic';
  if (raw === 'kis_overseas') return 'overseas';
  return VALID_MARKETS.has(raw) ? raw : 'crypto';
}

export function exchangeForLunaPhase2Market(market = 'crypto') {
  const normalized = normalizeLunaPhase2Market(market);
  if (normalized === 'domestic') return 'kis';
  if (normalized === 'overseas') return 'kis_overseas';
  return 'binance';
}

export function normalizeLunaPhase2Symbol(symbol = '') {
  return String(symbol || '').trim().toUpperCase();
}

export async function ensureLunaPhase2Schema() {
  await run(`
    CREATE TABLE IF NOT EXISTS luna_weight_vector_shadow (
      id                  BIGSERIAL PRIMARY KEY,
      symbol              TEXT NOT NULL,
      market              TEXT NOT NULL,
      exchange            TEXT NOT NULL,
      candidate_score     DOUBLE PRECISION DEFAULT 0,
      backtest_score      DOUBLE PRECISION DEFAULT 0,
      predictive_score    DOUBLE PRECISION DEFAULT 0,
      community_score     DOUBLE PRECISION DEFAULT 0,
      target_weight       DOUBLE PRECISION DEFAULT 0,
      confidence          DOUBLE PRECISION DEFAULT 0,
      risk_budget_usdt    DOUBLE PRECISION DEFAULT 0,
      signal              TEXT NOT NULL DEFAULT 'hold',
      gate_status         TEXT NOT NULL DEFAULT 'shadow',
      no_lookahead_ok     BOOLEAN DEFAULT TRUE,
      shadow_only         BOOLEAN DEFAULT TRUE,
      evidence            JSONB DEFAULT '{}'::jsonb,
      observed_at         TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_weight_vector_shadow_symbol ON luna_weight_vector_shadow(symbol, market, observed_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_weight_vector_shadow_signal ON luna_weight_vector_shadow(signal, observed_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_weight_vector_shadow_observed ON luna_weight_vector_shadow(observed_at DESC)`);

  await run(`
    CREATE TABLE IF NOT EXISTS luna_paper_trading_shadow (
      id                   BIGSERIAL PRIMARY KEY,
      symbol               TEXT NOT NULL,
      market               TEXT NOT NULL,
      exchange             TEXT NOT NULL,
      target_weight        DOUBLE PRECISION DEFAULT 0,
      current_weight       DOUBLE PRECISION DEFAULT 0,
      delta_weight         DOUBLE PRECISION DEFAULT 0,
      paper_side           TEXT NOT NULL DEFAULT 'HOLD',
      paper_notional_usdt  DOUBLE PRECISION DEFAULT 0,
      paper_quantity       DOUBLE PRECISION DEFAULT 0,
      reference_price      DOUBLE PRECISION DEFAULT 0,
      confidence           DOUBLE PRECISION DEFAULT 0,
      status               TEXT NOT NULL DEFAULT 'planned',
      shadow_only          BOOLEAN DEFAULT TRUE,
      evidence             JSONB DEFAULT '{}'::jsonb,
      observed_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_paper_trading_shadow_symbol ON luna_paper_trading_shadow(symbol, market, observed_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_paper_trading_shadow_side ON luna_paper_trading_shadow(paper_side, observed_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_paper_trading_shadow_observed ON luna_paper_trading_shadow(observed_at DESC)`);
}

export function evaluateNoLookaheadContract({ asOf = new Date(), sources = [] } = {}) {
  const asOfTime = new Date(asOf).getTime();
  const violations = [];
  for (const source of sources || []) {
    const observedAt = source?.observedAt || source?.observed_at || source?.created_at || source?.createdAt || null;
    if (!observedAt) continue;
    const observedTime = new Date(observedAt).getTime();
    if (Number.isFinite(observedTime) && observedTime > asOfTime + 1000) {
      violations.push({
        source: source?.source || source?.name || 'unknown',
        observedAt: new Date(observedTime).toISOString(),
        asOf: new Date(asOfTime).toISOString(),
      });
    }
  }
  return {
    ok: violations.length === 0,
    violations,
  };
}

function scoreBacktest(backtest = {}) {
  const fresh = backtest?.fresh === true || String(backtest?.fresh).toLowerCase() === 'true';
  const healthy = backtest?.healthy === true || String(backtest?.healthy).toLowerCase() === 'true';
  const wouldBlock = backtest?.would_block === true || backtest?.wouldBlock === true || String(backtest?.would_block).toLowerCase() === 'true';
  if (!fresh || !healthy || wouldBlock) {
    return {
      score: 0,
      pass: false,
      reasons: [
        !fresh ? 'backtest_stale_or_missing' : null,
        !healthy ? 'backtest_unhealthy' : null,
        wouldBlock ? 'backtest_would_block' : null,
      ].filter(Boolean),
    };
  }

  const sharpeScore = clamp((finiteNumber(backtest?.sharpe, 0) + 1) / 3, 0, 1, 0);
  const winRateRaw = finiteNumber(backtest?.win_rate ?? backtest?.winRate, 0);
  const winRateScore = clamp(winRateRaw > 1 ? winRateRaw / 100 : winRateRaw, 0, 1, 0);
  const drawdown = Math.abs(finiteNumber(backtest?.max_drawdown ?? backtest?.maxDrawdown, 30));
  const drawdownScore = clamp(1 - drawdown / 30, 0, 1, 0);
  return {
    score: round(sharpeScore * 0.45 + winRateScore * 0.35 + drawdownScore * 0.20, 4),
    pass: true,
    reasons: [],
  };
}

function scorePredictive(predictive = {}) {
  const decision = String(predictive?.decision || '').toLowerCase();
  const score = clamp(predictive?.score, 0, 1, 0);
  const pass = ['fire', 'pass', 'pass_prediction'].includes(decision);
  return {
    score: pass ? score : round(score * 0.35, 4),
    pass,
    decision: predictive?.decision || null,
  };
}

function scoreCommunity(community = {}) {
  const hasSymbolScore = community?.avg_score != null || community?.score != null;
  const avg = finiteNumber(community?.avg_score ?? community?.score, 0);
  const marketAvg = finiteNumber(community?.market_avg_score ?? community?.marketAvgScore, 0);
  const marketContext = community?.market_avg_score != null || community?.marketAvgScore != null
    ? clamp((marketAvg + 1) / 2, 0, 1, 0.5) - 0.5
    : 0;
  const normalized = hasSymbolScore
    ? clamp((avg + 1) / 2, 0, 1, 0.5)
    : clamp(0.5 + marketContext * 0.35, 0, 1, 0.5);
  const sourceCount = finiteNumber(community?.source_count ?? community?.sourceCount, 0);
  const marketSourceCount = finiteNumber(community?.market_source_count ?? community?.marketSourceCount, 0);
  const diversityBonus = Math.min(0.08, Math.max(0, sourceCount - 1) * 0.025);
  const marketContextBonus = hasSymbolScore ? Math.min(0.025, marketSourceCount * 0.006) : Math.min(0.04, marketSourceCount * 0.008);
  const sourceQuality = clamp(
    community?.avg_source_quality ?? community?.avgSourceQuality ?? community?.market_avg_quality ?? community?.marketAvgQuality,
    0,
    1,
    hasSymbolScore ? 0.45 : 0.35,
  );
  const qualityAdjustment = clamp((sourceQuality - 0.40) * 0.16, -0.06, 0.08, 0);
  const botNoise = clamp(community?.bot_noise_score ?? community?.botNoiseScore, 0, 1, 0);
  const hypeSpike = community?.hype_spike === true || community?.hypeSpike === true;
  const penalty = Math.min(0.20, botNoise * 0.15 + (hypeSpike ? 0.05 : 0));
  return {
    score: round(clamp(normalized + diversityBonus + marketContextBonus + qualityAdjustment - penalty, 0, 1, 0.5), 4),
    sourceCount,
    marketSourceCount,
    sourceQuality,
    marketContextScore: round(marketContext, 4),
    botNoise,
    hypeSpike,
  };
}

export function buildLunaWeightVector(input = {}, config = {}) {
  const candidate = input.candidate || input;
  const symbol = normalizeLunaPhase2Symbol(candidate?.symbol);
  const market = normalizeLunaPhase2Market(candidate?.market || input?.market);
  const exchange = candidate?.exchange || exchangeForLunaPhase2Market(market);
  const asOf = input.asOf || new Date().toISOString();
  const candidateScore = clamp(candidate?.score ?? candidate?.candidate_score, 0, 1, 0.5);
  const backtest = scoreBacktest(input.backtest || candidate?.backtest || {});
  const predictive = scorePredictive(input.predictive || candidate?.predictive || {});
  const community = scoreCommunity(input.community || candidate?.community || {});
  const decisionSpec = buildLunaDeploymentDecisionSpec({
    ...input,
    candidate,
    asOf,
    mode: 'weight-vector-shadow',
    exchange,
  });
  const noLookahead = evaluateNoLookaheadContract({
    asOf,
    sources: [
      { source: 'candidate', observedAt: candidate?.discovered_at || candidate?.discoveredAt },
      { source: 'backtest', observedAt: input.backtest?.last_backtest_at || input.backtest?.lastBacktestAt },
      { source: 'predictive', observedAt: input.predictive?.created_at || input.predictive?.createdAt },
      { source: 'community', observedAt: input.community?.last_seen_at || input.community?.lastSeenAt },
    ],
  });

  const weightFeedback = config?.autonomousWeightFeedback || config?.weightFeedback || null;
  const weights = normalizeLunaWeightPolicy(
    config?.weights || weightFeedback?.weights || DEFAULT_LUNA_WEIGHT_POLICY,
    DEFAULT_LUNA_WEIGHT_POLICY,
  );
  const weightTotal = Object.values(weights).reduce((sum, value) => sum + Math.max(0, value), 0) || 1;
  const confidence = clamp(
    (candidateScore * weights.candidate
      + backtest.score * weights.backtest
      + predictive.score * weights.predictive
      + community.score * weights.community) / weightTotal,
    0,
    1,
    0,
  );

  const maxTargetWeightByMarket = {
    crypto: finiteNumber(config?.maxTargetWeightCrypto, 0.10),
    domestic: finiteNumber(config?.maxTargetWeightDomestic, 0.08),
    overseas: finiteNumber(config?.maxTargetWeightOverseas, 0.08),
  };
  const hardReasons = [
    ...backtest.reasons,
    !predictive.decision ? 'predictive_missing' : null,
    !predictive.pass ? 'predictive_blocked' : null,
    !noLookahead.ok ? 'no_lookahead_violation' : null,
  ].filter(Boolean);
  const eligible = backtest.pass && predictive.pass && Boolean(predictive.decision) && noLookahead.ok;
  const signal = !eligible ? 'hold' : confidence >= 0.72 ? 'increase' : confidence >= 0.55 ? 'watch' : 'hold';
  const cap = maxTargetWeightByMarket[market] ?? 0.08;
  const targetWeight = signal === 'increase'
    ? cap * confidence
    : signal === 'watch'
      ? cap * confidence * 0.35
      : 0;
  const riskBudgetUsdt = finiteNumber(config?.riskBudgetUsdt, 50);

  return {
    ok: true,
    symbol,
    market,
    exchange,
    candidateScore: round(candidateScore, 4),
    backtestScore: round(backtest.score, 4),
    predictiveScore: round(predictive.score, 4),
    communityScore: round(community.score, 4),
    targetWeight: round(targetWeight, 6),
    confidence: round(confidence, 4),
    riskBudgetUsdt: round(riskBudgetUsdt * clamp(confidence, 0, 1, 0), 4),
    signal,
    gateStatus: eligible ? 'shadow_pass' : 'shadow_would_block',
    noLookaheadOk: noLookahead.ok,
    shadowOnly: true,
    evidence: {
      phase: 'luna_phase2_finrlx',
      source: 'weight_vector_shadow',
      decisionSpecVersion: decisionSpec.specVersion,
      decisionSpecHash: decisionSpec.specHash,
      decisionSpec,
      components: {
        candidate: { score: round(candidateScore, 4), raw: candidate },
        backtest: { score: round(backtest.score, 4), pass: backtest.pass, raw: input.backtest || null },
        predictive: { score: round(predictive.score, 4), pass: predictive.pass, decision: predictive.decision, raw: input.predictive || null },
        community: { score: round(community.score, 4), ...community, raw: input.community || null },
      },
      weights: {
        source: weightFeedback?.source || (config?.weights ? 'config_weights' : 'static_default'),
        status: weightFeedback?.status || null,
        applied: roundWeightMap(weights),
        base: roundWeightMap(weightFeedback?.baseWeights || DEFAULT_LUNA_WEIGHT_POLICY),
        deltas: roundWeightMap(weightFeedback?.deltas || {}),
        reasons: weightFeedback?.reasons || [],
        metrics: weightFeedback?.metrics || null,
        shadowOnly: true,
        liveMutation: false,
      },
      noLookahead,
      hardReasons,
      liveMutation: false,
    },
  };
}

export function buildLunaPaperTradingPlan(weightVector = {}, context = {}) {
  const equityUsdt = Math.max(1, finiteNumber(context?.equityUsdt, 1000));
  const maxOrderUsdt = Math.max(0, finiteNumber(context?.maxOrderUsdt, 50));
  const current = context?.position || {};
  const referencePrice = Math.max(0, finiteNumber(current?.avg_price ?? current?.avgPrice ?? context?.referencePrice, 0));
  const currentNotional = Math.max(0, finiteNumber(current?.amount, 0) * referencePrice);
  const currentWeight = clamp(currentNotional / equityUsdt, 0, 1, 0);
  const targetWeight = clamp(weightVector?.targetWeight, 0, 1, 0);
  const deltaWeight = targetWeight - currentWeight;
  const rawNotional = Math.abs(deltaWeight) * equityUsdt;
  const notional = Math.min(rawNotional, maxOrderUsdt || rawNotional);
  const minNotional = finiteNumber(context?.minNotionalUsdt, 5);
  const paperSide = Math.abs(deltaWeight) < 0.001 || notional < minNotional
    ? 'HOLD'
    : deltaWeight > 0
      ? 'BUY'
      : 'SELL';
  const safePrice = referencePrice > 0 ? referencePrice : finiteNumber(context?.fallbackPrice, 1);

  return {
    ok: true,
    symbol: weightVector?.symbol,
    market: normalizeLunaPhase2Market(weightVector?.market),
    exchange: weightVector?.exchange || exchangeForLunaPhase2Market(weightVector?.market),
    targetWeight: round(targetWeight, 6),
    currentWeight: round(currentWeight, 6),
    deltaWeight: round(deltaWeight, 6),
    paperSide,
    paperNotionalUsdt: paperSide === 'HOLD' ? 0 : round(notional, 4),
    paperQuantity: paperSide === 'HOLD' ? 0 : round(notional / Math.max(safePrice, 0.00000001), 8),
    referencePrice: round(safePrice, 8),
    confidence: round(weightVector?.confidence, 4),
    status: paperSide === 'HOLD' ? 'no_action' : 'planned',
    shadowOnly: true,
    evidence: {
      phase: 'luna_phase2_finrlx',
      source: 'paper_trading_shadow',
      decisionSpecVersion: weightVector?.evidence?.decisionSpecVersion || weightVector?.evidence?.decisionSpec?.specVersion || null,
      decisionSpecHash: weightVector?.evidence?.decisionSpecHash || weightVector?.evidence?.decisionSpec?.specHash || null,
      decisionSpec: weightVector?.evidence?.decisionSpec || null,
      weightVector,
      equityUsdt,
      maxOrderUsdt,
      minNotionalUsdt: minNotional,
      liveMutation: false,
    },
  };
}

export async function loadLunaPhase2CandidateInputs({ limit = 50, market = null } = {}) {
  const params = [];
  const marketWhere = market ? `AND market = $${params.push(normalizeLunaPhase2Market(market))}` : '';
  params.push(limit);
  const rows = await query(`
    WITH symbol_community AS (
      SELECT symbol, market,
             (SUM(score * GREATEST(0.05, COALESCE(source_quality, 0.5)) * GREATEST(0.2, COALESCE(freshness_score, 1.0)))
              / NULLIF(SUM(GREATEST(0.05, COALESCE(source_quality, 0.5)) * GREATEST(0.2, COALESCE(freshness_score, 1.0))), 0))::double precision AS avg_score,
             COUNT(DISTINCT source_name)::int AS source_count,
             AVG(source_quality)::double precision AS avg_source_quality,
             MAX(created_at) AS last_seen_at,
             MAX(CASE WHEN COALESCE((raw_ref->'botNoise'->>'score')::double precision, 0) > 0.5 THEN 1 ELSE 0 END)::int AS bot_noise_flag,
             MAX(CASE WHEN COALESCE((raw_ref->'hypeSpike'->>'detected')::boolean, false) THEN 1 ELSE 0 END)::int AS hype_spike_flag
       FROM external_evidence_events
       WHERE source_type = 'community'
         AND created_at >= NOW() - INTERVAL '24 hours'
         AND symbol IS NOT NULL
         AND source_name <> 'community_candidate_gap'
         AND COALESCE((raw_ref->>'missing_data')::boolean, false) = false
       GROUP BY symbol, market
    ),
    market_community AS (
      SELECT market,
             (SUM(score * GREATEST(0.05, COALESCE(source_quality, 0.5)) * GREATEST(0.2, COALESCE(freshness_score, 1.0)))
              / NULLIF(SUM(GREATEST(0.05, COALESCE(source_quality, 0.5)) * GREATEST(0.2, COALESCE(freshness_score, 1.0))), 0))::double precision AS market_avg_score,
             COUNT(DISTINCT source_name)::int AS market_source_count,
             AVG(source_quality)::double precision AS market_avg_quality,
             MAX(created_at) AS market_last_seen_at
       FROM external_evidence_events
       WHERE source_type = 'community'
         AND created_at >= NOW() - INTERVAL '24 hours'
         AND symbol IS NULL
         AND source_name <> 'community_candidate_gap'
         AND COALESCE((raw_ref->>'missing_data')::boolean, false) = false
       GROUP BY market
    ),
    latest_predictive AS (
      SELECT DISTINCT ON (symbol, market)
             symbol, market, decision, score, threshold, component_coverage, created_at
        FROM predictive_validation_log
       WHERE created_at >= NOW() - INTERVAL '7 days'
       ORDER BY symbol, market, created_at DESC
    ),
    active_candidates AS (
      SELECT DISTINCT ON (symbol, market)
             symbol, market, score, source, discovered_at, expires_at, reason, raw_data
        FROM candidate_universe
       WHERE expires_at > NOW()
         ${marketWhere}
       ORDER BY symbol, market, score DESC, discovered_at DESC
    )
    SELECT cu.symbol, cu.market, cu.score::double precision AS candidate_score, cu.source,
           cu.discovered_at, cu.expires_at, cu.reason, cu.raw_data,
           cbs.fresh, cbs.healthy, cbs.sharpe, cbs.max_drawdown, cbs.win_rate,
           cbs.last_backtest_at, cbs.gate_status, cbs.would_block, cbs.block_reasons,
           lp.decision AS predictive_decision, lp.score AS predictive_score,
           lp.threshold AS predictive_threshold, lp.component_coverage, lp.created_at AS predictive_created_at,
           symbol_community.avg_score AS community_avg_score,
           symbol_community.source_count AS community_source_count,
           symbol_community.avg_source_quality AS community_avg_source_quality,
           symbol_community.last_seen_at AS community_last_seen_at,
           symbol_community.bot_noise_flag AS community_bot_noise_flag,
           symbol_community.hype_spike_flag AS community_hype_spike_flag,
           market_community.market_avg_score AS community_market_avg_score,
           market_community.market_source_count AS community_market_source_count,
           market_community.market_avg_quality AS community_market_avg_quality,
           market_community.market_last_seen_at AS community_market_last_seen_at
      FROM active_candidates cu
      LEFT JOIN candidate_backtest_status cbs
        ON cbs.symbol = cu.symbol AND cbs.market = cu.market
      LEFT JOIN latest_predictive lp
        ON lp.symbol = cu.symbol AND lp.market = cu.market
      LEFT JOIN symbol_community
        ON symbol_community.symbol = cu.symbol AND symbol_community.market = cu.market
      LEFT JOIN market_community
        ON market_community.market = cu.market
     ORDER BY cu.score DESC, cu.discovered_at DESC
     LIMIT $${params.length}
  `, params).catch(() => []);

  return rows.map((row) => ({
    candidate: {
      symbol: row.symbol,
      market: row.market,
      score: row.candidate_score,
      source: row.source,
      discovered_at: row.discovered_at,
      expires_at: row.expires_at,
      reason: row.reason,
      raw_data: parseJsonMaybe(row.raw_data, {}),
    },
    backtest: {
      fresh: row.fresh,
      healthy: row.healthy,
      sharpe: row.sharpe,
      max_drawdown: row.max_drawdown,
      win_rate: row.win_rate,
      last_backtest_at: row.last_backtest_at,
      gate_status: row.gate_status,
      would_block: row.would_block,
      block_reasons: parseJsonMaybe(row.block_reasons, []),
    },
    predictive: {
      decision: row.predictive_decision,
      score: row.predictive_score,
      threshold: row.predictive_threshold,
      component_coverage: row.component_coverage,
      created_at: row.predictive_created_at,
    },
    community: {
      avg_score: row.community_avg_score,
      source_count: row.community_source_count,
      avg_source_quality: row.community_avg_source_quality,
      last_seen_at: row.community_last_seen_at,
      market_avg_score: row.community_market_avg_score,
      market_source_count: row.community_market_source_count,
      market_avg_quality: row.community_market_avg_quality,
      market_last_seen_at: row.community_market_last_seen_at,
      bot_noise_score: row.community_bot_noise_flag ? 0.6 : 0,
      hype_spike: row.community_hype_spike_flag === 1,
    },
  }));
}

export async function insertLunaWeightVectorShadow(row = {}) {
  await run(`
    INSERT INTO luna_weight_vector_shadow
      (symbol, market, exchange, candidate_score, backtest_score, predictive_score,
       community_score, target_weight, confidence, risk_budget_usdt, signal,
       gate_status, no_lookahead_ok, shadow_only, evidence)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,$14::jsonb)
  `, [
    row.symbol,
    row.market,
    row.exchange,
    row.candidateScore,
    row.backtestScore,
    row.predictiveScore,
    row.communityScore,
    row.targetWeight,
    row.confidence,
    row.riskBudgetUsdt,
    row.signal,
    row.gateStatus,
    row.noLookaheadOk,
    JSON.stringify(row.evidence || {}),
  ]);
}

export async function loadLatestLunaWeightVectors({ limit = 50, hours = 24, market = null } = {}) {
  const params = [Number(hours), Number(limit)];
  const marketWhere = market ? `AND market = $${params.push(normalizeLunaPhase2Market(market))}` : '';
  return query(`
    SELECT DISTINCT ON (symbol, market)
           symbol, market, exchange, target_weight, confidence, signal, evidence, observed_at
      FROM luna_weight_vector_shadow
     WHERE observed_at >= NOW() - ($1::int * INTERVAL '1 hour')
       AND shadow_only = true
       ${marketWhere}
     ORDER BY symbol, market, observed_at DESC
     LIMIT $2
  `, params).catch(() => []);
}

export async function loadCurrentPositionForWeightVector(row = {}) {
  const symbol = normalizeLunaPhase2Symbol(row.symbol);
  const exchange = row.exchange || exchangeForLunaPhase2Market(row.market);
  return get(
    `SELECT symbol, amount, avg_price, unrealized_pnl, paper, exchange, trade_mode, updated_at
       FROM positions
      WHERE symbol = $1 AND exchange = $2 AND paper = false
      ORDER BY updated_at DESC
      LIMIT 1`,
    [symbol, exchange],
  ).catch(() => null);
}

export async function insertLunaPaperTradingShadow(row = {}) {
  await run(`
    INSERT INTO luna_paper_trading_shadow
      (symbol, market, exchange, target_weight, current_weight, delta_weight,
       paper_side, paper_notional_usdt, paper_quantity, reference_price,
       confidence, status, shadow_only, evidence)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,$13::jsonb)
  `, [
    row.symbol,
    row.market,
    row.exchange,
    row.targetWeight,
    row.currentWeight,
    row.deltaWeight,
    row.paperSide,
    row.paperNotionalUsdt,
    row.paperQuantity,
    row.referencePrice,
    row.confidence,
    row.status,
    JSON.stringify(row.evidence || {}),
  ]);
}
