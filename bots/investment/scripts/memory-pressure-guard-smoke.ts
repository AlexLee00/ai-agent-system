#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  checkMemoryPressure,
  memoryGuardDecision,
  shouldSkipForMemory,
} from '../shared/memory-pressure-guard.ts';

function runSmoke() {
  const criticalEnv = {
    LUNA_MEMORY_GUARD_SIMULATE_LEVEL: 'critical',
    LUNA_MEMORY_GUARD_SIMULATE_FREE_PCT: '1',
  };
  const normalEnv = {
    LUNA_MEMORY_GUARD_SIMULATE_LEVEL: 'normal',
    LUNA_MEMORY_GUARD_SIMULATE_FREE_PCT: '50',
  };

  const protectedDecision = memoryGuardDecision('luna.ops-scheduler', { env: criticalEnv, silent: true });
  assert.equal(protectedDecision.skip, false, 'protected job never skips under simulated pressure');
  assert.equal(protectedDecision.protected, true, 'protected job is classified');

  assert.equal(
    shouldSkipForMemory('luna.agent-evolution', { env: criticalEnv, silent: true }),
    true,
    'noncritical job skips under simulated critical pressure',
  );
  assert.equal(
    shouldSkipForMemory('luna.agent-evolution', { env: normalEnv, silent: true }),
    false,
    'noncritical job runs under normal memory',
  );
  assert.equal(
    shouldSkipForMemory('luna.agent-evolution', { env: { ...criticalEnv, LUNA_MEMORY_GUARD_DISABLED: 'true' }, silent: true }),
    false,
    'disabled guard fails open',
  );

  const simulated = checkMemoryPressure({ env: criticalEnv });
  assert.equal(simulated.pressured, true, 'simulated critical pressure is detected');
  return { ok: true, protectedDecision, simulated };
}

const result = runSmoke();
if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
else console.log('memory-pressure-guard-smoke ok');
