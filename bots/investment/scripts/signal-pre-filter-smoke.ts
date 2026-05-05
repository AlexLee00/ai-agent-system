#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { preFilterSignal, preFilterSignals } from '../shared/signal-pre-filter.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export async function runSmoke() {
  const pass = preFilterSignal({ symbol: 'BTC/USDT', action: 'BUY', confidence: 0.8 });
  assert.equal(pass.ok, true);
  assert.equal(pass.decision, 'pass');

  const blocked = preFilterSignal({ symbol: 'BTC/USDT', action: 'BUY', confidence: 0.2 });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.blockers.includes('low_confidence'));

  const watch = preFilterSignal({
    symbol: 'ETH/USDT',
    action: 'BUY',
    confidence: 0.8,
    capitalMode: 'POSITION_MONITOR_ONLY',
  });
  assert.equal(watch.ok, true);
  assert.equal(watch.decision, 'watch');

  const batch = preFilterSignals([{ symbol: 'AAPL', action: 'SELL', confidence: 0.1 }, { action: 'NOPE' }]);
  assert.equal(batch.total ?? batch.results.length, 2);
  assert.equal(batch.blocked, 1);

  const weakSymbol = preFilterSignal({ symbol: 'OPN/USDT', exchange: 'binance', action: 'BUY', confidence: 0.9 });
  assert.equal(weakSymbol.ok, false);
  assert.ok(weakSymbol.blockers.includes('trade_data_weak_symbol'));

  const defensiveDomestic = preFilterSignal({
    symbol: '006340',
    exchange: 'kis',
    action: 'BUY',
    confidence: 0.9,
    strategy_family: 'defensive_rotation',
  }, { now: new Date('2026-04-30T01:00:00Z') });
  assert.equal(defensiveDomestic.ok, false);
  assert.ok(defensiveDomestic.blockers.includes('domestic_defensive_rotation_validation_only'));

  return { ok: true, pass, blocked, watch, batch, weakSymbol, defensiveDomestic };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('✅ signal-pre-filter-smoke');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ signal-pre-filter-smoke 실패:' });
}
