#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildSignalPolicyCandidates,
  evaluateSignalPolicyShadow,
  signalPolicyConfigFromEnv,
} from '../shared/luna-signal-robust-learning.ts';
import { runLunaSignalPolicyShadow } from './runtime-luna-signal-policy-shadow.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function rows() {
  return [
    {
      symbol: 'OVERFIT/USDT',
      market: 'crypto',
      healthy: false,
      sharpe_is: 6.6,
      sharpe_oos: -1.4,
      overfit_gap: 8.0,
      selection_method: 'walk_forward',
      oos_status: 'ok',
      trial_sharpes: [6.6, 1.1, 0.8, -0.2],
      trial_oos_sharpes: [-1.4, 0.4, 0.6, -0.1],
    },
    {
      symbol: 'STABLE/USDT',
      market: 'crypto',
      healthy: true,
      sharpe_is: 1.4,
      sharpe_oos: 1.1,
      overfit_gap: 0.3,
      selection_method: 'walk_forward',
      oos_status: 'ok',
      trial_sharpes: [1.4, 1.3, 1.2, 0.9],
      trial_oos_sharpes: [1.1, 1.0, 0.9, 0.4],
    },
    {
      symbol: 'NOOOS/USDT',
      market: 'crypto',
      healthy: true,
      sharpe_is: 1.2,
      sharpe_oos: null,
      overfit_gap: null,
      selection_method: null,
      oos_status: null,
      trial_sharpes: [1.2, 1.1],
    },
  ];
}

export async function runLunaSignalPolicyShadowSmoke() {
  const investmentRoot = path.resolve(import.meta.dirname, '..');
  const migration = fs.readFileSync(path.join(investmentRoot, 'migrations/20260601000003_luna_signal_policy_shadow.sql'), 'utf8');
  const bootstrap = fs.readFileSync(path.join(investmentRoot, 'shared/db/schema/tables/bootstrap.ts'), 'utf8');
  assert.match(migration, /luna_signal_policy_shadow/);
  assert.match(migration, /policy_config/);
  assert.match(migration, /score_delta/);
  assert.match(bootstrap, /luna_signal_policy_shadow/);

  const config = signalPolicyConfigFromEnv({
    LUNA_SIGNAL_ENSEMBLE_SIZES: '1,3',
    LUNA_SIGNAL_GAP_PENALTY_WEIGHTS: '0,0.5',
    LUNA_SIGNAL_REGIME_MODES: 'none,trend_filter',
    LUNA_SIGNAL_POLICY_MAX_VARIANTS: '8',
    LUNA_SIGNAL_POLICY_MIN_SAMPLES: '1',
  });
  const policies = buildSignalPolicyCandidates(config);
  assert.equal(policies.length, 8);

  const evaluated = evaluateSignalPolicyShadow({
    rows: rows(),
    policies,
    regimeByMarket: { crypto: { llm_regime: 'trending_bull', llm_confidence: 0.7 } },
    config,
  });
  assert.equal(evaluated.length, 8);
  const baseline = evaluated.find((row) => row.policyName === 'ensemble1_gap0_none');
  const gapPenalty = evaluated.find((row) => row.policyName === 'ensemble1_gap0p5_none');
  const ensemble = evaluated.find((row) => row.policyName === 'ensemble3_gap0p5_none');
  assert.ok(baseline.sampleCount === 2, 'missing OOS rows must be excluded from scoring');
  assert.ok(gapPenalty.score < baseline.score, 'gap penalty should reduce overfit-heavy policy score');
  assert.ok(ensemble.score > gapPenalty.score, 'ensemble top-N should reduce single-trial overfit penalty');

  const unsupportedEnsemble = evaluateSignalPolicyShadow({
    rows: rows().map((row) => {
      const { trial_oos_sharpes: _trialOosSharpes, ...rest } = row;
      return rest;
    }),
    policies: policies.filter((policy) => policy.config.ensembleSize === 3),
    regimeByMarket: { crypto: { llm_regime: 'trending_bull', llm_confidence: 0.7 } },
    config,
  });
  assert.ok(
    unsupportedEnsemble.every((row) => row.componentScores.skippedReasons.unsupported_ensemble_missing_trial_oos >= 1),
    'ensemble policies without per-trial OOS evidence should be marked unsupported',
  );

  const rangeFiltered = evaluateSignalPolicyShadow({
    rows: rows(),
    policies: policies.filter((policy) => policy.name.endsWith('trend_filter')),
    regimeByMarket: { crypto: { llm_regime: 'range_bound', llm_confidence: 0.8 } },
    config,
  });
  assert.ok(rangeFiltered.every((row) => row.sampleCount === 0), 'trend filter should skip non-trend regime samples');

  const dryDeps = {
    query: async () => {
      throw new Error('dry fixture should not query DB');
    },
    run: async () => {
      throw new Error('dry fixture should not write DB');
    },
    env: {
      LUNA_SIGNAL_LEARNING_ENABLED: 'false',
      LUNA_SIGNAL_ENSEMBLE_SIZES: '1,3',
      LUNA_SIGNAL_GAP_PENALTY_WEIGHTS: '0,0.5',
      LUNA_SIGNAL_REGIME_MODES: 'none',
      LUNA_SIGNAL_POLICY_MAX_VARIANTS: '4',
      LUNA_SIGNAL_POLICY_MIN_SAMPLES: '1',
    },
  };
  const planned = await runLunaSignalPolicyShadow({
    dryRun: true,
    fixture: true,
    apply: false,
    confirm: '',
    markets: ['crypto'],
    limit: 10,
    hours: 24,
  }, dryDeps);
  assert.equal(planned.status, 'luna_signal_policy_shadow_planned');
  assert.equal(planned.summary.written, 0);
  assert.equal(planned.summary.liveMutation, false);
  assert.equal(planned.summary.productionGridChanged, false);

  const writes = [];
  const applyDeps = {
    query: async () => [],
    run: async (sql, params) => {
      writes.push({ sql, params });
      return { rowCount: 1 };
    },
    env: {
      LUNA_SIGNAL_LEARNING_ENABLED: 'true',
      LUNA_SIGNAL_ENSEMBLE_SIZES: '1',
      LUNA_SIGNAL_GAP_PENALTY_WEIGHTS: '0',
      LUNA_SIGNAL_REGIME_MODES: 'none',
      LUNA_SIGNAL_POLICY_MAX_VARIANTS: '1',
      LUNA_SIGNAL_POLICY_MIN_SAMPLES: '1',
    },
  };
  const written = await runLunaSignalPolicyShadow({
    dryRun: false,
    fixture: true,
    apply: true,
    confirm: 'luna-signal-policy-shadow',
    markets: ['crypto'],
    limit: 10,
    hours: 24,
  }, applyDeps);
  assert.equal(written.status, 'luna_signal_policy_shadow_planned');
  assert.equal(written.summary.written, 0);
  assert.equal(writes.length, 0, 'fixture mode must never write to the real shadow table');
  assert.equal(writes.some((item) => String(item.sql).includes('INSERT INTO luna_signal_policy_shadow')), false);

  const realWrites = [];
  const realWriteDeps = {
    query: async (sql) => {
      if (String(sql).includes('FROM candidate_backtest_status')) return rows();
      if (String(sql).includes('FROM luna_regime_llm_shadow')) return [{ market: 'crypto', llm_regime: 'trending_bull', llm_confidence: 0.7 }];
      if (String(sql).includes('FROM luna_signal_policy_shadow')) return [];
      return [];
    },
    run: async (sql, params) => {
      realWrites.push({ sql, params });
      return { rowCount: 1 };
    },
    env: applyDeps.env,
  };
  const realWritten = await runLunaSignalPolicyShadow({
    dryRun: false,
    fixture: false,
    apply: true,
    confirm: 'luna-signal-policy-shadow',
    markets: ['crypto'],
    limit: 10,
    hours: 24,
  }, realWriteDeps);
  assert.equal(realWritten.status, 'luna_signal_policy_shadow_written');
  assert.equal(realWritten.summary.written, 1);
  assert.ok(realWrites.some((item) => String(item.sql).includes('CREATE TABLE IF NOT EXISTS luna_signal_policy_shadow')));
  assert.ok(realWrites.some((item) => String(item.sql).includes('INSERT INTO luna_signal_policy_shadow')));

  return {
    ok: true,
    smoke: 'luna-signal-policy-shadow',
    policies: policies.length,
    plannedRows: planned.summary.rows,
    fixtureWrittenRows: written.summary.written,
    writtenRows: realWritten.summary.written,
    baselineScore: baseline.score,
    gapPenaltyScore: gapPenalty.score,
    ensembleScore: ensemble.score,
  };
}

async function main() {
  const result = await runLunaSignalPolicyShadowSmoke();
  console.log(JSON.stringify(result, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: 'luna signal policy shadow smoke failed:',
  });
}
