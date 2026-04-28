#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  buildExecutePreflightDrill,
  buildLifecycleCutoverGate,
  buildPositionSyncFinalGate,
} from '../shared/luna-l5-operational-gate.ts';

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
const preflight = buildExecutePreflightDrill({
  autopilotPreview: { ok: true },
  dispatchPreview: { ok: true, candidates: [] },
  lifecycleReadiness: { ok: true, blockers: [], warnings: [] },
  positionSyncGate: syncGate,
});

const blocked = buildLifecycleCutoverGate({
  targetMode: 'supervised_l4',
  currentFlags: {
    mode: 'shadow',
    phaseD: { enabled: false },
    phaseE: { enabled: false },
    phaseF: { enabled: false },
    phaseG: { enabled: false },
    phaseH: { enabled: false },
  },
  readiness: { ok: true, blockers: [], warnings: [] },
  executePreflight: preflight,
  configDoctor: { ok: true, blockers: [], warnings: [] },
});
assert.equal(blocked.ok, false);
assert.ok(blocked.blockers.includes('supervised_cutover_requires_at_least_one_lifecycle_phase'));

const clear = buildLifecycleCutoverGate({
  targetMode: 'supervised_l4',
  currentFlags: {
    mode: 'shadow',
    phaseD: { enabled: true },
    phaseE: { enabled: false },
    phaseF: { enabled: false },
    phaseG: { enabled: false },
    phaseH: { enabled: false },
  },
  readiness: { ok: true, blockers: [], warnings: [] },
  executePreflight: preflight,
  configDoctor: { ok: true, blockers: [], warnings: [] },
});
assert.equal(clear.ok, true);
assert.equal(clear.status, 'luna_l5_cutover_gate_clear');

console.log(JSON.stringify({ ok: true, blocked: blocked.status, clear: clear.status }, null, 2));
