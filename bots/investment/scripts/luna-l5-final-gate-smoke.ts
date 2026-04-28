#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  buildExecutePreflightDrill,
  buildLifecycleCutoverGate,
  buildLunaL5FinalGate,
  buildPositionSyncFinalGate,
} from '../shared/luna-l5-operational-gate.ts';
import { renderLunaL5FinalGate } from './luna-l5-final-gate.ts';

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
const cutover = buildLifecycleCutoverGate({
  targetMode: 'supervised_l4',
  currentFlags: {
    mode: 'shadow',
    phaseD: { enabled: true },
    phaseE: { enabled: true },
    phaseF: { enabled: true },
    phaseG: { enabled: true },
    phaseH: { enabled: true },
  },
  readiness: { ok: true, blockers: [], warnings: [] },
  positionSyncGate: syncGate,
  executePreflight: preflight,
  configDoctor: { ok: true, blockers: [], warnings: [] },
});
const report = buildLunaL5FinalGate({
  cutoverGate: cutover,
  positionSyncGate: syncGate,
  executePreflight: preflight,
  configDoctor: { ok: true, blockers: [], warnings: [] },
});

assert.equal(report.ok, true);
assert.match(renderLunaL5FinalGate(report), /Luna L5 final gate/);
console.log(JSON.stringify({ ok: true, status: report.status }, null, 2));
