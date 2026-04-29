#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  buildAutonomousOperationalGate,
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
const orphanPreflight = buildExecutePreflightDrill({
  autopilotPreview: { ok: true },
  dispatchPreview: { ok: true, candidates: [] },
  lifecycleReadiness: { ok: true, blockers: [], warnings: [] },
  positionSyncGate: syncGate,
  positionStrategyAudit: { ok: true, orphanProfiles: 1 },
  excludedOrphanCandidates: [{ exchange: 'binance', symbol: 'ORPHAN/USDT', tradeMode: 'normal', action: 'EXIT' }],
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
const autonomousGateWithOrphan = buildAutonomousOperationalGate({
  targetMode: 'autonomous_l5',
  positionSyncGate: { ...syncGate, checkedAt: new Date().toISOString() },
  manualReconcilePlaybook: { ok: true, summary: { tasks: 0 } },
  positionStrategyAudit: {
    ok: true,
    dustProfiles: 0,
    orphanProfiles: 1,
    duplicateManagedProfileScopes: 0,
    unmatchedManagedPositions: 0,
  },
  bottleneck: { dispatch: { recentHardFailureCount: 0 } },
});

assert.equal(report.ok, true);
assert.equal(orphanPreflight.ok, false);
assert.deepEqual(orphanPreflight.blockers, ['orphan_profiles_present:1']);
assert.deepEqual(orphanPreflight.warnings, ['no_execute_candidates_preview', 'orphan_execute_candidates_excluded:1']);
assert.equal(autonomousGateWithOrphan.ok, false);
assert.deepEqual(autonomousGateWithOrphan.blockers, ['orphan_profiles_present:1']);
assert.match(renderLunaL5FinalGate(report), /Luna L5 final gate/);
console.log(JSON.stringify({ ok: true, status: report.status }, null, 2));
