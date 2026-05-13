#!/usr/bin/env tsx
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const routeFile = path.join(repoRoot, 'bots', 'hub', 'lib', 'routes', 'llm.ts');
const migrationFile = path.join(repoRoot, 'bots', 'hub', 'migrations', '20261001000063_hub_llm_request_log_view.sql');
const budgetFile = path.join(repoRoot, 'bots', 'hub', 'lib', 'budget-guardian.ts');

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

const route = read(routeFile);
const migration = read(migrationFile);
const budget = read(budgetFile);

for (const column of [
  'request_id',
  'route_target_kind',
  'runtime_purpose',
  'estimated_cost_usd',
  'budget_guard_status',
  'provider_tier',
]) {
  assert(route.includes(column), `llm route must write ${column}`);
  assert(migration.includes(column), `migration must include ${column}`);
}

assert(migration.includes('CREATE OR REPLACE VIEW hub.llm_request_log'), 'migration must define canonical hub.llm_request_log view');
assert(!/DROP\s+(TABLE|VIEW|MATERIALIZED\s+VIEW)/i.test(migration), 'Stage A migration must not drop routing logs');
assert(route.includes('ensureHubLlmRequestLogView'), 'runtime route must ensure hub.llm_request_log view');
assert(route.includes('resolveProviderTierForLog'), 'runtime route must log provider tier');
assert(budget.includes('FROM hub.llm_request_log'), 'BudgetGuardian must read canonical Hub request log first');
assert(budget.includes('billingGuard.getBlockReason'), 'BudgetGuardian must respect core BillingGuard stop files');

console.log(JSON.stringify({
  ok: true,
  request_log_view: 'hub.llm_request_log',
  source_table: 'public.llm_routing_log',
  metadata_columns: [
    'request_id',
    'route_target_kind',
    'runtime_purpose',
    'estimated_cost_usd',
    'budget_guard_status',
    'provider_tier',
  ],
}, null, 2));
