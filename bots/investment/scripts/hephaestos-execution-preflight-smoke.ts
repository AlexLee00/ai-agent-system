#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { buildHephaestosExecutionPreflight } from '../team/hephaestos/execution-preflight.ts';
import { createSignalFailurePersister } from '../team/hephaestos/execution-failure.ts';

const preflight = await buildHephaestosExecutionPreflight({
  id: 'sig-preflight',
  symbol: 'ORCA/USDT',
  action: 'BUY',
  amount_usdt: 55,
  trade_mode: 'validation',
}, {
  globalPaperMode: true,
  defaultTradeMode: 'normal',
  getCapitalConfig: (exchange, tradeMode) => ({ exchange, tradeMode, max_concurrent_positions: 3 }),
  getDynamicMinOrderAmount: async (exchange, tradeMode) => `${exchange}:${tradeMode}:11`,
});

assert.equal(preflight.executionContext.base, 'ORCA');
assert.equal(preflight.executionContext.tag, '[PAPER]');
assert.equal(preflight.signalTradeMode, 'validation');
assert.equal(preflight.capitalPolicy.tradeMode, 'validation');
assert.equal(preflight.minOrderUsdt, 'binance:validation:11');

let captured = null;
const persistFailure = createSignalFailurePersister({
  db: {
    updateSignalBlock: async (signalId, payload) => {
      captured = { signalId, payload };
    },
  },
  signalId: 'sig-preflight',
  symbol: 'ORCA/USDT',
  action: 'BUY',
  amountUsdt: 55,
  failedStatus: 'failed',
});
await persistFailure('failure reason that is persisted', {
  code: 'test_code',
  meta: { detail: 'x' },
});

assert.equal(captured.signalId, 'sig-preflight');
assert.equal(captured.payload.code, 'test_code');
assert.equal(captured.payload.meta.symbol, 'ORCA/USDT');
assert.equal(captured.payload.meta.detail, 'x');

const payload = {
  ok: true,
  smoke: 'hephaestos-execution-preflight',
  context: preflight.executionContext,
  captured,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('hephaestos-execution-preflight-smoke ok');
}
