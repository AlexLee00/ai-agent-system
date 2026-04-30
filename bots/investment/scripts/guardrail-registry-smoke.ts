#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { GUARDRAIL_CATEGORIES, createGuardrailRegistry, runRegisteredGuardrails } from '../shared/guardrail-registry.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export async function runSmoke() {
  const registry = createGuardrailRegistry();
  const entries = registry.list();
  assert.ok(entries.length >= 10, 'default guardrails registered');
  for (const name of [
    'luna_full_integration_closure_gate',
    'luna_reconcile_blockers',
    'luna_live_fire_final_gate',
    'agent_message_bus_hygiene',
    'luna_7day_observation',
  ]) {
    assert.ok(registry.get(name), `default guardrail registered: ${name}`);
  }
  for (const category of GUARDRAIL_CATEGORIES) {
    assert.ok(entries.some((entry) => entry.category === category), `category exists: ${category}`);
  }
  const dryRun = await runRegisteredGuardrails({ dryRun: true });
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.total, entries.length);
  return { ok: true, total: entries.length, categories: GUARDRAIL_CATEGORIES, dryRun };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`✅ guardrail-registry-smoke guardrails=${result.total}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ guardrail-registry-smoke 실패:' });
}
