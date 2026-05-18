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

function fixturePromotionReadyGateReport() {
  return {
    ok: true,
    status: 'luna_paper_promotion_gate_shadow_ready',
    summary: {
      totalSymbols: 1,
      promotionCandidates: 1,
      nearReady: 0,
      liveMutation: false,
    },
    readinessSummary: {
      nearReady: 0,
      nextPaperCycleTargets: [],
      liveMutation: false,
    },
    items: [
      {
        symbol: 'AIGENSYN/USDT',
        market: 'crypto',
        exchange: 'binance',
        decision: 'shadow_promotion_candidate_ready',
        promotionCandidate: true,
        cycleCount: 4,
        passCount: 4,
        consecutivePasses: 4,
        avgConfidence: 0.7409,
        readinessScore: 1,
        blockReasons: [],
      },
    ],
  };
}

function fixtureMixedPromotionReadyGateReport() {
  return {
    ok: true,
    status: 'luna_paper_promotion_gate_shadow_ready',
    summary: {
      totalSymbols: 2,
      promotionCandidates: 2,
      nearReady: 0,
      liveMutation: false,
    },
    readinessSummary: {
      nearReady: 0,
      nextPaperCycleTargets: [],
      liveMutation: false,
    },
    items: [
      {
        symbol: '037460',
        market: 'domestic',
        exchange: 'kis',
        decision: 'shadow_promotion_candidate_ready',
        promotionCandidate: true,
        cycleCount: 6,
        passCount: 6,
        consecutivePasses: 6,
        avgConfidence: 0.68,
        readinessScore: 1,
        blockReasons: [],
      },
      {
        symbol: 'MSFT',
        market: 'overseas',
        exchange: 'kis_overseas',
        decision: 'shadow_promotion_candidate_ready',
        promotionCandidate: true,
        cycleCount: 6,
        passCount: 6,
        consecutivePasses: 6,
        avgConfidence: 0.71,
        readinessScore: 1,
        blockReasons: [],
      },
    ],
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

  const promotionPlan = buildLunaPromotionReadinessAssistPlan(fixturePromotionReadyGateReport(), {
    market: 'crypto',
    hours: 168,
    limit: 50,
    maxTargets: 4,
  });
  assert.equal(promotionPlan.promotionReadyTargets.length, 1);
  assert.deepEqual(promotionPlan.actionSummary.promotionReadySymbols, ['AIGENSYN/USDT']);
  assert.equal(promotionPlan.actionSummary.byAction.promotion_entry_trigger_bridge_shadow, 1);
  assert.equal(promotionPlan.actionSummary.byAction.promotion_entry_trigger_materialize_shadow, 1);
  assert.equal(
    promotionPlan.plannedCommands.some((cmd) => cmd.includes('runtime:luna-promotion-entry-trigger-bridge') && cmd.includes('--symbols=AIGENSYN/USDT')),
    true,
  );
  assert.equal(
    promotionPlan.plannedCommands.some((cmd) => cmd.includes('runtime:luna-promotion-entry-trigger-materialize') && cmd.includes('--apply') && cmd.includes('--confirm=luna-promotion-entry-trigger-materialize-active') && cmd.includes('--symbols=AIGENSYN/USDT')),
    true,
  );
  assert.equal(promotionPlan.plannedCommands.every((cmd) => !cmd.includes('launchctl') && !cmd.includes('live-fire') && !cmd.includes('rollback')), true);

  const mixedPromotionPlan = buildLunaPromotionReadinessAssistPlan(fixtureMixedPromotionReadyGateReport(), {
    market: 'all',
    hours: 168,
    limit: 50,
    maxTargets: 4,
  });
  assert.deepEqual(mixedPromotionPlan.actionSummary.promotionReadySymbols, ['037460', 'MSFT']);
  assert.equal(
    mixedPromotionPlan.plannedCommands.some((cmd) => cmd.includes('runtime:luna-promotion-entry-trigger-bridge') && cmd.includes('--market=all') && cmd.includes('--exchange=all')),
    true,
  );
  assert.equal(
    mixedPromotionPlan.plannedCommands.some((cmd) => cmd.includes('runtime:luna-promotion-entry-trigger-materialize') && cmd.includes('--market=all') && cmd.includes('--exchange=all')),
    true,
  );

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

  const bridgeCalls = [];
  const promotionApplied = await runLunaPromotionReadinessAssistShadow({
    json: true,
    apply: true,
    confirm: CONFIRM,
    market: 'crypto',
    limit: 50,
    maxTargets: 4,
  }, {
    runGate: async () => fixturePromotionReadyGateReport(),
    runPromotionBridge: async (options) => {
      bridgeCalls.push(options);
      return {
        ok: false,
        status: 'luna_promotion_entry_trigger_bridge_pending_approval',
        written: 1,
        liveMutation: false,
        entryTriggerDbMutation: false,
      };
    },
  });
  assert.equal(promotionApplied.executed.promotionEntryTriggerBridge.written, 1);
  assert.equal(bridgeCalls[0].symbols, 'AIGENSYN/USDT');
  assert.equal(bridgeCalls[0].exchange, 'binance');
  assert.equal(bridgeCalls[0].confirm, 'luna-promotion-entry-trigger-bridge-shadow');
  assert.equal(promotionApplied.liveMutation, false);

  const mixedBridgeCalls = [];
  await runLunaPromotionReadinessAssistShadow({
    json: true,
    apply: true,
    confirm: CONFIRM,
    market: 'all',
    limit: 50,
    maxTargets: 4,
  }, {
    runGate: async () => fixtureMixedPromotionReadyGateReport(),
    runPromotionBridge: async (options) => {
      mixedBridgeCalls.push(options);
      return {
        ok: false,
        status: 'luna_promotion_entry_trigger_bridge_pending_approval',
        written: 2,
        liveMutation: false,
        entryTriggerDbMutation: false,
      };
    },
  });
  assert.equal(mixedBridgeCalls[0].exchange, 'all');
  assert.equal(mixedBridgeCalls[0].symbols, '037460,MSFT');

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
