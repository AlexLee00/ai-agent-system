#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { createGuardrailRegistry, runRegisteredGuardrails } from '../shared/guardrail-registry.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export async function runLunaClosureGuardrailRegistrySmoke() {
  const registry = createGuardrailRegistry();
  const expected = [
    'luna_full_integration_closure_gate',
    'luna_operational_blocker_pack',
    'luna_reconcile_blockers',
    'luna_live_fire_final_gate',
    'agent_message_bus_hygiene',
    'luna_curriculum_bootstrap_plan',
    'luna_launchd_cutover_preflight_pack',
    'luna_7day_observation',
  ];
  for (const name of expected) {
    const entry = registry.get(name);
    assert.ok(entry, `guardrail registered: ${name}`);
    assert.ok(entry.command.length >= 2, `guardrail command set: ${name}`);
  }
  const dryRun = await runRegisteredGuardrails({ dryRun: true });
  assert.equal(dryRun.ok, true);
  for (const name of expected) assert.ok(dryRun.results.some((result) => result.name === name));
  return { ok: true, expected, total: dryRun.total };
}

async function main() {
  const result = await runLunaClosureGuardrailRegistrySmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`luna closure guardrail registry smoke ok total=${result.total}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna closure guardrail registry smoke 실패:',
  });
}
