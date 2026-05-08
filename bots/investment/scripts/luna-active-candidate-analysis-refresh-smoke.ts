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
  const finishedRuns = [];
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
    finishRun: async (sessionId, result) => {
      finishedRuns.push({ sessionId, result });
      return { updated: true, status: result?.status || 'completed' };
    },
    maxSymbols: 2,
    statePath: path.join(smokeDir, 'applied.json'),
    now,
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.applied, true);
  assert.equal(applied.finish.updated, true);
  assert.deepEqual(collectedSymbols, ['ENA/USDT', 'BNB/USDT']);
  assert.equal(applied.exchange, 'binance');
  assert.equal(finishedRuns[0].sessionId, 'smoke-session');
  assert.equal(finishedRuns[0].result.status, 'completed');
  assert.equal(finishedRuns[0].result.meta.decision_execution_skipped, true);

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
    finishRun: async (sessionId, result) => {
      finishedRuns.push({ sessionId, result });
      return { updated: true, status: result?.status || 'completed' };
    },
    statePath: path.join(smokeDir, 'domestic.json'),
    now,
  });
  assert.equal(domestic.ok, true);
  assert.equal(domestic.finish.updated, true);
  assert.equal(domestic.exchange, 'kis');
  assert.equal(domesticCollect.market, 'kis');
  assert.deepEqual(domesticCollect.symbols, ['005490']);
  assert.equal(domesticCollect.meta.decision_execution_skipped, true);
  assert.equal(finishedRuns[1].sessionId, 'domestic-session');

  const finishFailed = await runActiveCandidateAnalysisRefresh({
    apply: true,
    confirm: 'luna-active-candidate-analysis-refresh',
    reportBuilder: async () => fixtureReport(['ADA/USDT']),
    collectRunner: async () => ({
      sessionId: 'finish-failed-session',
      symbols: ['ADA/USDT'],
      summaries: [],
      metrics: { failedHardCoreTasks: 0, collectQuality: { status: 'ready' } },
    }),
    finishRun: async () => {
      throw new Error('pipeline finish unavailable');
    },
    statePath: path.join(smokeDir, 'finish-failed.json'),
    now,
  });
  assert.equal(finishFailed.ok, false);
  assert.equal(finishFailed.status, 'active_candidate_analysis_refresh_finish_failed');
  assert.equal(finishFailed.finish.reason, 'finish_pipeline_run_failed');

  const alreadyTerminal = await runActiveCandidateAnalysisRefresh({
    apply: true,
    confirm: 'luna-active-candidate-analysis-refresh',
    reportBuilder: async () => fixtureReport(['XRP/USDT']),
    collectRunner: async () => ({
      sessionId: 'already-terminal-session',
      symbols: ['XRP/USDT'],
      summaries: [],
      metrics: { failedHardCoreTasks: 0, collectQuality: { status: 'ready' } },
    }),
    finishRun: async () => ({ updated: false, reason: 'already_terminal', status: 'completed' }),
    statePath: path.join(smokeDir, 'already-terminal.json'),
    now,
  });
  assert.equal(alreadyTerminal.ok, true);
  assert.equal(alreadyTerminal.finish.reason, 'already_terminal');

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
