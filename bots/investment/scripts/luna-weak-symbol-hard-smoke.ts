#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { evaluateActiveEntryTriggerQualityGate } from '../shared/entry-trigger-engine.ts';
import {
  buildSymbolFeedbackBiasFromStats,
  buildWeakFeedbackSymbolEvidence,
  getWeakFeedbackSymbolThresholds,
  isWeakFeedbackSymbol,
  loadSymbolFeedbackStats,
} from '../shared/symbol-feedback.ts';

function makeQuality({ wouldBlock = true } = {}) {
  if (!wouldBlock) {
    return {
      backtest: {
        fresh: true,
        healthy: true,
        gateStatus: 'pass',
        wouldBlock: false,
        lastBacktestAt: new Date().toISOString(),
      },
      predictive: {
        decision: 'pass',
        score: 0.82,
        threshold: 0.55,
        componentCoverage: 1,
        createdAt: new Date().toISOString(),
      },
    };
  }
  return {
    backtest: {
      fresh: true,
      healthy: false,
      gateStatus: 'would_block_unhealthy',
      wouldBlock: true,
      lastBacktestAt: new Date().toISOString(),
    },
    predictive: {
      decision: 'block_backtest_gate',
      score: 0.2,
      threshold: 0.55,
      componentCoverage: 1,
      blockedReason: 'backtest_unhealthy_or_would_block',
      createdAt: new Date().toISOString(),
    },
  };
}

function evaluate({ stats, enabled = true, wouldBlock = true } = {}) {
  return evaluateActiveEntryTriggerQualityGate(
    { symbol: 'SYN/USDT' },
    makeQuality({ wouldBlock }),
    {
      activeQualityGateEnabled: true,
      activeQualityGateMode: 'notify',
      weakSymbolFeedback: stats,
      env: {
        LUNA_WEAK_SYMBOL_HARD_ENABLED: enabled ? 'true' : 'false',
      },
      flags: { shouldAllowLiveEntryFire: () => true },
    },
  );
}

export async function runLunaWeakSymbolHardSmoke({ hardDb = false, symbol = 'SYN/USDT', exchange = 'binance' } = {}) {
  const weakStats = { symbol: 'SYN/USDT', exchange: 'binance', sampleCount: 3, winRate: 1 / 3, avgPnl: -3.9553 };
  const passStats = { symbol: 'PASS/USDT', exchange: 'binance', sampleCount: 5, winRate: 0.6, avgPnl: -0.1 };
  const boundaryWinRate = { symbol: 'EDGE/USDT', exchange: 'binance', sampleCount: 3, winRate: 0.35, avgPnl: -2 };
  const insufficientSamples = { symbol: 'NEW/USDT', exchange: 'binance', sampleCount: 2, winRate: 0, avgPnl: -10 };

  assert.equal(isWeakFeedbackSymbol('SYN/USDT', weakStats, {}), true);
  assert.equal(isWeakFeedbackSymbol('PASS/USDT', passStats, {}), false);
  assert.equal(isWeakFeedbackSymbol('EDGE/USDT', boundaryWinRate, {}), false);
  assert.equal(isWeakFeedbackSymbol('NEW/USDT', insufficientSamples, {}), false);

  const feedbackBias = buildSymbolFeedbackBiasFromStats(weakStats, 'binance');
  assert.deepEqual(feedbackBias.notes, ['symbol feedback weak winRate 33%', 'symbol feedback avgPnl -3.96%']);
  assert.equal(feedbackBias.bias.defensive_rotation, 0.16);

  const enabledWeakWouldBlock = evaluate({ stats: weakStats, enabled: true, wouldBlock: true });
  assert.equal(enabledWeakWouldBlock.ok, false);
  assert.equal(enabledWeakWouldBlock.notifyMode, true);
  assert.equal(enabledWeakWouldBlock.weakSymbolHardBlock, true);
  assert.equal(enabledWeakWouldBlock.weakSymbolFeedback.sampleCount, 3);

  const enabledWeakQualityPass = evaluate({ stats: weakStats, enabled: true, wouldBlock: false });
  assert.equal(enabledWeakQualityPass.ok, true);
  assert.equal(enabledWeakQualityPass.weakSymbolHardBlock, false);

  const enabledNonWeakWouldBlock = evaluate({ stats: passStats, enabled: true, wouldBlock: true });
  assert.equal(enabledNonWeakWouldBlock.ok, true);
  assert.equal(enabledNonWeakWouldBlock.weakSymbolHardBlock, false);

  const disabledWeakWouldBlock = evaluate({ stats: weakStats, enabled: false, wouldBlock: true });
  assert.equal(disabledWeakWouldBlock.ok, true);
  assert.equal(disabledWeakWouldBlock.weakSymbolHardBlock, false);

  let hard = null;
  if (hardDb) {
    const stats = await loadSymbolFeedbackStats(symbol, exchange, { days: 90 });
    const evidence = buildWeakFeedbackSymbolEvidence(symbol, stats, {});
    const thresholds = getWeakFeedbackSymbolThresholds({});
    assert.equal(evidence.weak, true);
    assert.ok(evidence.sampleCount >= thresholds.minSamples);
    assert.ok(evidence.winRate < thresholds.minWinRate);
    assert.ok(evidence.avgPnl <= thresholds.maxAvgPnl);
    hard = evidence;
  }

  return {
    ok: true,
    defaultOffPreservesNotify: disabledWeakWouldBlock.ok === true,
    weakWouldBlockBlocksWhenEnabled: enabledWeakWouldBlock.weakSymbolHardBlock === true,
    hard,
  };
}

function getArg(name, fallback = null) {
  const prefix = `${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

async function main() {
  const result = await runLunaWeakSymbolHardSmoke({
    hardDb: process.argv.includes('--hard-db'),
    symbol: getArg('--symbol', 'SYN/USDT'),
    exchange: getArg('--exchange', 'binance'),
  });
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna weak-symbol-hard smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ luna-weak-symbol-hard-smoke 실패:' });
}
