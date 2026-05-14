#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runLunaPredictiveEvidenceRefresh } from './runtime-luna-predictive-evidence-refresh.ts';
import { runCandidateBacktestRefresh } from './runtime-luna-candidate-backtest-refresh.ts';
import { __test as communityEvidenceTest, runCommunityEvidenceRefresh } from './runtime-luna-community-evidence-refresh.ts';

export async function runLunaPhase1EvidenceGapSmoke() {
  const backtest = await runCandidateBacktestRefresh({
    fixture: true,
    dryRun: true,
    json: true,
    periods: '30,90',
    limit: 2,
    market: 'all',
  });
  assert.equal(backtest.ok, true);
  assert.equal(backtest.market, 'all');
  assert.equal(backtest.total, 2);
  assert.equal(backtest.passed, 1);
  assert.equal(backtest.wouldBlocked, 1);

  const predictive = await runLunaPredictiveEvidenceRefresh({
    fixture: true,
    dryRun: true,
    json: true,
    limit: 2,
    market: 'all',
  });
  assert.equal(predictive.ok, true);
  assert.equal(predictive.total, 2);
  assert.equal(predictive.passed, 1);
  assert.equal(predictive.blocked, 1);
  assert.ok(predictive.results[0].componentCoverage >= 0.75);

  const community = await runCommunityEvidenceRefresh({
    fixture: true,
    dryRun: true,
    json: true,
    limit: 2,
  });
  assert.equal(community.ok, true);
  assert.equal(community.dryRun, true);
  assert.equal(community.collected, 2);
  assert.equal(community.inserted, 0);
  assert.equal(communityEvidenceTest.matchesKeyword('this is not financial advice', 'not'), false);
  assert.equal(communityEvidenceTest.matchesKeyword('NOT/USDT breakout with liquidity', 'not/usdt'), true);
  assert.deepEqual(communityEvidenceTest.keywordsForSymbol('NOT/USDT').includes('not'), false);

  return {
    ok: true,
    smoke: 'luna-phase1-evidence-gap',
    backtest: {
      total: backtest.total,
      passed: backtest.passed,
      wouldBlocked: backtest.wouldBlocked,
      market: backtest.market,
    },
    predictive: {
      total: predictive.total,
      passed: predictive.passed,
      blocked: predictive.blocked,
      minCoverage: Math.min(...predictive.results.map((row) => Number(row.componentCoverage || 0))),
    },
    community: {
      collected: community.collected,
      inserted: community.inserted,
    },
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: runLunaPhase1EvidenceGapSmoke,
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: 'luna-phase1-evidence-gap-smoke error:',
  });
}
