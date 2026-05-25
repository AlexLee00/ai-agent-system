#!/usr/bin/env node
// @ts-nocheck

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildLunaAnalysisPredictionPhaseA } from '../shared/luna-analysis-prediction-phase-a.ts';
import { buildStrategyRoute, applyStrategyRouteDecisionBias } from '../shared/strategy-router.ts';
import { run as dbRun } from '../shared/db.ts';

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
  const symbol = String(options.symbol || '005930').toUpperCase();
  const market = String(options.market || 'domestic');
  const bars = fixture ? sampleBars({ direction: options.direction || 'up' }) : (options.bars || []);
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
        exchange: market === 'crypto' ? 'binance' : 'kis',
        phaseAEvidence: phaseA,
        phaseAInfluence: 'shadow_bias',
        marketRegime: { regime: phaseA.modules.hmm.currentRegime },
        decision: seedDecision,
      })
    : null;
  const adjustedDecision = route && seedDecision
    ? applyStrategyRouteDecisionBias(seedDecision, route, market === 'crypto' ? 'binance' : 'kis')
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
    phaseA,
    strategyRoute: route,
    adjustedDecision,
    shadowLogLedger,
    nextChecks: [
      'npm --prefix bots/investment run -s smoke:luna-analysis-prediction-phase-a',
      'npm --prefix bots/investment run -s runtime:luna-analysis-prediction-phase-a -- --json --fixture --no-write',
      `npm --prefix bots/investment run -s runtime:luna-analysis-prediction-phase-a -- --json --fixture --apply --confirm=${PHASE_A_SHADOW_LOG_CONFIRM}`,
    ],
  };
  if (options.write !== false) {
    mkdirSync(dirname(options.output || DEFAULT_OUTPUT), { recursive: true });
    writeFileSync(options.output || DEFAULT_OUTPUT, JSON.stringify(report, null, 2));
  }
  return report;
}

async function main() {
  const result = await runLunaAnalysisPredictionPhaseA({
    fixture: hasFlag('fixture'),
    write: !hasFlag('no-write'),
    output: argValue('output', DEFAULT_OUTPUT),
    symbol: argValue('symbol', '005930'),
    market: argValue('market', 'domestic'),
    apply: hasFlag('apply'),
    confirm: argValue('confirm', ''),
  });
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`[luna-analysis-prediction-phase-a] ${result.status}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'runtime-luna-analysis-prediction-phase-a error:' });
}
