#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const require = createRequire(import.meta.url);
const {
  buildCycleBudgetReportFromRows,
  summarizeCycleBudget,
} = require('../lib/llm/cycle-budget.ts');

function rows(count, overrides = {}) {
  return Array.from({ length: count }, (_, index) => ({
    success: true,
    duration_ms: 100,
    cost_usd: 0.001,
    prompt_chars: 400,
    prompt_hash: `hash_${index}`,
    ...overrides,
  }));
}

function main() {
  const ok = buildCycleBudgetReportFromRows({
    cycleId: 'cycle:test',
    rows: rows(3),
    config: { maxCalls: 10, maxUsd: 1, maxMinutes: 60, repeatWarnCount: 30 },
    now: new Date('2026-07-03T00:00:00.000Z'),
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.metrics.calls, 3);
  assert.equal(ok.metrics.estimatedTokens, 300);
  assert.equal(summarizeCycleBudget(ok), '');

  const callBlocked = buildCycleBudgetReportFromRows({
    cycleId: 'cycle:too-many',
    rows: rows(12),
    config: { maxCalls: 10, maxUsd: 1, maxMinutes: 60, repeatWarnCount: 30 },
  });
  assert.equal(callBlocked.ok, false);
  assert.equal(callBlocked.blockers[0].type, 'call_budget');
  assert.match(summarizeCycleBudget(callBlocked), /cycle_budget_blocked:call_budget/);

  const costBlocked = buildCycleBudgetReportFromRows({
    cycleId: 'cycle:too-expensive',
    rows: rows(2, { cost_usd: 0.75 }),
    config: { maxCalls: 10, maxUsd: 1, maxMinutes: 60, repeatWarnCount: 30 },
  });
  assert.equal(costBlocked.ok, false);
  assert.equal(costBlocked.blockers[0].type, 'cost_budget');

  const convergence = buildCycleBudgetReportFromRows({
    cycleId: 'cycle:repeat',
    rows: rows(30, { prompt_hash: 'same_prompt' }),
    config: { maxCalls: 200, maxUsd: 1, maxMinutes: 60, repeatWarnCount: 30 },
  });
  assert.equal(convergence.ok, true);
  assert.equal(convergence.warnings[0].type, 'convergence_loop');
  assert.match(summarizeCycleBudget(convergence), /cycle_budget_warning:convergence_loop/);

  const admissionSource = fs.readFileSync(path.join(repoRoot, 'bots/hub/lib/llm/admission-control.ts'), 'utf8');
  assert.match(admissionSource, /HUB_CYCLE_GUARD_MODE|cycleGuardMode/);
  assert.match(admissionSource, /X-Hub-Cycle-Budget-Warn/);

  const mcpSource = fs.readFileSync(path.join(repoRoot, 'bots/hub/mcp/hub-ops-mcp/src/server.ts'), 'utf8');
  assert.match(mcpSource, /cycleBudget/);
  assert.doesNotMatch(mcpSource, /DELETE\s+FROM|UPDATE\s+.+SET|INSERT\s+INTO/i);

  console.log(JSON.stringify({ ok: true, checks: 9 }, null, 2));
}

main();
