#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  buildExecutePreflightDrill,
  buildLifecycleCutoverGate,
  buildLunaL5AlarmPayload,
  buildLunaL5FinalGate,
  buildPositionSyncFinalGate,
  buildSupervisedWarmupGate,
} from '../shared/luna-l5-operational-gate.ts';

const cleanSync = buildPositionSyncFinalGate({
  syncSummary: {
    ok: true,
    checkedMarkets: ['domestic', 'overseas', 'crypto'],
    failedMarkets: [],
    mismatchCount: 0,
    skipped: 0,
    results: [],
  },
});
assert.equal(cleanSync.ok, true);

const dirtySync = buildPositionSyncFinalGate({
  syncSummary: {
    ok: false,
    checkedMarkets: ['crypto'],
    failedMarkets: ['overseas'],
    mismatchCount: 2,
    skipped: 0,
    results: [],
  },
});
assert.equal(dirtySync.ok, false);
assert.ok(dirtySync.blockers.includes('position_sync_not_clean:2'));
assert.ok(dirtySync.blockers.includes('position_sync_market_missing:domestic'));

const preflight = buildExecutePreflightDrill({
  autopilotPreview: { ok: true },
  dispatchPreview: {
    ok: true,
    candidates: [{
      exchange: 'binance',
      symbol: 'BTC/USDT',
      tradeMode: 'normal',
      action: 'ADJUST',
      runner: 'runtime:pyramid-adjust',
      runnerArgs: { symbol: 'BTC/USDT', exchange: 'binance' },
    }],
  },
  lifecycleReadiness: { ok: true, blockers: [], warnings: [] },
  positionSyncGate: cleanSync,
});
assert.equal(preflight.ok, true);

const supervisedWarmup = buildSupervisedWarmupGate({
  targetMode: 'autonomous_l5',
  currentFlags: {
    mode: 'supervised_l4',
    phaseD: { enabled: true },
    phaseE: { enabled: true },
    phaseF: { enabled: true },
    phaseG: { enabled: true },
    phaseH: { enabled: true },
  },
  bottleneck: {
    sampleCount: 3,
    dispatch: {
      cleanStreakSamples: 3,
      recentHardFailureCount: 0,
    },
  },
});
assert.equal(supervisedWarmup.ok, true);

const cutover = buildLifecycleCutoverGate({
  targetMode: 'autonomous_l5',
  currentFlags: {
    mode: 'supervised_l4',
    phaseD: { enabled: true },
    phaseE: { enabled: true },
    phaseF: { enabled: true },
    phaseG: { enabled: true },
    phaseH: { enabled: true },
  },
  readiness: { ok: true, blockers: [], warnings: [] },
  positionSyncGate: cleanSync,
  executePreflight: preflight,
  configDoctor: { ok: true, blockers: [], warnings: [] },
  supervisedWarmupGate: supervisedWarmup,
});
assert.equal(cutover.ok, true);

const finalGate = buildLunaL5FinalGate({
  cutoverGate: cutover,
  positionSyncGate: cleanSync,
  executePreflight: preflight,
  configDoctor: { ok: true, status: 'ok', blockers: [], warnings: [] },
  supervisedWarmupGate: supervisedWarmup,
});
assert.equal(finalGate.ok, true);
assert.equal(buildLunaL5AlarmPayload(finalGate).event_type, 'report');

console.log(JSON.stringify({ ok: true, status: finalGate.status }, null, 2));
