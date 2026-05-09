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

function fixtureReport(symbols = [], top = []) {
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
    top,
  };
}

function fixtureFilteredCandidate(symbol, reasons = ['sentiment_not_confirmed', 'onchain_not_confirmed']) {
  return {
    symbol,
    exchange: 'binance',
    actionability: 'filtered_before_signal',
    recommendation: 'wait_for_onchain_confirmation',
    reasons,
    fused: { recommendation: 'LONG', fusedScore: 0.62, averageConfidence: 0.62, hasConflict: false },
    analystSummary: {
      byAnalyst: {
        ta_mtf: { signal: 'BUY', confidence: 0.62, reasoning: 'technical presignal' },
      },
    },
  };
}

function fixtureLowConfidenceCandidate(symbol, reasons = ['sentiment_not_confirmed', 'onchain_not_confirmed']) {
  return {
    ...fixtureFilteredCandidate(symbol, reasons),
    fused: { recommendation: 'LONG', fusedScore: 0.42, averageConfidence: 0.42, hasConflict: false },
    analystSummary: {
      byAnalyst: {
        ta_mtf: { signal: 'BUY', confidence: 0.42, reasoning: 'weak technical presignal' },
      },
    },
  };
}

function fixtureHighPriorityCandidate(symbol, reasons = ['sentiment_not_confirmed', 'onchain_not_confirmed']) {
  return {
    symbol,
    exchange: 'binance',
    actionability: 'filtered_before_signal',
    recommendation: 'collect_missing_analysts',
    reasons,
    activeCandidate: {
      rank: 1,
      score: 0.84,
      confidence: 0.84,
      source: 'candidate_universe',
      reasonCode: 'binance_momentum',
    },
    fused: { recommendation: 'HOLD', fusedScore: 0.08, averageConfidence: 0.12, hasConflict: false },
    analystSummary: {
      byAnalyst: {
        ta_mtf: { signal: 'HOLD', confidence: 0.12, reasoning: 'daily bullish, intraday not confirmed yet' },
      },
    },
  };
}

function fixtureRelaxedProbeCandidate(symbol, reasons = ['fusion_not_long', 'sentiment_not_confirmed', 'onchain_not_confirmed']) {
  return {
    ...fixtureFilteredCandidate(symbol, reasons),
    actionability: 'relaxed_probe_candidate',
    recommendation: 'run_l13_probe_with_reduced_sizing',
    relaxation: {
      ok: true,
      reason: 'crypto_relaxed_mtf_momentum_probe',
      sizeRatio: 0.25,
    },
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

  const enrichmentPlan = buildActiveCandidateAnalysisRefreshPlan({
    report: fixtureReport([], [
      fixtureFilteredCandidate('EDEN/USDT'),
      fixtureFilteredCandidate('BANANAS31/USDT', ['sentiment_not_confirmed']),
    ]),
    state: {},
    now,
    maxSymbols: 1,
    maxEnrichmentSymbols: 2,
    cooldownMinutes: 45,
    exchange: 'binance',
  });
  assert.equal(enrichmentPlan.status, 'active_candidate_analysis_refresh_needed');
  assert.deepEqual(enrichmentPlan.selected, []);
  assert.deepEqual(enrichmentPlan.targetedEnrichment.selectedSymbols, ['EDEN/USDT', 'BANANAS31/USDT']);
  assert.deepEqual(enrichmentPlan.targetedEnrichment.nodeIds, ['L03', 'L05']);

  const qualityFilteredPlan = buildActiveCandidateAnalysisRefreshPlan({
    report: fixtureReport([], [
      fixtureLowConfidenceCandidate('WEAK/USDT'),
    ]),
    state: {},
    now,
    maxSymbols: 1,
    maxEnrichmentSymbols: 2,
    cooldownMinutes: 45,
    exchange: 'binance',
  });
  assert.equal(qualityFilteredPlan.status, 'active_candidate_analysis_refresh_clear');
  assert.equal(qualityFilteredPlan.targetedEnrichment.status, 'targeted_enrichment_quality_filtered');
  assert.equal(qualityFilteredPlan.targetedEnrichment.skippedQuality[0].symbol, 'WEAK/USDT');

  const highPriorityPlan = buildActiveCandidateAnalysisRefreshPlan({
    report: fixtureReport([], [
      fixtureHighPriorityCandidate('SAHARA/USDT'),
    ]),
    state: {},
    now,
    maxSymbols: 1,
    maxEnrichmentSymbols: 1,
    cooldownMinutes: 45,
    exchange: 'binance',
  });
  assert.equal(highPriorityPlan.status, 'active_candidate_analysis_refresh_clear');
  assert.deepEqual(highPriorityPlan.targetedEnrichment.selectedSymbols, []);
  assert.equal(highPriorityPlan.targetedEnrichment.requireTechnicalPresignal, true);

  const dailyBullishHighPriorityPlan = buildActiveCandidateAnalysisRefreshPlan({
    report: fixtureReport([], [
      {
        ...fixtureHighPriorityCandidate('SAHARA/USDT'),
        dailyTechnical: {
          symbol: 'SAHARA/USDT',
          ok: true,
          reason: 'daily_trend_bullish',
          source: 'binance_ohlcv_daily_for_tradingview_guard',
          providerMode: 'binance_ohlcv',
          bars: 90,
        },
      },
    ]),
    state: {},
    now,
    maxSymbols: 1,
    maxEnrichmentSymbols: 1,
    cooldownMinutes: 45,
    exchange: 'binance',
  });
  assert.equal(dailyBullishHighPriorityPlan.status, 'active_candidate_analysis_refresh_needed');
  assert.deepEqual(dailyBullishHighPriorityPlan.targetedEnrichment.selectedSymbols, ['SAHARA/USDT']);
  assert.equal(dailyBullishHighPriorityPlan.targetedEnrichment.selected[0].technicalPresignal, 'daily_technical_bullish');

  const dailyBullishAlreadyAnalyzedPlan = buildActiveCandidateAnalysisRefreshPlan({
    report: fixtureReport([], [
      {
        ...fixtureHighPriorityCandidate('SAHARA/USDT'),
        analystSummary: {
          byAnalyst: {
            ta_mtf: { signal: 'HOLD', confidence: 0.12 },
            onchain: { signal: 'HOLD', confidence: 0.3 },
            sentiment: { signal: 'HOLD', confidence: 0.4 },
          },
        },
        dailyTechnical: {
          symbol: 'SAHARA/USDT',
          ok: true,
          reason: 'daily_trend_bullish',
          source: 'binance_ohlcv_daily_for_tradingview_guard',
        },
      },
    ]),
    state: {},
    now,
    maxSymbols: 1,
    maxEnrichmentSymbols: 1,
    cooldownMinutes: 45,
    exchange: 'binance',
  });
  assert.equal(dailyBullishAlreadyAnalyzedPlan.status, 'active_candidate_analysis_refresh_clear');
  assert.deepEqual(dailyBullishAlreadyAnalyzedPlan.targetedEnrichment.selectedSymbols, []);
  assert.deepEqual(dailyBullishAlreadyAnalyzedPlan.targetedEnrichment.nodeIds, []);

  const highPriorityOverridePlan = buildActiveCandidateAnalysisRefreshPlan({
    report: fixtureReport([], [
      fixtureHighPriorityCandidate('SAHARA/USDT'),
    ]),
    state: {},
    now,
    maxSymbols: 1,
    maxEnrichmentSymbols: 1,
    cooldownMinutes: 45,
    exchange: 'binance',
    env: {
      LUNA_CRYPTO_TARGETED_ENRICHMENT_REQUIRE_TECHNICAL_PRESIGNAL: 'false',
    },
  });
  assert.equal(highPriorityOverridePlan.status, 'active_candidate_analysis_refresh_needed');
  assert.deepEqual(highPriorityOverridePlan.targetedEnrichment.selectedSymbols, ['SAHARA/USDT']);
  assert.equal(highPriorityOverridePlan.targetedEnrichment.requireTechnicalPresignal, false);

  const stockHighPriorityPlan = buildActiveCandidateAnalysisRefreshPlan({
    report: fixtureReport([], [
      { ...fixtureHighPriorityCandidate('NVDA'), exchange: 'kis_overseas' },
    ]),
    state: {},
    now,
    maxSymbols: 1,
    maxEnrichmentSymbols: 1,
    cooldownMinutes: 45,
    exchange: 'kis_overseas',
  });
  assert.equal(stockHighPriorityPlan.status, 'active_candidate_analysis_refresh_needed');
  assert.deepEqual(stockHighPriorityPlan.targetedEnrichment.selectedSymbols, ['NVDA']);
  assert.equal(stockHighPriorityPlan.targetedEnrichment.requireTechnicalPresignal, false);

  const highPriorityTechnicalPlan = buildActiveCandidateAnalysisRefreshPlan({
    report: fixtureReport([], [
      fixtureFilteredCandidate('SAHARA/USDT'),
    ]),
    state: {},
    now,
    maxSymbols: 1,
    maxEnrichmentSymbols: 1,
    cooldownMinutes: 45,
    exchange: 'binance',
  });
  assert.equal(highPriorityTechnicalPlan.status, 'active_candidate_analysis_refresh_needed');
  assert.deepEqual(highPriorityTechnicalPlan.targetedEnrichment.selectedSymbols, ['SAHARA/USDT']);
  assert.deepEqual(highPriorityTechnicalPlan.targetedEnrichment.nodeIds, ['L03', 'L05']);

  const globalCooldownPlan = buildActiveCandidateAnalysisRefreshPlan({
    report: fixtureReport([], [
      fixtureFilteredCandidate('EDEN/USDT'),
      fixtureFilteredCandidate('BANANAS31/USDT'),
    ]),
    state: {
      symbols: {
        'binance:targeted_enrichment:__global__': { lastAttemptAt: '2026-05-06T23:30:00.000Z' },
      },
    },
    now,
    maxSymbols: 1,
    maxEnrichmentSymbols: 2,
    cooldownMinutes: 45,
    targetedCooldownMinutes: 120,
    globalCooldownEnabled: false,
    exchange: 'binance',
  });
  assert.equal(globalCooldownPlan.status, 'active_candidate_analysis_refresh_needed');
  assert.equal(globalCooldownPlan.targetedEnrichment.status, 'targeted_enrichment_needed');
  assert.equal(globalCooldownPlan.targetedEnrichment.globalCooldown.cooldownMinutes, 120);
  assert.equal(globalCooldownPlan.targetedEnrichment.globalCooldownEnabled, false);
  assert.deepEqual(globalCooldownPlan.targetedEnrichment.selectedSymbols, ['EDEN/USDT', 'BANANAS31/USDT']);

  const globalCooldownBlockedPlan = buildActiveCandidateAnalysisRefreshPlan({
    report: fixtureReport([], [
      fixtureFilteredCandidate('EDEN/USDT'),
      fixtureFilteredCandidate('BANANAS31/USDT'),
    ]),
    state: {
      symbols: {
        'binance:targeted_enrichment:__global__': { lastAttemptAt: '2026-05-06T23:30:00.000Z' },
      },
    },
    now,
    maxSymbols: 1,
    maxEnrichmentSymbols: 2,
    cooldownMinutes: 45,
    targetedCooldownMinutes: 120,
    globalCooldownBypassMaxSymbols: 0,
    globalCooldownEnabled: true,
    exchange: 'binance',
  });
  assert.equal(globalCooldownBlockedPlan.status, 'active_candidate_analysis_refresh_clear');
  assert.equal(globalCooldownBlockedPlan.targetedEnrichment.status, 'targeted_enrichment_cooldown');
  assert.equal(globalCooldownBlockedPlan.targetedEnrichment.skippedCooldown[0].scope, 'market_global');

  const globalCooldownLimitedBypassPlan = buildActiveCandidateAnalysisRefreshPlan({
    report: fixtureReport([], [
      fixtureFilteredCandidate('EDEN/USDT'),
      fixtureFilteredCandidate('BANANAS31/USDT'),
    ]),
    state: {
      symbols: {
        'binance:targeted_enrichment:__global__': { lastAttemptAt: '2026-05-06T23:30:00.000Z' },
      },
    },
    now,
    maxSymbols: 1,
    maxEnrichmentSymbols: 2,
    cooldownMinutes: 45,
    targetedCooldownMinutes: 120,
    globalCooldownBypassMaxSymbols: 1,
    globalCooldownEnabled: true,
    exchange: 'binance',
  });
  assert.equal(globalCooldownLimitedBypassPlan.status, 'active_candidate_analysis_refresh_needed');
  assert.deepEqual(globalCooldownLimitedBypassPlan.targetedEnrichment.selectedSymbols, ['EDEN/USDT']);
  assert.equal(globalCooldownLimitedBypassPlan.targetedEnrichment.globalCooldownBypassed, 1);
  assert.equal(globalCooldownLimitedBypassPlan.targetedEnrichment.selected[0].globalCooldownBypassed, true);

  const cooldownBypassPlan = buildActiveCandidateAnalysisRefreshPlan({
    report: fixtureReport([], [
      fixtureRelaxedProbeCandidate('DYM/USDT'),
      fixtureRelaxedProbeCandidate('REZ/USDT'),
    ]),
    state: {
      symbols: {
        'binance:targeted_enrichment:DYM/USDT': { lastAttemptAt: '2026-05-06T23:45:00.000Z' },
        'binance:targeted_enrichment:REZ/USDT': { lastAttemptAt: '2026-05-06T23:58:00.000Z' },
      },
    },
    now,
    maxSymbols: 1,
    maxEnrichmentSymbols: 2,
    cooldownMinutes: 45,
    targetedCooldownMinutes: 45,
    cooldownBypassMinMinutes: 10,
    cooldownBypassMaxSymbols: 1,
    exchange: 'binance',
  });
  assert.equal(cooldownBypassPlan.status, 'active_candidate_analysis_refresh_needed');
  assert.deepEqual(cooldownBypassPlan.targetedEnrichment.selectedSymbols, ['DYM/USDT']);
  assert.equal(cooldownBypassPlan.targetedEnrichment.cooldownBypassed, 1);
  assert.deepEqual(cooldownBypassPlan.targetedEnrichment.cooldownBypassedSymbols, ['DYM/USDT']);
  assert.equal(cooldownBypassPlan.targetedEnrichment.skippedCooldown[0].symbol, 'REZ/USDT');

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

  let defaultHours = null;
  const dryRunDefaultHours = await runActiveCandidateAnalysisRefresh({
    reportBuilder: async ({ hours }) => {
      defaultHours = hours;
      return fixtureReport(['STALE/USDT']);
    },
    statePath: path.join(smokeDir, 'default-hours.json'),
    now,
  });
  assert.equal(dryRunDefaultHours.ok, true);
  assert.equal(dryRunDefaultHours.status, 'active_candidate_analysis_refresh_needed');
  assert.equal(defaultHours, 2, 'refresh freshness window should match decision filter default');

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
  const appliedState = JSON.parse(fs.readFileSync(path.join(smokeDir, 'applied.json'), 'utf8'));
  assert.equal(appliedState.symbols['binance:analysis:ENA/USDT'].lastStatus, 'ok');
  assert.equal(appliedState.symbols['binance:analysis:BNB/USDT'].lastOutcome, 'ready');

  const collectCalls = [];
  const targeted = await runActiveCandidateAnalysisRefresh({
    apply: true,
    confirm: 'luna-active-candidate-analysis-refresh',
    reportBuilder: async () => fixtureReport([], [
      fixtureFilteredCandidate('EDEN/USDT'),
      fixtureFilteredCandidate('BANANAS31/USDT', ['sentiment_not_confirmed']),
    ]),
    collectRunner: async ({ symbols, meta, triggerType }) => {
      collectCalls.push({ symbols, meta, triggerType });
      assert.equal(triggerType, 'active_candidate_targeted_enrichment');
      assert.equal(meta.targeted_enrichment, true);
      assert.equal(meta.collect_mode, 'active_candidate_targeted_enrichment');
      assert.deepEqual(meta.agentPlan.collect.nodeIds, ['L03', 'L05']);
      assert.equal(meta.llm_call_policy.source_enrichment, 'targeted_top_n_only');
      assert.equal(meta.llm_call_policy.targeted_enrichment_cooldown_minutes, 120);
      assert.equal(meta.llm_call_policy.targeted_enrichment_min_confidence, 0.58);
      return {
        sessionId: 'targeted-session',
        symbols,
        summaries: symbols.flatMap((symbol) => ['L03', 'L05'].map((nodeId) => ({ nodeId, status: 'completed', symbol }))),
        metrics: { failedHardCoreTasks: 0, collectQuality: { status: 'ready' } },
      };
    },
    finishRun: async (sessionId, result) => {
      finishedRuns.push({ sessionId, result });
      return { updated: true, status: result?.status || 'completed' };
    },
    maxEnrichmentSymbols: 2,
    statePath: path.join(smokeDir, 'targeted.json'),
    now,
  });
  assert.equal(targeted.ok, true);
  assert.equal(targeted.collect, null);
  assert.equal(targeted.targetedEnrichmentCollect.sessionId, 'targeted-session');
  assert.deepEqual(collectCalls[0].symbols, ['EDEN/USDT', 'BANANAS31/USDT']);
  assert.equal(targeted.collectRuns[0].purpose, 'targeted_enrichment');
  const targetedState = JSON.parse(fs.readFileSync(path.join(smokeDir, 'targeted.json'), 'utf8'));
  assert.equal(targetedState.symbols['binance:targeted_enrichment:EDEN/USDT'].lastStatus, 'ok');
  assert.equal(targetedState.symbols['binance:targeted_enrichment:__global__'].lastStatus, 'ok');

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
  assert.equal(finishedRuns.some((run) => run.sessionId === 'domestic-session'), true);
  const domesticState = JSON.parse(fs.readFileSync(path.join(smokeDir, 'domestic.json'), 'utf8'));
  assert.equal(domesticState.symbols['kis:analysis:005490'].lastStatus, 'ok');

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
