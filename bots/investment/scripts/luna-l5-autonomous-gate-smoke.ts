#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  buildLifecycleCutoverGate,
  buildPositionSyncFinalGate,
  buildSupervisedWarmupGate,
} from '../shared/luna-l5-operational-gate.ts';

const flags = {
  mode: 'supervised_l4',
  phaseD: { enabled: true },
  phaseE: { enabled: true },
  phaseF: { enabled: true },
  phaseG: { enabled: true },
  phaseH: { enabled: true },
};
const syncGate = buildPositionSyncFinalGate({
  syncSummary: {
    ok: true,
    checkedMarkets: ['domestic', 'overseas', 'crypto'],
    failedMarkets: [],
    mismatchCount: 0,
    skipped: 0,
    results: [],
  },
});
const warmupClear = buildSupervisedWarmupGate({
  targetMode: 'autonomous_l5',
  currentFlags: flags,
  bottleneck: {
    sampleCount: 5,
    latestStatus: 'position_runtime_autopilot_executed',
    latestRecordedAt: new Date().toISOString(),
    dispatch: {
      cleanStreakSamples: 5,
      recentHardFailureCount: 0,
      staleCandidateCount: 2,
    },
  },
  minSamples: 3,
});
assert.equal(warmupClear.ok, true);

const warmupBlocked = buildSupervisedWarmupGate({
  targetMode: 'autonomous_l5',
  currentFlags: { ...flags, mode: 'shadow' },
  bottleneck: {
    sampleCount: 1,
    dispatch: {
      cleanStreakSamples: 1,
      recentHardFailureCount: 1,
    },
  },
  minSamples: 3,
});
assert.equal(warmupBlocked.ok, false);
assert.ok(warmupBlocked.blockers.some((item) => item.startsWith('autonomous_requires_supervised_warmup')));
assert.ok(warmupBlocked.blockers.includes('recent_autopilot_hard_failures:1'));

const cutover = buildLifecycleCutoverGate({
  targetMode: 'autonomous_l5',
  currentFlags: flags,
  readiness: { ok: true, blockers: [], warnings: [] },
  positionSyncGate: syncGate,
  executePreflight: { ok: true, blockers: [], warnings: [] },
  configDoctor: { ok: true, blockers: [], warnings: [] },
  supervisedWarmupGate: warmupClear,
});
assert.equal(cutover.ok, true);

const missingSync = buildLifecycleCutoverGate({
  targetMode: 'autonomous_l5',
  currentFlags: flags,
  readiness: { ok: true, blockers: [], warnings: [] },
  executePreflight: { ok: true, blockers: [], warnings: [] },
  configDoctor: { ok: true, blockers: [], warnings: [] },
  supervisedWarmupGate: warmupClear,
});
assert.equal(missingSync.ok, false);
assert.ok(missingSync.blockers.includes('autonomous_requires_position_sync_gate'));

console.log(JSON.stringify({ ok: true, clear: cutover.status, blocked: missingSync.status }, null, 2));
