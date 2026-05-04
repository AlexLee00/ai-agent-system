#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runDiscoveryTopNSmoke } from './discovery-top-n-smoke.ts';
import divergenceSmoke from './ta-divergence-detector-smoke.ts';
import chartPatternSmoke from './ta-chart-patterns-smoke.ts';
import supportResistanceSmoke from './ta-support-resistance-smoke.ts';
import maCrossSmoke from './ta-ma-cross-detector-smoke.ts';
import weightedVotingSmoke from './ta-weighted-voting-smoke.ts';
import { runSmoke as runMlPricePredictorSmoke } from './ml-price-predictor-smoke.ts';
import { runSmoke as runBullishEntrySmoke } from './ta-bullish-entry-conditions-smoke.ts';
import { runSmoke as runAdaptiveTunerSmoke } from './ta-weight-adaptive-tuner-smoke.ts';
import { runSmoke as runIntegratedScorerSmoke } from './ta-integrated-scorer-smoke.ts';

const PHASES = [
  ['tau1_top_n', runDiscoveryTopNSmoke],
  ['tau2_divergence', divergenceSmoke.runSmoke],
  ['tau2_chart_patterns', chartPatternSmoke.runSmoke],
  ['tau2_support_resistance', supportResistanceSmoke.runSmoke],
  ['tau3_ma_cross', maCrossSmoke.runSmoke],
  ['tau4_weighted_voting', weightedVotingSmoke.runSmoke],
  ['tau5_ml_shadow', runMlPricePredictorSmoke],
  ['tau6_bullish_entry', runBullishEntrySmoke],
  ['tau7_adaptive_tuner', runAdaptiveTunerSmoke],
  ['tau_integrated_scorer', runIntegratedScorerSmoke],
];

export async function runSmoke() {
  const results = [];
  for (const [name, run] of PHASES) {
    const result = await run();
    assert.equal(result?.ok, true, `${name} smoke must pass`);
    results.push({ name, ok: true });
  }
  return {
    ok: true,
    total: results.length,
    phases: results,
    contract: {
      topN: { domestic: 100, overseas: 100, crypto: 50 },
      weightedVotingThreshold: Number(process.env.LUNA_TA_WEIGHTED_VOTING_THRESHOLD || 0.6),
      bullishEntryScoreMin: Number(process.env.LUNA_TA_BULLISH_ENTRY_SCORE_MIN || 0.6),
      mlPredictorDefault: 'off_shadow',
    },
  };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`luna-technical-analysis-boost-smoke ok (${result.total}/${result.total})`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ luna-technical-analysis-boost-smoke 실패:' });
}
