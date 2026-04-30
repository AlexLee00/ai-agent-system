#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { buildPosttradeAutoTrigger, summarizePosttradeTriggers } from '../shared/posttrade-auto-trigger.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export async function runSmoke() {
  const close = buildPosttradeAutoTrigger({ id: 301, side: 'SELL', symbol: 'BTC/USDT' });
  assert.equal(close.shouldTrigger, true);
  assert.ok(close.pipeline.includes('agent_memory_write'));

  const open = buildPosttradeAutoTrigger({ id: 302, side: 'BUY', symbol: 'ETH/USDT' });
  assert.equal(open.shouldTrigger, false);
  assert.equal(open.pipeline.length, 0);

  const summary = summarizePosttradeTriggers([{ side: 'BUY' }, { side: 'SELL' }, { closed: true }]);
  assert.equal(summary.total, 3);
  assert.equal(summary.triggerable, 2);
  return { ok: true, close, open, summary };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('✅ posttrade-auto-trigger-smoke');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ posttrade-auto-trigger-smoke 실패:' });
}
