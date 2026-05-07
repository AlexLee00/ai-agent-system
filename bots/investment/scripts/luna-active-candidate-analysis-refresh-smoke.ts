#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildActiveCandidateAnalysisRefreshPlan,
  runActiveCandidateAnalysisRefresh,
} from './runtime-luna-active-candidate-analysis-refresh.ts';

function fixtureReport(symbols = []) {
  return {
    ok: true,
    status: symbols.length ? 'luna_decision_filter_attention' : 'luna_decision_filter_clear',
    activeCandidateCoverage: {
      total: symbols.length,
      checked: 0,
      missing: symbols.length,
    },
    missingActiveCandidateSymbols: symbols,
    bottlenecks: symbols.length ? ['active_candidate_analysis_missing'] : [],
  };
}

export async function runLunaActiveCandidateAnalysisRefreshSmoke() {
  const now = new Date('2026-05-07T00:00:00.000Z');
  const smokeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-active-candidate-refresh-smoke-'));
  const plan = buildActiveCandidateAnalysisRefreshPlan({
    report: fixtureReport(['ENA/USDT', 'HMSTR/USDT', 'TIA/USDT']),
    state: {
      symbols: {
        'binance:HMSTR/USDT': { lastAttemptAt: '2026-05-06T23:30:00.000Z' },
      },
    },
    now,
    maxSymbols: 1,
    cooldownMinutes: 45,
    exchange: 'binance',
  });

  assert.equal(plan.status, 'active_candidate_analysis_refresh_needed');
  assert.deepEqual(plan.selected, ['ENA/USDT']);
  assert.equal(plan.skippedCooldown[0].symbol, 'HMSTR/USDT');

  const blocked = await runActiveCandidateAnalysisRefresh({
    apply: true,
    confirm: null,
    reportBuilder: async () => fixtureReport(['ENA/USDT']),
    collectRunner: async () => {
      throw new Error('collect must not run without confirm');
    },
    statePath: path.join(smokeDir, 'blocked.json'),
    now,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 'active_candidate_analysis_refresh_confirm_required');

  let collectedSymbols = null;
  const applied = await runActiveCandidateAnalysisRefresh({
    apply: true,
    confirm: 'luna-active-candidate-analysis-refresh',
    reportBuilder: async () => fixtureReport(['ENA/USDT', 'BNB/USDT']),
    collectRunner: async ({ symbols, meta }) => {
      collectedSymbols = symbols;
      assert.equal(meta.decision_execution_skipped, true);
      return {
        sessionId: 'smoke-session',
        symbols,
        summaries: symbols.map((symbol) => ({ nodeId: 'L02', status: 'completed', symbol })),
        metrics: { failedHardCoreTasks: 0, collectQuality: { status: 'ready' } },
      };
    },
    maxSymbols: 2,
    statePath: path.join(smokeDir, 'applied.json'),
    now,
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.applied, true);
  assert.deepEqual(collectedSymbols, ['ENA/USDT', 'BNB/USDT']);
  assert.equal(applied.exchange, 'binance');

  let domesticCollect = null;
  const domestic = await runActiveCandidateAnalysisRefresh({
    market: 'domestic',
    apply: true,
    confirm: 'luna-active-candidate-analysis-refresh',
    reportBuilder: async () => fixtureReport(['005490']),
    collectRunner: async ({ market, symbols, meta }) => {
      domesticCollect = { market, symbols, meta };
      return {
        sessionId: 'domestic-session',
        symbols,
        summaries: [{ nodeId: 'L02', status: 'completed', symbol: '005490' }],
        metrics: { failedHardCoreTasks: 0, collectQuality: { status: 'ready' } },
      };
    },
    statePath: path.join(smokeDir, 'domestic.json'),
    now,
  });
  assert.equal(domestic.ok, true);
  assert.equal(domestic.exchange, 'kis');
  assert.equal(domesticCollect.market, 'kis');
  assert.deepEqual(domesticCollect.symbols, ['005490']);
  assert.equal(domesticCollect.meta.decision_execution_skipped, true);

  return {
    ok: true,
    smoke: 'luna-active-candidate-analysis-refresh',
    selected: plan.selected,
    skippedCooldown: plan.skippedCooldown.length,
  };
}

async function main() {
  const result = await runLunaActiveCandidateAnalysisRefreshSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna-active-candidate-analysis-refresh-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna-active-candidate-analysis-refresh-smoke 실패:',
  });
}
