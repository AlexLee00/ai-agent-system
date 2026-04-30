#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { evaluateKisMarketHours } from '../shared/kis-market-hours-guard.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export async function runSmoke() {
  const domesticOpen = evaluateKisMarketHours({
    market: 'domestic',
    now: new Date('2026-04-30T01:00:00Z'),
  });
  assert.equal(domesticOpen.state, 'open');
  assert.equal(domesticOpen.nextAction, 'allow');

  const domesticClosed = evaluateKisMarketHours({
    market: 'domestic',
    now: new Date('2026-04-30T08:00:00Z'),
  });
  assert.equal(domesticClosed.state, 'closed');
  assert.equal(domesticClosed.nextAction, 'defer_until_open');

  const overseas = evaluateKisMarketHours({
    market: 'overseas',
    now: new Date('2026-04-30T15:00:00Z'),
  });
  assert.ok(['open', 'closed'].includes(overseas.state));
  return { ok: true, domesticOpen, domesticClosed, overseas };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('✅ kis-market-hours-guard-smoke');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ kis-market-hours-guard-smoke 실패:' });
}
