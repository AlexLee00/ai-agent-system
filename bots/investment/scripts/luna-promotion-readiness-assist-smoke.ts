#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildLunaPromotionReadinessAssistPlan,
  CONFIRM,
  runLunaPromotionReadinessAssistShadow,
} from './runtime-luna-promotion-readiness-assist-shadow.ts';

function fixtureGateReport() {
  const target = (symbol, promotionBlockerClass, readinessScore, extra = {}) => ({
    symbol,
    market: extra.market || 'crypto',
    exchange: extra.exchange || 'binance',
    readinessScore,
    promotionBlockerClass,
    cyclesRemaining: extra.cyclesRemaining ?? 0,
    consecutivePassesRemaining: extra.consecutivePassesRemaining ?? 0,
    confidenceGap: extra.confidenceGap ?? 0,
    blockReasons: extra.blockReasons || [],
    nextRequiredEvidence: extra.nextRequiredEvidence || [{ type: promotionBlockerClass }],
  });
  return {
    ok: true,
    status: 'luna_paper_promotion_gate_shadow_ready',
    summary: {
      totalSymbols: 5,
      promotionCandidates: 0,
      nearReady: 4,
      liveMutation: false,
    },
    readinessSummary: {
      nearReady: 4,
      nextPaperCycleTargets: [
        target('AAA/USDT', 'confidence', 0.96, {
          confidenceGap: 0.04,
          blockReasons: ['avg_confidence_below_promotion_floor'],
        }),
        target('BBB/USDT', 'paper_cycles', 0.88, {
          cyclesRemaining: 1,
          consecutivePassesRemaining: 1,
          blockReasons: ['insufficient_shadow_cycles', 'insufficient_consecutive_paper_passes'],
        }),
        target('CCC/USDT', 'strategy_or_backtest_quality', 0.8, {
          blockReasons: ['unrealistic_sharpe_seen'],
        }),
        target('DDD/USDT', 'risk_quality', 0.62, {
          blockReasons: ['candidate_bottleneck_hard_hold_seen'],
        }),
      ],
      liveMutation: false,
    },
    items: [],
  };
}

export async function runLunaPromotionReadinessAssistSmoke() {
  const plan = buildLunaPromotionReadinessAssistPlan(fixtureGateReport(), {
    market: 'all',
    hours: 168,
    limit: 50,
    maxTargets: 4,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.selectedTargets.length, 4);
  assert.equal(plan.actionSummary.backtestSymbols.includes('CCC/USDT'), true);
  assert.equal(plan.actionSummary.byAction.predictive_evidence_refresh, 1);
  assert.equal(plan.actionSummary.byAction.candidate_backtest_refresh, 1);
  assert.equal(plan.actionSummary.byAction.candidate_quality_governance_shadow, 1);
  assert.deepEqual(plan.actionSummary.predictiveSymbols, ['AAA/USDT']);
  assert.deepEqual(plan.actionSummary.strategySymbols, ['CCC/USDT']);
  assert.deepEqual(plan.actionSummary.governanceSymbols, ['DDD/USDT']);
  assert.deepEqual(plan.actionSummary.weightSymbols, ['AAA/USDT', 'BBB/USDT', 'CCC/USDT']);
  assert.deepEqual(plan.actionSummary.paperTradingSymbols, ['AAA/USDT', 'BBB/USDT', 'CCC/USDT']);
  assert.deepEqual(plan.actionSummary.promotionGateSymbols, ['AAA/USDT', 'BBB/USDT', 'CCC/USDT', 'DDD/USDT']);
  assert.equal(plan.plannedCommands.some((cmd) => cmd.includes('runtime:luna-candidate-backtest-refresh') && cmd.includes('--symbols=CCC/USDT')), true);
  assert.equal(plan.plannedCommands.some((cmd) => cmd.includes('runtime:luna-predictive-evidence-refresh') && cmd.includes('--symbols=AAA/USDT')), true);
  assert.equal(plan.plannedCommands.some((cmd) => cmd.includes('runtime:luna-phase4-strategy-enhancement-shadow') && cmd.includes('--symbols=CCC/USDT')), true);
  assert.equal(plan.plannedCommands.some((cmd) => cmd.includes('runtime:luna-candidate-quality-governance') && cmd.includes('--symbols=DDD/USDT')), true);
  assert.equal(plan.plannedCommands.some((cmd) => cmd.includes('runtime:luna-weight-vector-shadow') && cmd.includes('--symbols=AAA/USDT,BBB/USDT,CCC/USDT')), true);
  assert.equal(plan.plannedCommands.some((cmd) => cmd.includes('runtime:luna-paper-trading-shadow') && cmd.includes('--symbols=AAA/USDT,BBB/USDT,CCC/USDT')), true);
  assert.equal(plan.plannedCommands.some((cmd) => cmd.includes('runtime:luna-paper-promotion-gate') && cmd.includes('--symbols=AAA/USDT,BBB/USDT,CCC/USDT,DDD/USDT')), true);
  assert.equal(plan.plannedCommands.every((cmd) => !cmd.includes('launchctl') && !cmd.includes('live-fire') && !cmd.includes('rollback')), true);

  await assert.rejects(
    () => runLunaPromotionReadinessAssistShadow({
      json: true,
      apply: true,
      dryRun: true,
      confirm: CONFIRM,
    }, { runGate: async () => fixtureGateReport() }),
    /cannot combine --apply with --dry-run/,
  );
  await assert.rejects(
    () => runLunaPromotionReadinessAssistShadow({
      json: true,
      apply: true,
    }, { runGate: async () => fixtureGateReport() }),
    /requires --confirm=luna-promotion-readiness-assist-shadow/,
  );

  const dryRun = await runLunaPromotionReadinessAssistShadow({
    json: true,
    dryRun: true,
    market: 'all',
    limit: 50,
    maxTargets: 4,
  }, { runGate: async () => fixtureGateReport() });
  assert.equal(dryRun.writeMode, 'plan-only');
  assert.equal(dryRun.selectedTargets.length, 4);
  assert.equal(dryRun.liveMutation, false);
  assert.equal(Object.values(dryRun.executed).every((value) => value == null), true);

  const calls = [];
  const applied = await runLunaPromotionReadinessAssistShadow({
    json: true,
    apply: true,
    confirm: CONFIRM,
    market: 'all',
    limit: 50,
    maxTargets: 4,
  }, {
    runGate: async (options) => {
      calls.push(['gate', options.apply === true ? 'apply' : 'read', options.symbols || '']);
      return fixtureGateReport();
    },
    runBacktest: async (options) => {
      calls.push(['backtest', options.symbols]);
      return { ok: true, total: 1, liveMutation: false };
    },
    runPredictive: async (options) => {
      calls.push(['predictive', options.symbols]);
      return { ok: true, total: 4, liveMutation: false };
    },
    runStrategy: async (options) => {
      calls.push(['strategy', options.symbols]);
      return { ok: true, summary: { total: 4 }, liveMutation: false };
    },
    runGovernance: async (options) => {
      calls.push(['governance', options.symbols]);
      return { ok: true, summary: { total: 4 }, liveMutation: false };
    },
    runWeight: async (options) => {
      calls.push(['weight', options.symbols]);
      return { ok: true, summary: { total: 4 }, liveMutation: false };
    },
    runPaperTrading: async (options) => {
      calls.push(['paper', options.symbols]);
      return { ok: true, summary: { total: 4 }, liveMutation: false };
    },
  });
  assert.equal(applied.writeMode, 'shadow-apply');
  assert.equal(applied.executed.backtestRefresh.ok, true);
  assert.equal(applied.executed.paperPromotionGate.ok, true);
  assert.equal(calls.some((call) => call[0] === 'gate' && call[1] === 'apply'), true);
  assert.equal(calls.some((call) => call[0] === 'backtest' && call[1] === 'CCC/USDT'), true);
  assert.equal(calls.some((call) => call[0] === 'predictive' && call[1] === 'AAA/USDT'), true);
  assert.equal(calls.some((call) => call[0] === 'strategy' && call[1] === 'CCC/USDT'), true);
  assert.equal(calls.some((call) => call[0] === 'governance' && call[1] === 'DDD/USDT'), true);
  assert.equal(calls.some((call) => call[0] === 'weight' && call[1] === 'AAA/USDT,BBB/USDT,CCC/USDT'), true);
  assert.equal(calls.some((call) => call[0] === 'paper' && call[1] === 'AAA/USDT,BBB/USDT,CCC/USDT'), true);
  assert.equal(calls.some((call) => call[0] === 'gate' && call[1] === 'apply' && call[2] === 'AAA/USDT,BBB/USDT,CCC/USDT,DDD/USDT'), true);

  return {
    ok: true,
    smoke: 'luna-promotion-readiness-assist',
    checks: {
      planOnly: true,
      confirmGuard: true,
      applyDryRunRejected: true,
      targetCount: plan.selectedTargets.length,
      plannedCommands: plan.plannedCommands.length,
      shadowApply: true,
      liveMutation: false,
    },
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: runLunaPromotionReadinessAssistSmoke,
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: 'luna-promotion-readiness-assist-smoke error:',
  });
}
