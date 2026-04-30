#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { createGuardrailRegistry, GUARDRAIL_CATEGORIES } from '../shared/guardrail-registry.ts';
import { runGuardrailsHourly } from './runtime-luna-guardrails-hourly.ts';

export async function runLunaGuardrailsSmoke() {
  const registry = createGuardrailRegistry();
  const entries = registry.list();
  assert.ok(entries.length >= 25, `expected >=25 guardrails, got ${entries.length}`);
  for (const category of GUARDRAIL_CATEGORIES) {
    assert.ok(registry.list(category).length >= 1, `category registered: ${category}`);
  }
  const report = await runGuardrailsHourly({ dryRun: true, write: false });
  assert.equal(report.ok, true);
  assert.equal(report.dryRun, true);
  return { ok: true, total: report.total, byCategory: report.byCategory };
}

async function main() {
  const result = await runLunaGuardrailsSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`luna-guardrails-smoke ok total=${result.total}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ luna-guardrails-smoke 실패:' });
}
