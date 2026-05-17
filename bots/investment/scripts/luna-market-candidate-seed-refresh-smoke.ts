#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildLunaMarketCandidateSeedPlan,
  fixtureLunaMarketCandidateSeedEvents,
} from '../shared/luna-market-candidate-seed-refresh.ts';
import {
  CONFIRM,
  runLunaMarketCandidateSeedRefresh,
} from './runtime-luna-market-candidate-seed-refresh.ts';

async function expectRejectsApplyDryRun() {
  await assert.rejects(
    () => runLunaMarketCandidateSeedRefresh({
      fixture: true,
      apply: true,
      dryRun: true,
      confirm: CONFIRM,
      json: true,
    }),
    /cannot combine --apply with --dry-run/,
  );
}

async function expectRejectsMissingConfirm() {
  await assert.rejects(
    () => runLunaMarketCandidateSeedRefresh({
      fixture: true,
      apply: true,
      json: true,
    }),
    /requires --confirm=luna-market-candidate-seed-refresh/,
  );
}

export async function runLunaMarketCandidateSeedRefreshSmoke() {
  const fixtureEvents = fixtureLunaMarketCandidateSeedEvents();
  const plan = buildLunaMarketCandidateSeedPlan({
    events: fixtureEvents,
    markets: ['domestic', 'overseas'],
    limit: 3,
  });
  assert.equal(plan.ok, true, 'fixture plan passes');
  assert.equal(plan.shadowOnly, true, 'shadow-only plan');
  assert.equal(plan.liveMutation, false, 'no live mutation');
  assert.equal(plan.summary.passMarkets, 2, 'both stock markets pass');
  assert.equal(plan.summary.plannedSignals, 6, 'limit applies per market');
  assert.ok(plan.markets.find((market) => market.market === 'domestic')?.signals.some((signal) => signal.symbol === '005930'));
  assert.ok(plan.markets.find((market) => market.market === 'overseas')?.signals.some((signal) => signal.symbol === 'NVDA'));

  await expectRejectsApplyDryRun();
  await expectRejectsMissingConfirm();

  let appliedPlan = null;
  const runtime = await runLunaMarketCandidateSeedRefresh({
    fixture: true,
    apply: true,
    confirm: CONFIRM,
    json: true,
    limit: 2,
  }, {
    applySignals: async (candidatePlan) => {
      appliedPlan = candidatePlan;
      return {
        domestic: { inserted: 2, updated: 0 },
        overseas: { inserted: 2, updated: 0 },
      };
    },
  });
  assert.equal(runtime.apply, true, 'runtime apply mode');
  assert.equal(runtime.dryRun, false, 'runtime apply is not dry-run');
  assert.equal(runtime.summary.plannedSignals, 4, 'runtime limit applies');
  assert.equal(appliedPlan?.summary?.plannedSignals, 4, 'apply receives plan');
  assert.deepEqual(runtime.writeResult.domestic, { inserted: 2, updated: 0 });

  return {
    ok: true,
    smoke: 'luna-market-candidate-seed-refresh',
    checks: {
      markets: plan.summary.markets,
      plannedSignals: plan.summary.plannedSignals,
      applyDryRunRejected: true,
      missingConfirmRejected: true,
      liveMutation: false,
    },
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: runLunaMarketCandidateSeedRefreshSmoke,
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: 'luna-market-candidate-seed-refresh-smoke error:',
  });
}
