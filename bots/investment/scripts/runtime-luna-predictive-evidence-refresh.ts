#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { ensureCandidateBacktestSchema } from '../shared/candidate-backtest-gate.ts';
import { buildPredictiveValidationEvidence, logPredictiveValidation } from '../shared/predictive-validation.ts';
import { forecastSymbol } from '../team/kairos.ts';
import { exchangeForLunaPhase2Market, normalizeLunaPhase2Market } from '../shared/luna-weight-vector.ts';

const SHADOW_MODE = process.env.LUNA_PREDICTIVE_EVIDENCE_SHADOW_MODE !== 'false';

function argValue(name: string, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function clamp(value: any, min = 0, max = 1, fallback = 0) {
  const n = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : fallback));
}

function normalizeMarketOption(value: any = 'all') {
  const raw = String(value || 'all').trim().toLowerCase();
  if (raw === 'all') return 'all';
  return normalizeLunaPhase2Market(raw);
}

async function getActiveCandidates({ limit = 100, market = 'all' } = {}) {
  const normalizedMarket = normalizeMarketOption(market);
  const params: any[] = [];
  const marketWhere = normalizedMarket === 'all'
    ? ''
    : `AND market = $${params.push(normalizedMarket)}`;
  params.push(limit);
  return db.query(`
    WITH active_candidates AS (
      SELECT DISTINCT ON (symbol, market)
             symbol, market, score, source, discovered_at, expires_at, reason, raw_data
        FROM candidate_universe
       WHERE expires_at > NOW()
         ${marketWhere}
       ORDER BY symbol, market, score DESC, discovered_at DESC
    )
    SELECT *
      FROM active_candidates
     ORDER BY score DESC, discovered_at DESC
     LIMIT $${params.length}
  `, params).catch(() => []);
}

async function getBacktestStatus(symbol: string, market: string) {
  return db.get(`
    SELECT fresh, healthy, sharpe, max_drawdown, win_rate, last_backtest_at,
           gate_status, would_block, block_reasons
      FROM candidate_backtest_status
     WHERE symbol = $1 AND market = $2
  `, [symbol, market]).catch(() => null);
}

async function getCommunitySummary(symbol: string, market: string) {
  return db.get(`
    WITH symbol_community AS (
      SELECT (SUM(score * GREATEST(0.05, COALESCE(source_quality, 0.5)) * GREATEST(0.2, COALESCE(freshness_score, 1.0)))
                / NULLIF(SUM(GREATEST(0.05, COALESCE(source_quality, 0.5)) * GREATEST(0.2, COALESCE(freshness_score, 1.0))), 0))::double precision AS avg_score,
             COUNT(DISTINCT source_name)::int AS source_count,
             AVG(source_quality)::double precision AS avg_source_quality,
             MAX(created_at) AS last_seen_at,
             MAX(CASE WHEN COALESCE((raw_ref->'botNoise'->>'score')::double precision, 0) > 0.5 THEN 1 ELSE 0 END)::int AS bot_noise_flag,
             MAX(CASE WHEN COALESCE((raw_ref->'hypeSpike'->>'detected')::boolean, false) THEN 1 ELSE 0 END)::int AS hype_spike_flag
        FROM external_evidence_events
       WHERE source_type = 'community'
         AND symbol = $1
         AND market = $2
         AND created_at >= NOW() - INTERVAL '24 hours'
         AND source_name <> 'community_candidate_gap'
         AND COALESCE((raw_ref->>'missing_data')::boolean, false) = false
    ),
    market_community AS (
      SELECT (SUM(score * GREATEST(0.05, COALESCE(source_quality, 0.5)) * GREATEST(0.2, COALESCE(freshness_score, 1.0)))
                / NULLIF(SUM(GREATEST(0.05, COALESCE(source_quality, 0.5)) * GREATEST(0.2, COALESCE(freshness_score, 1.0))), 0))::double precision AS market_avg_score,
             COUNT(DISTINCT source_name)::int AS market_source_count,
             AVG(source_quality)::double precision AS market_avg_quality,
             MAX(created_at) AS market_last_seen_at
        FROM external_evidence_events
       WHERE source_type = 'community'
         AND symbol IS NULL
         AND market = $2
         AND created_at >= NOW() - INTERVAL '24 hours'
         AND source_name <> 'community_candidate_gap'
         AND COALESCE((raw_ref->>'missing_data')::boolean, false) = false
    )
    SELECT *
      FROM symbol_community CROSS JOIN market_community
  `, [symbol, market]).catch(() => null);
}

function scoreCommunity(row: any = {}) {
  if (!row || (row.avg_score == null && row.market_avg_score == null)) return null;
  const hasSymbolScore = row.avg_score != null;
  const avg = Number(row.avg_score);
  const marketAvg = Number(row.market_avg_score || 0);
  const sourceCount = Number(row.source_count || 0);
  const marketSourceCount = Number(row.market_source_count || 0);
  const marketContext = row.market_avg_score != null ? clamp((marketAvg + 1) / 2, 0, 1, 0.5) - 0.5 : 0;
  const normalized = hasSymbolScore ? clamp((avg + 1) / 2, 0, 1, 0.5) : clamp(0.5 + marketContext * 0.35, 0, 1, 0.5);
  const diversityBonus = Math.min(0.08, Math.max(0, sourceCount - 1) * 0.025);
  const marketContextBonus = hasSymbolScore ? Math.min(0.025, marketSourceCount * 0.006) : Math.min(0.04, marketSourceCount * 0.008);
  const sourceQuality = clamp(row.avg_source_quality ?? row.market_avg_quality, 0, 1, hasSymbolScore ? 0.45 : 0.35);
  const qualityAdjustment = clamp((sourceQuality - 0.40) * 0.16, -0.06, 0.08, 0);
  const botPenalty = Number(row.bot_noise_flag || 0) > 0 ? 0.08 : 0;
  const hypePenalty = Number(row.hype_spike_flag || 0) > 0 ? 0.04 : 0;
  return clamp(normalized + diversityBonus + marketContextBonus + qualityAdjustment - botPenalty - hypePenalty, 0, 1, 0.5);
}

function predictionScoreFromForecast(forecast: any = {}) {
  const prediction = forecast?.prediction || {};
  if (forecast?.dataHealth !== 'ok' || prediction?.currentPrice == null) return 0;
  const confidence = clamp(prediction.confidence, 0, 1, 0);
  const expectedReturn = Number(prediction.expectedReturn || 0);
  const directionalBase = prediction.direction === 'up'
    ? 0.55 + confidence * 0.35
    : prediction.direction === 'down'
      ? 0.45 - confidence * 0.35
      : 0.5;
  const returnAdjustment = clamp(expectedReturn * 8, -0.15, 0.15, 0);
  return Number(clamp(directionalBase + returnAdjustment, 0, 1, 0).toFixed(4));
}

async function forecastSymbolWithFallback(symbol: string, market: string, options: any = {}) {
  const exchange = exchangeForLunaPhase2Market(market);
  const primaryTimeframe = String(options.timeframe || '1h');
  const horizon = Number(options.horizon || 5);
  const primaryLimit = Number(options.ohlcvLimit || 180);
  const attempts = [
    { timeframe: primaryTimeframe, limit: primaryLimit, reason: 'primary' },
    { timeframe: '5m', limit: Math.max(240, primaryLimit), reason: 'intraday_dense_fallback' },
    { timeframe: '1d', limit: Math.max(120, Math.ceil(primaryLimit / 4)), reason: 'daily_history_fallback' },
  ].filter((attempt, index, arr) => arr.findIndex((item) => item.timeframe === attempt.timeframe) === index);

  const evidence = [];
  let best: any = null;
  for (const attempt of attempts) {
    const forecast = await forecastSymbol(symbol, {
      timeframe: attempt.timeframe,
      limit: attempt.limit,
      horizon,
      exchange,
    }).catch((error: any) => ({
      ok: false,
      symbol,
      dataHealth: 'forecast_error',
      error: String(error?.message || error),
      prediction: { confidence: 0, direction: 'neutral', expectedReturn: 0 },
      observedCandles: 0,
      timeframe: attempt.timeframe,
    }));
    evidence.push({
      timeframe: attempt.timeframe,
      limit: attempt.limit,
      reason: attempt.reason,
      dataHealth: forecast?.dataHealth || 'unknown',
      observedCandles: Number(forecast?.observedCandles || 0),
      error: forecast?.error || null,
    });
    if (!best || Number(forecast?.observedCandles || 0) > Number(best?.observedCandles || 0)) best = forecast;
    if (forecast?.dataHealth === 'ok') {
      return { ...forecast, fallbackEvidence: evidence, selectedForecastReason: attempt.reason };
    }
  }
  return { ...(best || {}), fallbackEvidence: evidence, selectedForecastReason: 'best_available_insufficient' };
}

function fixtureCandidates() {
  const now = new Date().toISOString();
  return [
    { symbol: 'BTC/USDT', market: 'crypto', score: 0.86, source: 'fixture', discovered_at: now, expires_at: now, raw_data: {} },
    { symbol: 'NEG/USDT', market: 'crypto', score: 0.42, source: 'fixture', discovered_at: now, expires_at: now, raw_data: {} },
  ];
}

function fixtureForecast(symbol: string) {
  const up = symbol !== 'NEG/USDT';
  const confidence = up ? 0.82 : 0.18;
  return {
    ok: true,
    symbol,
    dataHealth: 'ok',
    prediction: {
      enabled: false,
      shadowMode: true,
      currentPrice: 100,
      direction: up ? 'up' : 'down',
      expectedReturn: up ? 0.024 : -0.019,
      confidence,
      usable: false,
      r2: confidence,
      volatility: 0.01,
    },
  };
}

async function refreshPredictiveForCandidate(candidate: any, options: any = {}) {
  const dryRun = options.dryRun === true;
  const fixture = options.fixture === true;
  const symbol = String(candidate.symbol || '').toUpperCase();
  const market = normalizeLunaPhase2Market(candidate.market);
  const backtest = fixture
    ? {
      fresh: symbol !== 'NEG/USDT',
      healthy: symbol !== 'NEG/USDT',
      sharpe: symbol === 'NEG/USDT' ? -0.5 : 1.1,
      max_drawdown: symbol === 'NEG/USDT' ? 28 : 12,
      win_rate: symbol === 'NEG/USDT' ? 24 : 52,
      last_backtest_at: new Date().toISOString(),
    }
    : await getBacktestStatus(symbol, market);
  const community = fixture
    ? { avg_score: symbol === 'NEG/USDT' ? -0.2 : 0.34, source_count: symbol === 'NEG/USDT' ? 1 : 2, last_seen_at: new Date().toISOString() }
    : await getCommunitySummary(symbol, market);
  const forecast = fixture
    ? fixtureForecast(symbol)
    : await forecastSymbolWithFallback(symbol, market, options);

  const predictionScore = predictionScoreFromForecast(forecast);
  const communityScore = scoreCommunity(community);
  const evidence = buildPredictiveValidationEvidence(
    {
      symbol,
      market,
      confidence: candidate.score,
      backtest,
      candidateBacktestStatus: backtest || {},
      prediction: {
        score: predictionScore,
        predictionScore,
        direction: forecast?.prediction?.direction || 'neutral',
        expectedReturn: forecast?.prediction?.expectedReturn ?? null,
        confidence: forecast?.prediction?.confidence ?? null,
      },
      setupOutcome: communityScore == null ? null : { score: communityScore },
    },
    {
      hasFreshBacktest: backtest?.fresh === true || String(backtest?.fresh).toLowerCase() === 'true',
      backtest,
      candidateBacktestStatus: backtest || {},
      prediction: { score: predictionScore },
      setupOutcome: communityScore == null ? null : { score: communityScore },
    },
    {
      hardeningEnabled: true,
      hardeningEnforce: true,
      threshold: Number(process.env.LUNA_PREDICTIVE_EVIDENCE_THRESHOLD || 0.55),
    },
  );

  if (!dryRun) {
    await logPredictiveValidation(evidence, {
      symbol,
      market,
      candidateSnapshot: {
        ...candidate,
        forecast,
        backtest,
        community,
        predictionScore,
        communityScore,
        shadowMode: SHADOW_MODE,
        source: 'runtime-luna-predictive-evidence-refresh',
      },
    });
  }

  return {
    symbol,
    market,
    decision: evidence.decision,
    score: evidence.score,
    componentCoverage: evidence.componentCoverage,
    blocked: evidence.blocked,
    wouldBlock: evidence.wouldBlock,
    predictionScore,
    dataHealth: forecast?.dataHealth || 'unknown',
    backtestFresh: backtest?.fresh === true || String(backtest?.fresh).toLowerCase() === 'true',
    communitySources: Number(community?.source_count || 0) + Number(community?.market_source_count || 0),
    forecastTimeframe: forecast?.timeframe || null,
    forecastCandles: Number(forecast?.observedCandles || 0),
    forecastFallbackReason: forecast?.selectedForecastReason || null,
    reason: evidence.reason,
  };
}

export async function runLunaPredictiveEvidenceRefresh(options: any = {}) {
  const dryRun = options.dryRun === true;
  const fixture = options.fixture === true;
  const json = options.json === true;
  const limit = Math.max(1, Number(options.limit || process.env.LUNA_PREDICTIVE_EVIDENCE_LIMIT || 50));
  const market = normalizeMarketOption(options.market || process.env.LUNA_PREDICTIVE_EVIDENCE_MARKET || 'all');
  if (!dryRun) {
    await db.initSchema();
    await ensureCandidateBacktestSchema();
  }
  const candidates = fixture ? fixtureCandidates() : await getActiveCandidates({ limit, market });
  const results = [];
  for (const candidate of candidates) {
    results.push(await refreshPredictiveForCandidate(candidate, options));
  }
  const payload = {
    ok: true,
    status: dryRun ? 'luna_predictive_evidence_planned' : 'luna_predictive_evidence_written',
    phase: 'luna_phase1_predictive_hardening',
    shadowMode: SHADOW_MODE,
    dryRun,
    fixture,
    writeMode: dryRun ? 'dry-run' : 'shadow-apply',
    market,
    total: results.length,
    passed: results.filter((row) => row.decision === 'fire').length,
    blocked: results.filter((row) => row.blocked).length,
    missingPrediction: results.filter((row) => row.predictionScore <= 0).length,
    missingFreshBacktest: results.filter((row) => !row.backtestFresh).length,
    lowCommunityCoverage: results.filter((row) => row.communitySources < 2).length,
    results,
  };
  if (!json) console.log(`[luna-predictive-evidence] ${payload.status} total=${payload.total} fire=${payload.passed} blocked=${payload.blocked}`);
  return payload;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => runLunaPredictiveEvidenceRefresh({
      json: hasFlag('json'),
      dryRun: hasFlag('dry-run'),
      fixture: hasFlag('fixture'),
      limit: Number(argValue('limit', process.env.LUNA_PREDICTIVE_EVIDENCE_LIMIT || 50)),
      market: argValue('market', process.env.LUNA_PREDICTIVE_EVIDENCE_MARKET || 'all'),
      timeframe: argValue('timeframe', process.env.LUNA_PREDICTIVE_EVIDENCE_TIMEFRAME || '1h'),
      horizon: Number(argValue('horizon', process.env.LUNA_PREDICTIVE_EVIDENCE_HORIZON || 5)),
      ohlcvLimit: Number(argValue('ohlcv-limit', process.env.LUNA_PREDICTIVE_EVIDENCE_OHLCV_LIMIT || 180)),
    }),
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: 'runtime-luna-predictive-evidence-refresh error:',
  });
}
