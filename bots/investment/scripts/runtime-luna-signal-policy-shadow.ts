#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildSignalPolicyCandidates,
  evaluateSignalPolicyShadow,
  isSignalLearningEnabled,
  signalPolicyConfigFromEnv,
} from '../shared/luna-signal-robust-learning.ts';

const CONFIRM_TOKEN = 'luna-signal-policy-shadow';

function argValue(name, fallback = null, argv = process.argv.slice(2)) {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function parseList(value, fallback = []) {
  const list = String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return list.length ? [...new Set(list)] : fallback;
}

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const config = signalPolicyConfigFromEnv(env);
  return {
    apply: argv.includes('--apply'),
    dryRun: argv.includes('--dry-run') || argv.includes('--dryRun'),
    fixture: argv.includes('--fixture'),
    json: argv.includes('--json'),
    confirm: argValue('confirm', '', argv),
    markets: parseList(argValue('markets', argValue('market', config.markets.join(','), argv), argv), config.markets),
    limit: Math.max(1, Number(argValue('limit', env.LUNA_SIGNAL_POLICY_LIMIT || 300, argv)) || 300),
    hours: Math.max(1, Number(argValue('hours', env.LUNA_SIGNAL_POLICY_LOOKBACK_HOURS || 168, argv)) || 168),
  };
}

export async function ensureLunaSignalPolicyShadowTable(runFn = db.run) {
  await runFn(`
    CREATE TABLE IF NOT EXISTS luna_signal_policy_shadow (
      id                     BIGSERIAL PRIMARY KEY,
      policy_name            TEXT NOT NULL,
      policy_config          JSONB NOT NULL DEFAULT '{}'::jsonb,
      market                 TEXT NOT NULL,
      sample_count           INTEGER NOT NULL DEFAULT 0,
      skipped_count          INTEGER NOT NULL DEFAULT 0,
      oos_positive_rate      DOUBLE PRECISION,
      oos_sharpe             DOUBLE PRECISION,
      overfit_gap            DOUBLE PRECISION,
      wf_pass_rate           DOUBLE PRECISION,
      verified_healthy_count INTEGER NOT NULL DEFAULT 0,
      baseline_score         DOUBLE PRECISION,
      raw_score              DOUBLE PRECISION,
      score                  DOUBLE PRECISION NOT NULL DEFAULT 0,
      score_delta            DOUBLE PRECISION,
      component_scores       JSONB NOT NULL DEFAULT '{}'::jsonb,
      data_health            TEXT NOT NULL DEFAULT 'unknown',
      shadow_only            BOOLEAN NOT NULL DEFAULT true,
      observed_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await runFn(`CREATE INDEX IF NOT EXISTS idx_luna_signal_policy_shadow_market_score ON luna_signal_policy_shadow (market, score DESC, observed_at DESC)`);
  await runFn(`CREATE INDEX IF NOT EXISTS idx_luna_signal_policy_shadow_policy_observed ON luna_signal_policy_shadow (policy_name, market, observed_at DESC)`);
}

function fixtureRows() {
  return [
    {
      symbol: 'STABLE/USDT',
      market: 'crypto',
      healthy: true,
      sharpe: 1.2,
      sharpe_is: 1.4,
      sharpe_oos: 1.1,
      overfit_gap: 0.3,
      selection_method: 'walk_forward',
      oos_status: 'ok',
      trial_sharpes: [1.4, 1.3, 1.2, 0.9],
    },
    {
      symbol: 'OVERFIT/USDT',
      market: 'crypto',
      healthy: false,
      sharpe: 6.6,
      sharpe_is: 6.6,
      sharpe_oos: -1.4,
      overfit_gap: 8.0,
      selection_method: 'walk_forward',
      oos_status: 'ok',
      trial_sharpes: [6.6, 1.1, 0.8, -0.2],
    },
    {
      symbol: '005930',
      market: 'domestic',
      healthy: true,
      sharpe: 1.0,
      sharpe_is: 1.2,
      sharpe_oos: 0.8,
      overfit_gap: 0.4,
      selection_method: 'walk_forward',
      oos_status: 'ok',
      trial_sharpes: [1.2, 0.95, 0.7],
    },
  ];
}

function fixtureRegimes() {
  return {
    crypto: { llm_regime: 'trending_bull', llm_confidence: 0.72 },
    domestic: { llm_regime: 'range_bound', llm_confidence: 0.61 },
  };
}

async function loadCandidateRows(queryFn, options) {
  return queryFn(
    `SELECT symbol, market, healthy, gate_status, sharpe, sharpe_is, sharpe_oos,
            overfit_gap, selection_method, oos_status, total_trades_oos,
            trial_sharpes, dsr, pbo, updated_at
       FROM candidate_backtest_status
      WHERE market = ANY($1::text[])
        AND updated_at >= NOW() - ($2::int * INTERVAL '1 hour')
        AND sharpe_oos IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT $3`,
    [options.markets, options.hours, options.limit],
  );
}

async function loadRegimes(queryFn, markets) {
  const rows = await queryFn(
    `SELECT DISTINCT ON (market) market, rule_regime, rule_confidence, llm_regime, llm_confidence, captured_at
       FROM luna_regime_llm_shadow
      WHERE market = ANY($1::text[])
      ORDER BY market, captured_at DESC`,
    [markets],
  ).catch(() => []);
  return Object.fromEntries((Array.isArray(rows) ? rows : []).map((row) => [row.market, row]));
}

async function loadPreviousScores(queryFn, markets) {
  return queryFn(
    `SELECT DISTINCT ON (policy_name, market) policy_name, market, score, observed_at
       FROM luna_signal_policy_shadow
      WHERE market = ANY($1::text[])
      ORDER BY policy_name, market, observed_at DESC`,
    [markets],
  ).catch(() => []);
}

async function insertPolicyShadow(runFn, row) {
  await runFn(
    `INSERT INTO luna_signal_policy_shadow
       (policy_name, policy_config, market, sample_count, skipped_count,
        oos_positive_rate, oos_sharpe, overfit_gap, wf_pass_rate,
        verified_healthy_count, baseline_score, raw_score, score, score_delta,
        component_scores, data_health, shadow_only, observed_at)
     VALUES ($1,$2::jsonb,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,true,$17)`,
    [
      row.policyName,
      JSON.stringify(row.policyConfig || {}),
      row.market,
      row.sampleCount,
      row.skippedCount,
      row.oosPositiveRate,
      row.oosSharpe,
      row.overfitGap,
      row.wfPassRate,
      row.verifiedHealthyCount,
      row.baselineScore,
      row.rawScore,
      row.score,
      row.scoreDelta,
      JSON.stringify(row.componentScores || {}),
      row.dataHealth,
      row.observedAt,
    ],
  );
}

export async function runLunaSignalPolicyShadow(options = parseArgs(), deps = {}) {
  const env = deps.env || process.env;
  const enabled = isSignalLearningEnabled(env);
  const canPlan = enabled || options.dryRun || options.fixture;
  if (!canPlan) {
    return {
      ok: true,
      status: 'luna_signal_policy_shadow_disabled',
      enabled: false,
      apply: options.apply,
      confirmRequired: CONFIRM_TOKEN,
      rows: [],
      summary: { liveMutation: false, productionGridChanged: false, written: 0 },
    };
  }

  const queryFn = deps.query || db.query;
  const runFn = deps.run || db.run;
  const config = signalPolicyConfigFromEnv(env);
  const policies = deps.policies || buildSignalPolicyCandidates(config);
  const sourceRows = options.fixture ? fixtureRows() : await loadCandidateRows(queryFn, options);
  const regimes = options.fixture ? fixtureRegimes() : await loadRegimes(queryFn, options.markets);
  const previousScores = options.fixture ? [] : await loadPreviousScores(queryFn, options.markets);
  const rows = evaluateSignalPolicyShadow({
    rows: sourceRows,
    policies,
    regimeByMarket: regimes,
    previousScores,
    config,
    observedAt: new Date(),
  });

  const canWrite = enabled && options.apply && options.confirm === CONFIRM_TOKEN && !options.dryRun;
  if (canWrite) {
    await ensureLunaSignalPolicyShadowTable(runFn);
    for (const row of rows) {
      await insertPolicyShadow(runFn, row);
      row.written = true;
    }
  }

  return {
    ok: true,
    status: canWrite ? 'luna_signal_policy_shadow_written' : 'luna_signal_policy_shadow_planned',
    enabled,
    apply: options.apply,
    dryRun: options.dryRun,
    fixture: options.fixture,
    confirmRequired: CONFIRM_TOKEN,
    summary: {
      sourceRows: sourceRows.length,
      policies: policies.length,
      rows: rows.length,
      written: rows.filter((row) => row.written).length,
      markets: [...new Set(rows.map((row) => row.market))],
      liveMutation: false,
      productionGridChanged: false,
    },
    rows,
  };
}

async function main() {
  const result = await runLunaSignalPolicyShadow(parseArgs());
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`${result.status} rows=${result.summary?.rows || 0} written=${result.summary?.written || 0}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: 'luna signal policy shadow error:',
  });
}
