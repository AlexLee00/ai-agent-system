#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { resolveDomesticCycleLastRunAt } from '../markets/domestic.ts';

export async function runDomesticCycleStateSmoke() {
  const legacyResearchOnlyState = {
    lastCycleAt: Date.now(),
    lastResearchCycleAt: Date.now(),
    lastLiveCycleAt: 0,
  };
  assert.equal(resolveDomesticCycleLastRunAt(legacyResearchOnlyState, { live: true }), 0);
  assert.equal(resolveDomesticCycleLastRunAt(legacyResearchOnlyState, { live: false }) > 0, true);

  const liveState = {
    lastCycleAt: 1000,
    lastResearchCycleAt: 2000,
    lastLiveCycleAt: 3000,
  };
  assert.equal(resolveDomesticCycleLastRunAt(liveState, { live: true }), 3000);
  assert.equal(resolveDomesticCycleLastRunAt(liveState, { live: false }), 2000);

  return { ok: true };
}

async function main() {
  const result = await runDomesticCycleStateSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('domestic-cycle-state-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ domestic-cycle-state-smoke 실패:' });
}
