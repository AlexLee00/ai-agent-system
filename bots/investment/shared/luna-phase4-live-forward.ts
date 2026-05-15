// @ts-nocheck

import { query, run } from './db/core.ts';
import {
  exchangeForLunaPhase2Market,
  loadLunaPhase2CandidateInputs,
  normalizeLunaPhase2Market,
  normalizeLunaPhase2Symbol,
} from './luna-weight-vector.ts';

export const LUNA_PHASE4_LIVE_FORWARD_MODEL = 'ama_finsaber_shadow_v1';
export const LUNA_PHASE4_STRATEGY_MODEL = 'hyperopt_risk_indicator_shadow_v1';

function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min = 0, max = 1, fallback = 0) {
  return Math.max(min, Math.min(max, finiteNumber(value, fallback)));
}

function round(value, digits = 6) {
  return Number(finiteNumber(value, 0).toFixed(digits));
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

function bool(value) {
  return value === true || String(value).toLowerCase() === 'true';
}

function avg(values = []) {
  const nums = values.map((value) => finiteNumber(value, NaN)).filter((value) => Number.isFinite(value));
  return nums.length ? nums.reduce((sum, value) => sum + value, 0) / nums.length : 0;
}

function stddev(values = []) {
  const nums = values.map((value) => finiteNumber(value, NaN)).filter((value) => Number.isFinite(value));
  if (nums.length < 2) return 0;
  const mean = avg(nums);
  return Math.sqrt(nums.reduce((sum, value) => sum + (value - mean) ** 2, 0) / nums.length);
}

function normalizeWinRate(value) {
  const raw = finiteNumber(value, 0);
  return raw > 1 ? clamp(raw / 100, 0, 1, 0) : clamp(raw, 0, 1, 0);
}

function normalizeDrawdown(value) {
  return Math.abs(finiteNumber(value, 30));
}

function scoreBacktest(backtest = {}) {
  const fresh = bool(backtest.fresh);
  const healthy = bool(backtest.healthy);
  const wouldBlock = bool(backtest.would_block ?? backtest.wouldBlock);
  const sharpe = finiteNumber(backtest.sharpe, 0);
  const drawdown = normalizeDrawdown(backtest.max_drawdown ?? backtest.maxDrawdown);
  const winRate = normalizeWinRate(backtest.win_rate ?? backtest.winRate);
  const score = fresh && healthy && !wouldBlock
    ? clamp(((sharpe + 1) / 3) * 0.45 + winRate * 0.35 + (1 - drawdown / 30) * 0.20, 0, 1, 0)
    : 0;
  return { fresh, healthy, wouldBlock, sharpe, drawdown, winRate, score: round(score, 4) };
}

function scorePredictive(predictive = {}) {
  const decision = String(predictive.decision || '').toLowerCase();
  const pass = ['fire', 'pass', 'pass_prediction', 'shadow_pass'].includes(decision);
  const score = clamp(predictive.score, 0, 1, 0);
  const coverage = clamp(predictive.component_coverage ?? predictive.componentCoverage, 0, 1, 0);
  return { decision, pass, score: pass ? round(score, 4) : round(score * 0.35, 4), coverage };
}

function scoreCommunity(community = {}) {
  const raw = finiteNumber(community.avg_score ?? community.avgScore ?? community.score, 0);
  const sourceCount = Math.max(0, Math.floor(finiteNumber(community.source_count ?? community.sourceCount, 0)));
  const botNoise = clamp(community.bot_noise_score ?? community.botNoiseScore, 0, 1, 0);
  const hypeSpike = bool(community.hype_spike ?? community.hypeSpike);
  const diversityBonus = Math.min(0.10, Math.max(0, sourceCount - 1) * 0.025);
  const score = clamp((raw + 1) / 2 + diversityBonus - botNoise * 0.12 - (hypeSpike ? 0.05 : 0), 0, 1, 0.5);
  return { raw, sourceCount, botNoise, hypeSpike, score: round(score, 4) };
}

function scoreConsistency(row = {}) {
  const evidence = row.weightVector?.evidence || row.paperPlan?.evidence || {};
  const noLookahead = evidence.noLookahead?.ok !== false;
  const decisionSpecHash = evidence.decisionSpecHash || evidence.decisionSpec?.specHash || null;
  const liveMutation = evidence.liveMutation === true || row.liveMutation === true;
  return {
    score: noLookahead && decisionSpecHash && !liveMutation ? 1 : noLookahead && !liveMutation ? 0.7 : 0,
    noLookahead,
    decisionSpecHash,
    liveMutation,
  };
}

function requiresCommunityDiversity(candidate = {}, market = 'crypto') {
  const normalizedMarket = normalizeLunaPhase2Market(market);
  const source = String(candidate.source || '').toLowerCase();
  const strategy = String(candidate.strategy_family || candidate.strategyFamily || candidate.raw_data?.strategyFamily || '').toLowerCase();
  const communityDriven = [
    'community',
    'reddit',
    'apewisdom',
    'coingecko_trending',
    'social',
    'hype',
    'meme',
  ].some((needle) => source.includes(needle) || strategy.includes(needle));
  if (normalizedMarket === 'crypto') return communityDriven;
  return communityDriven;
}

export function buildLunaPhase4LiveForwardRows(inputs = [], options = {}) {
  return inputs.map((input) => {
    const candidate = input.candidate || input;
    const symbol = normalizeLunaPhase2Symbol(candidate.symbol || input.symbol);
    const market = normalizeLunaPhase2Market(candidate.market || input.market);
    const exchange = candidate.exchange || input.exchange || exchangeForLunaPhase2Market(market);
    const backtest = scoreBacktest(input.backtest || candidate.backtest || {});
    const predictive = scorePredictive(input.predictive || candidate.predictive || {});
    const community = scoreCommunity(input.community || candidate.community || {});
    const consistency = scoreConsistency(input);
    const regimeRiskScore = clamp(
      backtest.drawdown / 35
        + (backtest.sharpe < 0 ? 0.20 : 0)
        + (predictive.coverage < 0.75 ? 0.18 : 0)
        + community.botNoise * 0.12
        + (community.hypeSpike ? 0.08 : 0),
      0,
      1,
      0,
    );
    const amaScore = clamp(
      backtest.score * 0.38
        + predictive.score * 0.27
        + community.score * 0.15
        + consistency.score * 0.12
        + (1 - regimeRiskScore) * 0.08,
      0,
      1,
      0,
    );
    const finsaberScore = clamp(
      community.score * 0.35
        + backtest.score * 0.30
        + predictive.score * 0.20
        + consistency.score * 0.10
        + Math.min(0.05, community.sourceCount * 0.01),
      0,
      1,
      0,
    );
    const communityDiversityRequired = requiresCommunityDiversity(candidate, market);
    const reasons = [
      !backtest.fresh ? 'backtest_not_fresh' : null,
      !backtest.healthy ? 'backtest_not_healthy' : null,
      backtest.wouldBlock ? 'backtest_would_block' : null,
      backtest.sharpe < 0 ? 'negative_sharpe' : null,
      backtest.drawdown > 20 ? 'drawdown_gt_20pct' : null,
      predictive.coverage < 0.75 ? 'predictive_coverage_lt_0_75' : null,
      !predictive.pass ? 'predictive_not_pass' : null,
      communityDiversityRequired && community.sourceCount < 2 ? 'community_source_diversity_low' : null,
      regimeRiskScore > 0.45 ? 'regime_risk_high' : null,
      !consistency.noLookahead ? 'no_lookahead_violation' : null,
      consistency.liveMutation ? 'live_mutation_detected' : null,
    ].filter(Boolean);
    const pass = reasons.length === 0 && amaScore >= 0.65 && finsaberScore >= 0.60;
    const needsHyperopt = backtest.sharpe < 0.5 || backtest.drawdown > 12 || amaScore < 0.65 || finsaberScore < 0.60;
    return {
      symbol,
      market,
      exchange,
      strategyFamily: candidate.strategy_family || candidate.strategyFamily || candidate.raw_data?.strategyFamily || 'composite',
      validationModel: LUNA_PHASE4_LIVE_FORWARD_MODEL,
      liveForwardStatus: pass ? 'shadow_pass' : 'shadow_hold',
      recommendation: pass ? 'eligible_for_paper_promotion_review' : 'keep_shadow',
      amaScore: round(amaScore, 4),
      finsaberScore: round(finsaberScore, 4),
      regimeRiskScore: round(regimeRiskScore, 4),
      backtestFresh: backtest.fresh,
      predictiveCoverage: round(predictive.coverage, 4),
      communitySourceCount: community.sourceCount,
      maxDrawdownPct: round(backtest.drawdown, 4),
      hyperoptRequired: needsHyperopt,
      liveMutation: false,
      shadowOnly: true,
      reasons,
      evidence: {
        phase: 'luna_phase4_codex_p2',
        source: 'live_forward_validation_shadow',
        task: 'ama_finsaber_live_forward',
        llmGateway: {
          route: 'hub',
          status: options.llmEnabled ? 'optional_shadow_ready' : 'skipped_by_default',
          directProviderCall: false,
        },
        components: { candidate, backtest, predictive, community, consistency },
        thresholds: {
          amaScore: 0.65,
          finsaberScore: 0.60,
          predictiveCoverage: 0.75,
          maxDrawdownPct: 20,
          communityDiversityRequired,
          communitySourceCount: communityDiversityRequired ? 2 : 0,
        },
        liveMutation: false,
      },
    };
  });
}

function simpleMa(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  return avg(values.slice(-period));
}

function calcIndicatorSnapshot(rows = []) {
  const closes = rows.map((row) => finiteNumber(Array.isArray(row) ? row[4] : row.close, NaN)).filter(Number.isFinite);
  if (closes.length < 30) {
    return {
      ok: false,
      providerStatus: rows.length > 0 ? 'insufficient_ohlcv' : 'missing_ohlcv',
      indicatorScore: 0,
      macdHistogram: 0,
      bollingerPosition: 0.5,
      maxDrawdownPct: 0,
    };
  }
  const ma12 = simpleMa(closes, 12);
  const ma26 = simpleMa(closes, 26);
  const macdHistogram = finiteNumber(ma12 - ma26, 0) / Math.max(Math.abs(ma26), 0.00000001);
  const bbWindow = closes.slice(-20);
  const mid = avg(bbWindow);
  const sd = stddev(bbWindow);
  const upper = mid + sd * 2;
  const lower = mid - sd * 2;
  const last = closes[closes.length - 1];
  const bollingerPosition = clamp((last - lower) / Math.max(upper - lower, 0.00000001), 0, 1, 0.5);
  let peak = closes[0];
  let maxDrawdown = 0;
  for (const close of closes) {
    peak = Math.max(peak, close);
    maxDrawdown = Math.max(maxDrawdown, ((peak - close) / Math.max(peak, 0.00000001)) * 100);
  }
  const macdScore = clamp((macdHistogram + 0.03) / 0.06, 0, 1, 0.5);
  const bbScore = bollingerPosition < 0.2 ? 0.35 : bollingerPosition > 0.85 ? 0.25 : 0.65;
  const drawdownScore = clamp(1 - maxDrawdown / 25, 0, 1, 0);
  return {
    ok: true,
    providerStatus: 'ready',
    indicatorScore: round(macdScore * 0.40 + bbScore * 0.30 + drawdownScore * 0.30, 4),
    macdHistogram: round(macdHistogram, 6),
    bollingerPosition: round(bollingerPosition, 4),
    maxDrawdownPct: round(maxDrawdown, 4),
    closeCount: closes.length,
  };
}

export function buildLunaPhase4StrategyEnhancementRows(inputs = [], ohlcvByKey = {}) {
  return inputs.map((input) => {
    const candidate = input.candidate || input;
    const symbol = normalizeLunaPhase2Symbol(candidate.symbol || input.symbol);
    const market = normalizeLunaPhase2Market(candidate.market || input.market);
    const exchange = candidate.exchange || input.exchange || exchangeForLunaPhase2Market(market);
    const backtest = scoreBacktest(input.backtest || candidate.backtest || {});
    const key = `${symbol}|${market}`;
    const indicators = calcIndicatorSnapshot(ohlcvByKey[key] || input.ohlcv || []);
    const effectiveDrawdown = Math.max(backtest.drawdown, indicators.maxDrawdownPct || 0);
    const maxDrawdownGuard = effectiveDrawdown > 20 ? 'block_live_forward' : effectiveDrawdown > 12 ? 'tighten_risk' : 'observe';
    const hyperoptRequired = backtest.sharpe < 0.5 || effectiveDrawdown > 12 || indicators.indicatorScore < 0.45;
    const bestParams = {
      rsiOversold: indicators.bollingerPosition < 0.25 ? 32 : 28,
      macdHistogramMin: indicators.macdHistogram > 0 ? 0 : 0.001,
      bollingerPositionMax: effectiveDrawdown > 20 ? 0.65 : 0.80,
      stopLossPct: effectiveDrawdown > 20 ? -1.25 : effectiveDrawdown > 12 ? -1.75 : -2.0,
      maxDrawdownPct: effectiveDrawdown > 20 ? 12 : 20,
      paperOnlyDays: 7,
    };
    const reasons = [
      hyperoptRequired ? 'hyperopt_required' : null,
      backtest.sharpe < 0 ? 'negative_sharpe' : null,
      effectiveDrawdown > 20 ? 'max_drawdown_gt_20pct' : null,
      !indicators.ok ? indicators.providerStatus : null,
      indicators.indicatorScore < 0.45 ? 'indicator_score_weak' : null,
    ].filter(Boolean);
    return {
      symbol,
      market,
      exchange,
      enhancementModel: LUNA_PHASE4_STRATEGY_MODEL,
      enhancementStatus: reasons.length ? 'shadow_review' : 'shadow_ready',
      hyperoptStatus: hyperoptRequired ? 'planned' : 'not_required',
      bestParams,
      maxDrawdownGuard,
      indicatorScore: round(indicators.indicatorScore, 4),
      providerStatus: indicators.providerStatus,
      liveMutation: false,
      shadowOnly: true,
      reasons,
      evidence: {
        phase: 'luna_phase4_codex_p2',
        source: 'strategy_enhancement_shadow',
        task: 'hyperopt_maxdrawdown_macd_bollinger_yfinance',
        backtest,
        indicators,
        yfinance: {
          status: indicators.providerStatus === 'missing_ohlcv' ? 'available_as_fallback_not_called' : 'cache_or_fixture_used',
          directExternalFetch: false,
        },
        liveMutation: false,
      },
    };
  });
}

export async function ensureLunaPhase4Schema() {
  await run(`
    CREATE TABLE IF NOT EXISTS luna_phase4_live_forward_shadow (
      id                         BIGSERIAL PRIMARY KEY,
      symbol                     TEXT NOT NULL,
      market                     TEXT NOT NULL,
      exchange                   TEXT NOT NULL,
      strategy_family            TEXT,
      validation_model           TEXT NOT NULL DEFAULT 'ama_finsaber_shadow_v1',
      live_forward_status        TEXT NOT NULL DEFAULT 'shadow_hold',
      recommendation             TEXT NOT NULL DEFAULT 'keep_shadow',
      ama_score                  DOUBLE PRECISION DEFAULT 0,
      finsaber_score             DOUBLE PRECISION DEFAULT 0,
      regime_risk_score          DOUBLE PRECISION DEFAULT 0,
      backtest_fresh             BOOLEAN DEFAULT FALSE,
      predictive_coverage        DOUBLE PRECISION DEFAULT 0,
      community_source_count     INTEGER DEFAULT 0,
      max_drawdown_pct           DOUBLE PRECISION DEFAULT 0,
      hyperopt_required          BOOLEAN DEFAULT FALSE,
      live_mutation              BOOLEAN DEFAULT FALSE,
      shadow_only                BOOLEAN DEFAULT TRUE,
      reasons                    JSONB DEFAULT '[]'::jsonb,
      evidence                   JSONB DEFAULT '{}'::jsonb,
      observed_at                TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_phase4_live_forward_symbol ON luna_phase4_live_forward_shadow(symbol, market, observed_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_phase4_live_forward_status ON luna_phase4_live_forward_shadow(live_forward_status, observed_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_phase4_live_forward_evidence ON luna_phase4_live_forward_shadow USING GIN (evidence)`);

  await run(`
    CREATE TABLE IF NOT EXISTS luna_phase4_strategy_enhancement_shadow (
      id                         BIGSERIAL PRIMARY KEY,
      symbol                     TEXT NOT NULL,
      market                     TEXT NOT NULL,
      exchange                   TEXT NOT NULL,
      enhancement_model          TEXT NOT NULL DEFAULT 'hyperopt_risk_indicator_shadow_v1',
      enhancement_status         TEXT NOT NULL DEFAULT 'shadow_review',
      hyperopt_status            TEXT NOT NULL DEFAULT 'planned',
      best_params                JSONB DEFAULT '{}'::jsonb,
      max_drawdown_guard         TEXT NOT NULL DEFAULT 'observe',
      indicator_score            DOUBLE PRECISION DEFAULT 0,
      provider_status            TEXT NOT NULL DEFAULT 'shadow',
      live_mutation              BOOLEAN DEFAULT FALSE,
      shadow_only                BOOLEAN DEFAULT TRUE,
      reasons                    JSONB DEFAULT '[]'::jsonb,
      evidence                   JSONB DEFAULT '{}'::jsonb,
      observed_at                TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_phase4_strategy_symbol ON luna_phase4_strategy_enhancement_shadow(symbol, market, observed_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_phase4_strategy_status ON luna_phase4_strategy_enhancement_shadow(enhancement_status, observed_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_phase4_strategy_evidence ON luna_phase4_strategy_enhancement_shadow USING GIN (evidence)`);
}

export async function insertLunaPhase4LiveForwardShadow(row = {}) {
  await run(`
    INSERT INTO luna_phase4_live_forward_shadow
      (symbol, market, exchange, strategy_family, validation_model, live_forward_status,
       recommendation, ama_score, finsaber_score, regime_risk_score, backtest_fresh,
       predictive_coverage, community_source_count, max_drawdown_pct, hyperopt_required,
       live_mutation, shadow_only, reasons, evidence)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,false,true,$16::jsonb,$17::jsonb)
  `, [
    row.symbol,
    row.market,
    row.exchange,
    row.strategyFamily || null,
    row.validationModel || LUNA_PHASE4_LIVE_FORWARD_MODEL,
    row.liveForwardStatus,
    row.recommendation,
    row.amaScore,
    row.finsaberScore,
    row.regimeRiskScore,
    row.backtestFresh === true,
    row.predictiveCoverage,
    row.communitySourceCount,
    row.maxDrawdownPct,
    row.hyperoptRequired === true,
    JSON.stringify(row.reasons || []),
    JSON.stringify(row.evidence || {}),
  ]);
}

export async function insertLunaPhase4StrategyEnhancementShadow(row = {}) {
  await run(`
    INSERT INTO luna_phase4_strategy_enhancement_shadow
      (symbol, market, exchange, enhancement_model, enhancement_status, hyperopt_status,
       best_params, max_drawdown_guard, indicator_score, provider_status,
       live_mutation, shadow_only, reasons, evidence)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,false,true,$11::jsonb,$12::jsonb)
  `, [
    row.symbol,
    row.market,
    row.exchange,
    row.enhancementModel || LUNA_PHASE4_STRATEGY_MODEL,
    row.enhancementStatus,
    row.hyperoptStatus,
    JSON.stringify(row.bestParams || {}),
    row.maxDrawdownGuard,
    row.indicatorScore,
    row.providerStatus,
    JSON.stringify(row.reasons || []),
    JSON.stringify(row.evidence || {}),
  ]);
}

export async function loadLunaPhase4Inputs({ limit = 50, market = null } = {}) {
  return loadLunaPhase2CandidateInputs({ limit, market });
}

export async function loadCachedPhase4Ohlcv({ inputs = [], timeframe = '1h', limit = 80 } = {}) {
  if (!Array.isArray(inputs) || inputs.length === 0) return {};
  const out = {};
  for (const input of inputs) {
    const candidate = input.candidate || input;
    const symbol = normalizeLunaPhase2Symbol(candidate.symbol || input.symbol);
    const market = normalizeLunaPhase2Market(candidate.market || input.market);
    const exchange = candidate.exchange || input.exchange || exchangeForLunaPhase2Market(market);
    const rows = await query(`
      SELECT candle_ts, open, high, low, close, volume
        FROM (
          SELECT DISTINCT ON (candle_ts)
                 candle_ts, open, high, low, close, volume,
                 CASE WHEN exchange = $4 THEN 0 ELSE 1 END AS exchange_priority
            FROM ohlcv_cache
           WHERE symbol = $1
             AND timeframe = $2
             AND exchange = ANY($3::text[])
           ORDER BY candle_ts, exchange_priority
        ) deduped
       ORDER BY candle_ts DESC
       LIMIT $5
    `, [
      symbol,
      timeframe,
      exchange === 'binance' ? [exchange] : [exchange, 'yfinance'],
      exchange,
      Math.max(30, Number(limit || 80)),
    ]).catch(() => []);
    out[`${symbol}|${market}`] = rows.reverse();
  }
  return out;
}

export function fixturePhase4Inputs() {
  const now = '2026-05-15T00:00:00.000Z';
  return [
    {
      candidate: { symbol: 'BTC/USDT', market: 'crypto', score: 0.82, source: 'fixture', discovered_at: now, raw_data: { strategyFamily: 'momentum_rotation' } },
      backtest: { fresh: true, healthy: true, sharpe: 1.18, max_drawdown: 8.4, win_rate: 58, last_backtest_at: now, would_block: false },
      predictive: { decision: 'pass_prediction', score: 0.78, component_coverage: 0.83, created_at: now },
      community: { avg_score: 0.28, source_count: 4, last_seen_at: now, bot_noise_score: 0.05, hype_spike: false },
      ohlcv: Array.from({ length: 60 }, (_, i) => {
        const close = 65000 + i * 55 + Math.sin(i / 3) * 120;
        return { close, high: close * 1.003, low: close * 0.997, open: close * 0.999, volume: 100 + i };
      }),
    },
    {
      candidate: { symbol: 'DOGE/USDT', market: 'crypto', score: 0.61, source: 'fixture', discovered_at: now, raw_data: { strategyFamily: 'hype_reversal' } },
      backtest: { fresh: true, healthy: false, sharpe: -0.32, max_drawdown: 24.5, win_rate: 31, last_backtest_at: now, would_block: true },
      predictive: { decision: 'hold', score: 0.42, component_coverage: 0.62, created_at: now },
      community: { avg_score: 0.71, source_count: 1, last_seen_at: now, bot_noise_score: 0.62, hype_spike: true },
      ohlcv: Array.from({ length: 60 }, (_, i) => {
        const close = 0.18 - i * 0.0009 + Math.sin(i / 2) * 0.003;
        return { close, high: close * 1.02, low: close * 0.98, open: close * 1.001, volume: 1000 + i };
      }),
    },
    {
      candidate: { symbol: 'BNB/USDT', market: 'crypto', score: 0.80, source: 'pre_market_screen', discovered_at: now, raw_data: { strategyFamily: 'momentum_rotation' } },
      backtest: { fresh: true, healthy: true, sharpe: 1.22, max_drawdown: 7.5, win_rate: 57, last_backtest_at: now, would_block: false },
      predictive: { decision: 'fire', score: 0.80, component_coverage: 0.80, created_at: now },
      community: { avg_score: null, source_count: 0, last_seen_at: null, bot_noise_score: 0, hype_spike: false },
      ohlcv: Array.from({ length: 60 }, (_, i) => {
        const close = 620 + i * 0.9 + Math.sin(i / 5) * 2;
        return { close, high: close * 1.004, low: close * 0.996, open: close * 0.999, volume: 900 + i * 12 };
      }),
    },
    {
      candidate: { symbol: 'NVDA', market: 'overseas', score: 0.84, source: 'sec_edgar', discovered_at: now, raw_data: { strategyFamily: 'equity_momentum' } },
      backtest: { fresh: true, healthy: true, sharpe: 1.45, max_drawdown: 7.2, win_rate: 61, last_backtest_at: now, would_block: false },
      predictive: { decision: 'fire', score: 0.82, component_coverage: 0.79, created_at: now },
      community: { avg_score: null, source_count: 0, last_seen_at: null, bot_noise_score: 0, hype_spike: false },
      ohlcv: Array.from({ length: 60 }, (_, i) => {
        const close = 900 + i * 1.8 + Math.sin(i / 4) * 3;
        return { close, high: close * 1.004, low: close * 0.996, open: close * 0.999, volume: 5000 + i * 25 };
      }),
    },
  ];
}

export default {
  LUNA_PHASE4_LIVE_FORWARD_MODEL,
  LUNA_PHASE4_STRATEGY_MODEL,
  buildLunaPhase4LiveForwardRows,
  buildLunaPhase4StrategyEnhancementRows,
  ensureLunaPhase4Schema,
  insertLunaPhase4LiveForwardShadow,
  insertLunaPhase4StrategyEnhancementShadow,
  loadLunaPhase4Inputs,
  loadCachedPhase4Ohlcv,
  fixturePhase4Inputs,
};
