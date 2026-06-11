#!/usr/bin/env node
// @ts-nocheck

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildLunaAnalysisPredictionPhaseA } from '../shared/luna-analysis-prediction-phase-a.ts';
import { buildStrategyRoute, applyStrategyRouteDecisionBias } from '../shared/strategy-router.ts';
import {
  DEFAULT_PHASE_A_SYMBOLS_BY_MARKET,
  exchangeForPhaseAMarket,
  fetchPhaseABars,
  normalizePhaseABars,
  normalizePhaseAMarket,
  normalizePhaseASymbol,
} from '../shared/luna-phase-a-market-data.ts';
import { query as dbQuery, run as dbRun } from '../shared/db.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INVESTMENT_ROOT = resolve(__dirname, '..');
const DEFAULT_OUTPUT = resolve(INVESTMENT_ROOT, 'output/luna-analysis-prediction-phase-a-report.json');
const MIGRATION = resolve(INVESTMENT_ROOT, 'migrations/20260525000001_luna_analysis_prediction_phase_a_logs.sql');
export const PHASE_A_SHADOW_LOG_CONFIRM = 'luna-analysis-prediction-phase-a-shadow-log';

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function parseList(value, fallback = []) {
  const items = String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item, index, arr) => arr.indexOf(item) === index);
  return items.length ? items : fallback;
}

const normalizeMarket = normalizePhaseAMarket;
const exchangeForMarket = exchangeForPhaseAMarket;
const normalizeSymbol = normalizePhaseASymbol;
const normalizeBars = normalizePhaseABars;

async function resolvePhaseASymbols(options = {}) {
  const market = normalizeMarket(options.market || 'domestic');
  const limit = Math.max(1, Math.min(100, Number(options.limit || 10) || 10));
  const explicitSymbols = parseList(options.symbols, []);
  if (explicitSymbols.length > 0 && !explicitSymbols.some((item) => item.toLowerCase() === 'auto')) {
    return explicitSymbols.slice(0, limit).map((symbol) => normalizeSymbol(symbol, market));
  }
  if (options.symbol && String(options.symbol).trim() && explicitSymbols.length === 0) {
    return [normalizeSymbol(options.symbol, market)];
  }

  const queryFn = options.query || dbQuery;
  const fallback = (DEFAULT_PHASE_A_SYMBOLS_BY_MARKET[market] || DEFAULT_PHASE_A_SYMBOLS_BY_MARKET.domestic).slice(0, limit);
  try {
    const rows = await Promise.resolve(queryFn(
      `SELECT symbol
         FROM investment.candidate_universe
        WHERE market = $1
          AND expires_at > NOW()
        ORDER BY score DESC NULLS LAST, discovered_at DESC NULLS LAST
        LIMIT $2`,
      [market, limit],
    ));
    const symbols = (Array.isArray(rows) ? rows : [])
      .map((row) => normalizeSymbol(row?.symbol, market))
      .filter(Boolean);
    return symbols.length ? [...new Set(symbols)] : fallback;
  } catch {
    return fallback;
  }
}

async function ensurePhaseALogSchema(runFn = dbRun) {
  const sql = readFileSync(MIGRATION, 'utf8');
  for (const statement of sql.split(/;\s*(?:\n|$)/u).map((part) => part.trim()).filter(Boolean)) {
    await Promise.resolve(runFn(statement));
  }
}

function sampleBars({ direction = 'up' } = {}) {
  return Array.from({ length: 80 }, (_, index) => {
    const trend = direction === 'down' ? -0.35 : 0.42;
    const cycle = Math.sin(index / 5) * 1.2;
    const base = 100 + index * trend + cycle;
    return {
      open: base - 0.3,
      high: base + 1.2,
      low: base - 1.0,
      close: base + (index % 3) * 0.15,
      volume: 100000 + index * 1800 + (index % 7) * 9000,
    };
  });
}

function fixtureEvidence(symbol) {
  return [
    { symbol, source: 'fixture_news', text: `${symbol} reports strong growth and record profit beat` },
    { symbol, source: 'fixture_disclosure', text: `${symbol} 자사주 매입 및 수주 증가 공시` },
  ];
}

export async function insertPhaseAShadowLogs(phaseA, options = {}) {
  const runFn = options.run || dbRun;
  const symbol = phaseA?.symbol;
  const market = phaseA?.market;
  if (!symbol || !market) return { rows: 0, byTable: {}, reason: 'missing_symbol_or_market' };

  await ensurePhaseALogSchema(runFn);
  const byTable = {};

  const hmm = phaseA.modules?.hmm || {};
  await Promise.resolve(runFn(
    `INSERT INTO investment.hmm_regime_log
       (symbol, market, current_regime, regime_probabilities, transition_matrix, confidence, features, shadow_only)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7::jsonb,true)`,
    [
      symbol,
      market,
      hmm.currentRegime || 'unknown',
      JSON.stringify(hmm.regimeProbabilities || {}),
      JSON.stringify(hmm.transitionMatrix || {}),
      hmm.confidence ?? null,
      JSON.stringify(hmm.features || {}),
    ],
  ));
  byTable.hmmRegimeLog = 1;

  const garch = phaseA.modules?.garch || {};
  await Promise.resolve(runFn(
    `INSERT INTO investment.garch_volatility_log
       (symbol, market, volatility_forecast, var95, var99, position_size_factor, features, shadow_only)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7::jsonb,true)`,
    [
      symbol,
      market,
      JSON.stringify(garch.volatilityForecast || {}),
      garch.var95 ?? null,
      garch.var99 ?? null,
      garch.positionSizeFactor ?? null,
      JSON.stringify(garch.features || {}),
    ],
  ));
  byTable.garchVolatilityLog = 1;

  const finbert = phaseA.modules?.finbert || {};
  const aggregate = finbert.aggregate || {};
  await Promise.resolve(runFn(
    `INSERT INTO investment.finbert_sentiment_log
       (symbol, market, sentiment, score, confidence, model, evidence_count, metadata, shadow_only)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,true)`,
    [
      symbol,
      market,
      aggregate.sentiment || 'neutral',
      aggregate.score ?? null,
      aggregate.confidence ?? null,
      finbert.model || 'finbert_lexical_fallback',
      aggregate.evidenceCount ?? 0,
      JSON.stringify({ assets: finbert.assets || {}, status: finbert.status || null }),
    ],
  ));
  byTable.finbertSentimentLog = 1;

  let alphaRows = 0;
  const worldquant = phaseA.modules?.worldquant || {};
  for (const [alphaId, alphaValue] of Object.entries(worldquant.alphas || {})) {
    alphaRows += 1;
    await Promise.resolve(runFn(
      `INSERT INTO investment.worldquant_alpha_log
         (symbol, market, alpha_id, alpha_value, composite, rank, metadata, shadow_only)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,true)`,
      [
        symbol,
        market,
        alphaId,
        alphaValue,
        worldquant.composite ?? null,
        alphaRows,
        JSON.stringify({ signal: worldquant.signal || null, status: worldquant.status || null }),
      ],
    ));
  }
  byTable.worldquantAlphaLog = alphaRows;

  return {
    rows: Object.values(byTable).reduce((sum, value) => sum + Number(value || 0), 0),
    byTable,
  };
}

export async function runLunaAnalysisPredictionPhaseA(options = {}) {
  const fixture = options.fixture === true;
  const market = normalizeMarket(options.market || 'domestic');
  const symbol = normalizeSymbol(options.symbol || '005930', market);
  const timeframe = String(options.timeframe || '1d');
  const lookbackDays = Math.max(40, Number(options.lookbackDays || 120) || 120);
  const marketData = fixture
    ? { bars: sampleBars({ direction: options.direction || 'up' }), source: 'fixture_sample_bars', error: null }
    : Array.isArray(options.bars) && options.bars.length > 0
      ? { bars: normalizeBars(options.bars), source: options.marketDataSource || 'provided_bars', error: null }
      : options.fetchBars === false
        ? { bars: [], source: 'market_data_fetch_disabled', error: null }
        : await fetchPhaseABars({
            symbol,
            market,
            timeframe,
            lookbackDays,
            getOhlcv: options.getOhlcv,
          });
  const bars = marketData.bars || [];
  const phaseA = buildLunaAnalysisPredictionPhaseA({
    symbol,
    market,
    bars,
    evidence: fixture ? fixtureEvidence(symbol) : (options.evidence || []),
    factors: options.factors || { quality: 0.72, hml: 0.66 },
  });

  const dataReady = phaseA.ok === true;
  const seedDecision = dataReady
    ? { action: 'BUY', confidence: phaseA.predictiveScore, amount_usdt: 50000, reasoning: fixture ? 'phase_a_shadow_fixture' : 'phase_a_shadow_observation' }
    : null;
  const route = dataReady
    ? await buildStrategyRoute({
        symbol,
        exchange: exchangeForMarket(market),
        phaseAEvidence: phaseA,
        phaseAInfluence: options.phaseAInfluence || 'shadow_bias',
        marketRegime: { regime: phaseA.modules.hmm.currentRegime },
        decision: seedDecision,
      })
    : null;
  const adjustedDecision = route && seedDecision
    ? applyStrategyRouteDecisionBias(seedDecision, route, exchangeForMarket(market))
    : null;

  let shadowLogLedger = {
    writeApplied: false,
    writeMode: options.apply ? 'shadow-log-apply-requested' : 'plan-only',
    rows: 0,
    byTable: {},
    confirmRequired: PHASE_A_SHADOW_LOG_CONFIRM,
    reason: dataReady ? null : 'phase_a_not_ready',
  };
  if (options.apply === true) {
    if (options.confirm !== PHASE_A_SHADOW_LOG_CONFIRM) {
      throw new Error(`runtime:luna-analysis-prediction-phase-a apply requires --confirm=${PHASE_A_SHADOW_LOG_CONFIRM}`);
    }
    if (dataReady) {
      const inserted = await insertPhaseAShadowLogs(phaseA, { run: options.run || dbRun });
      shadowLogLedger = {
        ...shadowLogLedger,
        writeApplied: true,
        writeMode: 'phase-a-shadow-log-apply',
        rows: inserted.rows,
        byTable: inserted.byTable,
        reason: null,
      };
    }
  }

  const report = {
    ok: phaseA.ok,
    status: phaseA.ok ? 'luna_analysis_prediction_phase_a_shadow_ready' : 'luna_analysis_prediction_phase_a_shadow_partial',
    generatedAt: new Date().toISOString(),
    fixture,
    shadowOnly: true,
    liveTradeImpact: false,
    marketData: {
      source: marketData.source,
      bars: bars.length,
      timeframe,
      lookbackDays,
      error: marketData.error || null,
    },
    phaseA,
    strategyRoute: route,
    adjustedDecision,
    shadowLogLedger,
    nextChecks: [
      'npm --prefix bots/investment run -s smoke:luna-analysis-prediction-phase-a',
      'npm --prefix bots/investment run -s runtime:luna-analysis-prediction-phase-a -- --json --fixture --no-write',
      'npm --prefix bots/investment run -s runtime:luna-analysis-prediction-phase-a -- --json --market=domestic --symbols=auto --limit=5 --no-write',
      `npm --prefix bots/investment run -s runtime:luna-analysis-prediction-phase-a -- --json --fixture --apply --confirm=${PHASE_A_SHADOW_LOG_CONFIRM}`,
    ],
  };
  if (options.write !== false) {
    mkdirSync(dirname(options.output || DEFAULT_OUTPUT), { recursive: true });
    writeFileSync(options.output || DEFAULT_OUTPUT, JSON.stringify(report, null, 2));
  }
  return report;
}

export async function runLunaAnalysisPredictionPhaseABatch(options = {}) {
  const market = normalizeMarket(options.market || 'domestic');
  const symbols = await resolvePhaseASymbols({
    ...options,
    market,
  });
  const reports = [];
  for (const symbol of symbols) {
    reports.push(await runLunaAnalysisPredictionPhaseA({
      ...options,
      market,
      symbol,
      write: false,
    }));
  }
  const ready = reports.filter((item) => item?.ok === true);
  const shadowRows = reports.reduce((sum, item) => sum + Number(item?.shadowLogLedger?.rows || 0), 0);
  const applyOk = options.apply === true
    ? ready.every((item) => item?.shadowLogLedger?.writeApplied === true)
    : true;
  const batchReport = {
    ok: ready.length > 0 && applyOk,
    status: ready.length === reports.length
      ? 'luna_analysis_prediction_phase_a_batch_shadow_ready'
      : ready.length > 0
        ? 'luna_analysis_prediction_phase_a_batch_shadow_partial'
        : 'luna_analysis_prediction_phase_a_batch_shadow_empty',
    generatedAt: new Date().toISOString(),
    fixture: options.fixture === true,
    shadowOnly: true,
    liveTradeImpact: false,
    market,
    symbols: symbols.length,
    ready: ready.length,
    partial: reports.length - ready.length,
    shadowLogLedger: {
      writeApplied: options.apply === true && shadowRows > 0,
      rows: shadowRows,
      confirmRequired: PHASE_A_SHADOW_LOG_CONFIRM,
    },
    results: reports.map((item) => ({
      symbol: item.symbol || item.phaseA?.symbol || null,
      market: item.phaseA?.market || market,
      ok: item.ok === true,
      status: item.status,
      predictiveScore: item.phaseA?.predictiveScore ?? null,
      selectedFamily: item.strategyRoute?.selectedFamily || null,
      influenceMode: item.strategyRoute?.phaseA?.influenceMode || null,
      influenceWeight: item.strategyRoute?.phaseA?.influenceWeight ?? null,
      marketData: item.marketData || null,
      shadowRows: Number(item.shadowLogLedger?.rows || 0),
      blockers: item.phaseA?.blockers || [],
    })),
    nextChecks: [
      'npm --prefix bots/investment run -s smoke:luna-analysis-prediction-phase-a',
      `npm --prefix bots/investment run -s runtime:luna-analysis-prediction-phase-a -- --json --market=${market} --symbols=auto --limit=5 --no-write`,
    ],
  };
  if (options.write !== false) {
    mkdirSync(dirname(options.output || DEFAULT_OUTPUT), { recursive: true });
    writeFileSync(options.output || DEFAULT_OUTPUT, JSON.stringify(batchReport, null, 2));
  }
  return batchReport;
}

export async function runLunaAnalysisPredictionPhaseAPromotionGate(options = {}) {
  const market = normalizeMarket(options.market || 'domestic');
  const queryFn = options.query || dbQuery;
  const runFn = options.run || dbRun;
  const minShadowDays = Math.max(1, Number(options.minShadowDays || 7) || 7);
  const minSamples = Math.max(1, Number(options.minSamples || minShadowDays) || minShadowDays);
  const windowDays = Math.max(minShadowDays, Number(options.windowDays || 14) || 14);
  const staleHours = Math.max(1, Number(options.staleHours || 36) || 36);
  let rows = [];
  let queryError = null;
  try {
    if (options.ensureSchema === true) {
      await ensurePhaseALogSchema(runFn);
    }
    rows = await Promise.resolve(queryFn(
      `WITH hmm AS (
         SELECT symbol, market,
                COUNT(*)::int AS hmm_samples,
                COUNT(DISTINCT created_at::date)::int AS shadow_days,
                MAX(created_at) AS latest_observed_at,
                AVG(confidence::float) AS avg_regime_confidence
           FROM investment.hmm_regime_log
          WHERE market = $1
            AND created_at >= NOW() - ($2::int * INTERVAL '1 day')
          GROUP BY symbol, market
       ),
       garch AS (
         SELECT symbol, market,
                COUNT(*)::int AS garch_samples,
                AVG(position_size_factor::float) AS avg_position_size_factor
           FROM investment.garch_volatility_log
          WHERE market = $1
            AND created_at >= NOW() - ($2::int * INTERVAL '1 day')
          GROUP BY symbol, market
       ),
       finbert AS (
         SELECT symbol, market,
                COUNT(*)::int AS sentiment_samples,
                AVG(score::float) AS avg_sentiment_score
           FROM investment.finbert_sentiment_log
          WHERE market = $1
            AND created_at >= NOW() - ($2::int * INTERVAL '1 day')
          GROUP BY symbol, market
       ),
       wq AS (
         SELECT symbol, market,
                COUNT(*)::int AS alpha_samples,
                COUNT(DISTINCT created_at::date)::int AS alpha_shadow_days,
                AVG(composite::float) AS avg_alpha_composite
           FROM investment.worldquant_alpha_log
          WHERE market = $1
            AND created_at >= NOW() - ($2::int * INTERVAL '1 day')
          GROUP BY symbol, market
       )
       SELECT hmm.symbol, hmm.market, hmm.hmm_samples, hmm.shadow_days, hmm.latest_observed_at,
              hmm.avg_regime_confidence,
              COALESCE(garch.garch_samples, 0)::int AS garch_samples,
              garch.avg_position_size_factor,
              COALESCE(finbert.sentiment_samples, 0)::int AS sentiment_samples,
              finbert.avg_sentiment_score,
              COALESCE(wq.alpha_samples, 0)::int AS alpha_samples,
              COALESCE(wq.alpha_shadow_days, 0)::int AS alpha_shadow_days,
              wq.avg_alpha_composite
         FROM hmm
         LEFT JOIN garch ON garch.symbol = hmm.symbol AND garch.market = hmm.market
         LEFT JOIN finbert ON finbert.symbol = hmm.symbol AND finbert.market = hmm.market
         LEFT JOIN wq ON wq.symbol = hmm.symbol AND wq.market = hmm.market
        ORDER BY hmm.shadow_days DESC, hmm.latest_observed_at DESC`,
      [market, windowDays],
    ));
  } catch (error) {
    queryError = error?.message || String(error);
  }

  const candidates = (Array.isArray(rows) ? rows : []).map((row) => {
    const latestMs = row?.latest_observed_at ? new Date(row.latest_observed_at).getTime() : 0;
    const ageHours = latestMs > 0 ? (Date.now() - latestMs) / 36e5 : Infinity;
    const blockers = [
      Number(row.shadow_days || 0) >= minShadowDays ? null : 'shadow_days_below_target',
      Number(row.hmm_samples || 0) >= minSamples ? null : 'hmm_samples_below_target',
      Number(row.garch_samples || 0) >= minSamples ? null : 'garch_samples_below_target',
      Number(row.sentiment_samples || 0) >= minSamples ? null : 'sentiment_samples_below_target',
      Number(row.alpha_shadow_days || 0) >= minShadowDays ? null : 'alpha_shadow_days_below_target',
      ageHours <= staleHours ? null : 'latest_shadow_stale',
    ].filter(Boolean);
    return {
      symbol: row.symbol,
      market: row.market,
      promotionReady: blockers.length === 0,
      canPromote: false,
      activeBiasWeight: blockers.length === 0 ? 0.5 : null,
      shadowBiasWeight: 0.25,
      blockers,
      metrics: {
        shadowDays: Number(row.shadow_days || 0),
        hmmSamples: Number(row.hmm_samples || 0),
        garchSamples: Number(row.garch_samples || 0),
        sentimentSamples: Number(row.sentiment_samples || 0),
        alphaSamples: Number(row.alpha_samples || 0),
        alphaShadowDays: Number(row.alpha_shadow_days || 0),
        latestObservedAt: row.latest_observed_at || null,
        latestAgeHours: Number.isFinite(ageHours) ? Number(ageHours.toFixed(2)) : null,
        avgRegimeConfidence: row.avg_regime_confidence == null ? null : Number(Number(row.avg_regime_confidence).toFixed(4)),
        avgPositionSizeFactor: row.avg_position_size_factor == null ? null : Number(Number(row.avg_position_size_factor).toFixed(4)),
        avgSentimentScore: row.avg_sentiment_score == null ? null : Number(Number(row.avg_sentiment_score).toFixed(4)),
        avgAlphaComposite: row.avg_alpha_composite == null ? null : Number(Number(row.avg_alpha_composite).toFixed(4)),
      },
      reason: blockers.length === 0
        ? 'phase_a_shadow_ready_for_manual_active_promotion_review'
        : blockers.join(', '),
    };
  });
  const ready = candidates.filter((item) => item.promotionReady === true);
  const report = {
    ok: queryError == null,
    status: queryError
      ? 'luna_analysis_prediction_phase_a_promotion_gate_unavailable'
      : ready.length > 0
        ? 'luna_analysis_prediction_phase_a_promotion_gate_candidates'
        : 'luna_analysis_prediction_phase_a_promotion_gate_not_ready',
    generatedAt: new Date().toISOString(),
    market,
    shadowOnly: true,
    liveTradeImpact: false,
    activePromotionAutoApply: false,
    thresholds: {
      minShadowDays,
      minSamples,
      windowDays,
      staleHours,
      shadowBiasWeight: 0.25,
      activeBiasWeightAfterManualPromotion: 0.5,
    },
    queryError,
    candidates,
    summary: {
      candidates: candidates.length,
      ready: ready.length,
      blocked: candidates.length - ready.length,
    },
    nextChecks: [
      `npm --prefix bots/investment run -s runtime:luna-analysis-prediction-phase-a -- --json --market=${market} --symbols=auto --limit=5 --no-write`,
      `npm --prefix bots/investment run -s runtime:luna-analysis-prediction-phase-a -- --json --promotion-gate --market=${market} --no-write`,
    ],
  };
  if (options.write !== false) {
    mkdirSync(dirname(options.output || DEFAULT_OUTPUT), { recursive: true });
    writeFileSync(options.output || DEFAULT_OUTPUT, JSON.stringify(report, null, 2));
  }
  return report;
}

async function main() {
  const common = {
    fixture: hasFlag('fixture'),
    write: !hasFlag('no-write'),
    output: argValue('output', DEFAULT_OUTPUT),
    symbol: argValue('symbol', '005930'),
    market: argValue('market', 'domestic'),
    symbols: argValue('symbols', null),
    limit: Number(argValue('limit', 10) || 10),
    timeframe: argValue('timeframe', '1d'),
    lookbackDays: Number(argValue('lookback-days', 120) || 120),
    minShadowDays: Number(argValue('min-shadow-days', 7) || 7),
    minSamples: Number(argValue('min-samples', 7) || 7),
    ensureSchema: hasFlag('ensure-schema'),
    apply: hasFlag('apply'),
    confirm: argValue('confirm', ''),
  };
  const result = hasFlag('promotion-gate')
    ? await runLunaAnalysisPredictionPhaseAPromotionGate(common)
    : common.symbols || hasFlag('batch')
    ? await runLunaAnalysisPredictionPhaseABatch(common)
    : await runLunaAnalysisPredictionPhaseA(common);
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`[luna-analysis-prediction-phase-a] ${result.status}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'runtime-luna-analysis-prediction-phase-a error:' });
}
