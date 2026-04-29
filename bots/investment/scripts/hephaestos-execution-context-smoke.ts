#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import * as legacy from '../team/hephaestos.ts';
import { buildHephaestosExecutionContext } from '../team/hephaestos/execution-context.ts';

assert.equal(legacy.buildHephaestosExecutionContext, buildHephaestosExecutionContext, 'legacy hephaestos path must re-export execution context helper');

const liveContext = buildHephaestosExecutionContext({
  id: 'sig-live',
  symbol: 'ORCA/USDT',
  action: 'BUY',
  amountUsdt: 33,
}, {
  globalPaperMode: false,
  defaultTradeMode: 'normal',
});

const validationContext = buildHephaestosExecutionContext({
  id: 'sig-validation',
  symbol: 'BTC/USDT',
  action: 'SELL',
  amount_usdt: 42,
  trade_mode: 'validation',
}, {
  globalPaperMode: true,
  defaultTradeMode: 'normal',
});

const checks = [
  ['live.signalId', liveContext.signalId === 'sig-live'],
  ['live.base', liveContext.base === 'ORCA'],
  ['live.amount', liveContext.amountUsdt === 33],
  ['live.tradeMode', liveContext.signalTradeMode === 'normal'],
  ['live.tag', liveContext.tag === '[LIVE]'],
  ['validation.amount_usdt', validationContext.amountUsdt === 42],
  ['validation.tradeMode', validationContext.signalTradeMode === 'validation'],
  ['validation.tag', validationContext.tag === '[PAPER]'],
];

const failed = checks.filter(([, ok]) => !ok);
assert.equal(failed.length, 0, `hephaestos execution context failed: ${failed.map(([name]) => name).join(', ')}`);

const payload = {
  ok: true,
  smoke: 'hephaestos-execution-context',
  checks: Object.fromEntries(checks),
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('hephaestos-execution-context-smoke ok');
}
