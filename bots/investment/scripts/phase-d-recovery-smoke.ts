#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { classifySignalFailure } from '../shared/signal-failure-classifier.ts';
import { buildFailedSignalRecoveryPlan } from '../shared/failed-signal-recovery.ts';
import { evaluateKisMarketHours } from '../shared/kis-market-hours-guard.ts';
import { enqueueDeferredSignal, claimDueDeferredSignals, clearDeferredSignalQueue } from '../shared/deferred-signal-queue.ts';
import { buildPosttradeAutoTrigger } from '../shared/posttrade-auto-trigger.ts';
import { buildFailedSignalReflexion } from '../shared/failed-signal-reflexion.ts';
import { calculateAtrTpSl } from '../shared/tp-sl-auto-setter.ts';
import { calculateRealizedPnl, matchFifoRealizedPnl } from '../shared/realized-pnl-calculator.ts';
import { summarizeAgentUtilization } from '../shared/agent-utilization-monitor.ts';
import { preFilterSignal } from '../shared/signal-pre-filter.ts';
import { clusterTradePatterns } from '../shared/trade-pattern-clusterer.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export async function runSmoke() {
  clearDeferredSignalQueue();
  const failure = classifySignalFailure({ error: 'provider_cooldown openai-oauth' });
  assert.equal(failure.kind, 'provider_unavailable');
  const recovery = buildFailedSignalRecoveryPlan({ id: 1, symbol: 'BTC/USDT', error: 'market_closed' });
  assert.equal(recovery.recoveryState, 'queued');
  const market = evaluateKisMarketHours({ market: 'domestic', now: new Date('2026-04-30T01:00:00Z') });
  assert.ok(['open', 'closed'].includes(market.state));
  const queued = enqueueDeferredSignal({ symbol: 'AAPL', action: 'BUY' }, 'market_closed', { retryAt: '2020-01-01T00:00:00.000Z' });
  assert.equal(claimDueDeferredSignals().length, 1);
  const posttrade = buildPosttradeAutoTrigger({ id: 2, side: 'SELL', symbol: 'BTC/USDT' });
  assert.equal(posttrade.shouldTrigger, true);
  const reflexion = buildFailedSignalReflexion({ symbol: 'ORCA/USDT', error: 'min_order' });
  assert.equal(reflexion.lesson.failureKind, 'min_order');
  const tpsl = calculateAtrTpSl({ entryPrice: 100, atr: 5 });
  assert.equal(tpsl.takeProfit, 110);
  const pnl = calculateRealizedPnl({ buy: { price: 100, quantity: 2 }, sell: { price: 110, quantity: 2 } });
  assert.equal(pnl.ok, true);
  const fifo = matchFifoRealizedPnl([{ side: 'BUY', price: 100, quantity: 1 }, { side: 'SELL', price: 105, quantity: 1 }]);
  assert.equal(fifo.realized.length, 1);
  const utilization = summarizeAgentUtilization([{ agent: 'luna', ok: true }], { expectedAgents: ['luna', 'kairos'] });
  assert.ok(utilization.missingAgents.includes('kairos'));
  const filter = preFilterSignal({ symbol: 'BTC/USDT', action: 'BUY', confidence: 0.2 });
  assert.equal(filter.ok, false);
  const clusters = clusterTradePatterns([{ market: 'binance', strategy: 'breakout', pnl: 1 }]);
  assert.equal(clusters.length, 1);
  return { ok: true, queuedId: queued.id, recovery, posttrade, tpsl, pnl };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('✅ phase-d-recovery-smoke');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ phase-d-recovery-smoke 실패:' });
}
