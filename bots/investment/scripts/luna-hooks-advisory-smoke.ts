#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { compareLaunchdPlistState } from '../shared/hooks/luna-deploy-drift-guard.ts';
import { buildLunaCostAdvisory, buildLunaCostLogRow } from '../shared/hooks/luna-cost-advisory-hook.ts';

const expected = {
  ProgramArguments: ['node', 'scripts/runtime-a.ts'],
  StartCalendarInterval: [{ Hour: 9, Minute: 0 }],
  EnvironmentVariables: { A: '1' },
};
const same = compareLaunchdPlistState(expected, { ...expected });
assert.equal(same.driftDetected, false);
assert.equal(same.advisoryOnly, true);

const drift = compareLaunchdPlistState(expected, {
  ...expected,
  StartCalendarInterval: [{ Hour: 10, Minute: 0 }],
});
assert.equal(drift.driftDetected, true);
assert.equal(drift.diffs[0].key, 'StartCalendarInterval');

const low = buildLunaCostAdvisory({
  request: { estimatedCostUsd: 0.01, callerTeam: 'investment', taskType: 'meeting' },
  dailyUsage: { spentUsd: 0.10 },
  budgetUsd: 1,
});
assert.equal(low.budgetPressure, false);

const high = buildLunaCostAdvisory({
  request: { estimatedCostUsd: 0.25, callerTeam: 'investment', taskType: 'meeting' },
  dailyUsage: { spentUsd: 0.80 },
  budgetUsd: 1,
});
assert.equal(high.budgetPressure, true);
assert.equal(high.severity, 'high');
const row = buildLunaCostLogRow(high);
assert.equal(row.event_type, 'luna_llm_cost_advisory');
assert.equal(row.payload.liveMutation, false);

const payload = { ok: true, smoke: 'luna-hooks-advisory', driftDiffs: drift.diffs.length, costSeverity: high.severity };
if (process.argv.includes('--json')) console.log(JSON.stringify(payload, null, 2));
else console.log('luna-hooks-advisory-smoke ok');
