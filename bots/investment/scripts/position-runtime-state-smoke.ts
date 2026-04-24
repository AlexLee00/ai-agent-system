#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildExecutionIntent,
  buildOnlineValidationState,
  buildPositionRuntimeState,
  buildRegimeAwareMonitoringPolicy,
  buildRegimeAwarePolicyMatrix,
} from '../shared/position-runtime-state.ts';

export function runPositionRuntimeStateSmoke() {
  const monitoringPolicy = buildRegimeAwareMonitoringPolicy({
    exchange: 'binance',
    recommendation: 'EXIT',
    reasonCode: 'backtest_drift_exit',
    attentionType: 'backtest_drift_attention',
    regime: { regime: 'trending_bear' },
    setupType: 'trend_following',
  });
  assert.equal(monitoringPolicy.lane, 'attention_fast_lane');
  assert.ok(monitoringPolicy.cadenceMs <= 10000);

  const monitoringPolicyNoExternalEvidence = buildRegimeAwareMonitoringPolicy({
    exchange: 'binance',
    recommendation: 'ADJUST',
    reasonCode: 'profit_lock_candidate',
    regime: { regime: 'volatile' },
    setupType: 'momentum_rotation',
    analysisSummary: {
      avgConfidence: 0.64,
      liveIndicator: { avgConfidence: 0.66, weightedBias: 0.4 },
    },
    externalEvidenceSummary: {
      evidenceCount: 0,
      avgQuality: 0,
      avgFreshness: 0,
      warning: 'no evidence',
    },
  });
  assert.equal(monitoringPolicyNoExternalEvidence.sourceQualityBlocked, false);
  assert.ok(monitoringPolicyNoExternalEvidence.sourceQualityScore >= 0.45);

  const monitoringPolicyLowExternalQuality = buildRegimeAwareMonitoringPolicy({
    exchange: 'binance',
    recommendation: 'ADJUST',
    reasonCode: 'profit_lock_candidate',
    regime: { regime: 'volatile' },
    setupType: 'momentum_rotation',
    analysisSummary: {
      avgConfidence: 0.64,
      liveIndicator: { avgConfidence: 0.66, weightedBias: 0.4 },
    },
    externalEvidenceSummary: {
      evidenceCount: 4,
      avgQuality: 0.2,
      avgFreshness: 0.5,
      warning: 'low quality',
    },
  });
  assert.equal(monitoringPolicyLowExternalQuality.sourceQualityBlocked, true);

  const policyMatrix = buildRegimeAwarePolicyMatrix({
    exchange: 'binance',
    strategyProfile: { setup_type: 'trend_following' },
    pnlPct: -2.5,
    recommendation: 'EXIT',
    regime: { regime: 'trending_bear' },
    analysisSummary: { buy: 0, sell: 3, liveIndicator: { weightedBias: -0.7 } },
    driftContext: { sharpeDrop: 1.8, returnDropPct: 12 },
  });
  assert.equal(policyMatrix.riskGate, 'strict_risk_gate');

  const validationState = buildOnlineValidationState({
    latestBacktest: { total_trades: 12, created_at: '2026-04-24T00:00:00.000Z' },
    driftContext: { totalTrades: 12, sharpeDrop: 1.8, returnDropPct: 12 },
    monitoringPolicy,
    recommendation: 'EXIT',
  });
  assert.equal(validationState.severity, 'critical');

  const executionIntent = buildExecutionIntent({
    position: { symbol: 'BTC/USDT', exchange: 'binance', trade_mode: 'normal' },
    strategyProfile: { setup_type: 'trend_following', strategy_context: { responsibilityPlan: { riskMission: 'strict_risk_gate' } } },
    recommendation: 'EXIT',
    reasonCode: 'backtest_drift_exit',
    reason: 'test',
    analysisSummary: { liveIndicator: { weightedBias: -0.7 } },
    monitoringPolicy,
    policyMatrix,
    validationState,
    trigger: { source: 'position_watch' },
  });
  assert.equal(executionIntent.action, 'EXIT');
  assert.match(executionIntent.command, /runtime:strategy-exit/);
  assert.match(executionIntent.previewCommand, /runtime:strategy-exit/);
  assert.match(executionIntent.autonomousExecuteCommand, /--execute/);
  assert.match(executionIntent.autonomousExecuteCommand, /--confirm=position-runtime-autopilot/);
  assert.equal(executionIntent.executionPolicy.autonomy, 'autonomous_allowed');
  assert.ok(String(executionIntent.executionScope || '').includes('BTC/USDT'));
  assert.ok(String(executionIntent.brokerScope || '').includes('BTC/USDT'));

  const runtimeState = buildPositionRuntimeState({
    position: {
      symbol: 'BTC/USDT',
      exchange: 'binance',
      trade_mode: 'normal',
      amount: 100,
      avg_price: 1.0,
      unrealized_pnl: -2.5,
      pnlPct: -2.5,
    },
    strategyProfile: {
      setup_type: 'trend_following',
      strategy_context: {
        responsibilityPlan: {
          riskMission: 'strict_risk_gate',
        },
      },
    },
    analysisSummary: {
      buy: 0,
      hold: 1,
      sell: 3,
      avgConfidence: 0.72,
      liveIndicator: {
        weightedBias: -0.7,
      },
    },
    latestBacktest: { total_trades: 12, created_at: '2026-04-24T00:00:00.000Z' },
    driftContext: { totalTrades: 12, sharpeDrop: 1.8, returnDropPct: 12 },
    recommendation: 'EXIT',
    reasonCode: 'backtest_drift_exit',
    reason: 'test',
    regimeSnapshot: { market: 'binance', regime: 'trending_bear', confidence: 0.8, captured_at: '2026-04-24T00:00:00.000Z' },
    trigger: {
      source: 'position_watch',
      attentionType: 'backtest_drift_attention',
      attentionReason: 'sharpe drop',
    },
    previousState: { version: 2, recommendation: 'HOLD' },
  });
  assert.equal(runtimeState.version, 3);
  assert.equal(runtimeState.regime.regime, 'trending_bear');
  assert.equal(runtimeState.executionIntent.action, 'EXIT');
  assert.equal(runtimeState.executionIntent.executionPolicy.autonomy, 'autonomous_allowed');
  assert.equal(runtimeState.validationState.severity, 'critical');
  assert.equal(runtimeState.monitoringPolicy.lane, 'attention_fast_lane');

  return {
    ok: true,
    lane: runtimeState.monitoringPolicy.lane,
    action: runtimeState.executionIntent.action,
    severity: runtimeState.validationState.severity,
    version: runtimeState.version,
  };
}

async function main() {
  const result = runPositionRuntimeStateSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('position runtime state smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ position-runtime-state-smoke 오류:',
  });
}
