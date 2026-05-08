#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  normalizePositionSyncMarkets,
  resolveAutonomousDispatchGate,
  shouldRunRuntimeReevaluation,
} from './runtime-position-runtime-autopilot.ts';

delete process.env.LUNA_POSITION_RUNTIME_SKIP_REEVAL;

const allMarkets = normalizePositionSyncMarkets(['all']);
assert.deepEqual(allMarkets, ['crypto', 'domestic', 'overseas']);

const mixedAliases = normalizePositionSyncMarkets(['binance,kis', 'kis_overseas', 'unknown']);
assert.deepEqual(mixedAliases, ['crypto', 'domestic', 'overseas']);

assert.equal(
  shouldRunRuntimeReevaluation(
    { execute: true, confirm: 'position-runtime-autopilot' },
    { ok: true },
  ),
  true,
);

assert.equal(
  shouldRunRuntimeReevaluation(
    { execute: true, confirm: 'position-runtime-autopilot', skipRuntimeReevaluation: true },
    { ok: true },
  ),
  false,
);

assert.equal(
  shouldRunRuntimeReevaluation(
    { execute: true, confirm: 'position-runtime-autopilot' },
    { ok: false },
  ),
  false,
);

const requestedDecision = { executeDispatch: true };
const blockedGate = resolveAutonomousDispatchGate(
  { executeDispatch: true },
  requestedDecision,
  (name) => ({
    LUNA_POSITION_RUNTIME_AUTONOMOUS_DISPATCH_ENABLED: 'false',
    LUNA_LIVE_FIRE_ENABLED: 'false',
  }[name] || ''),
);
assert.equal(blockedGate.ok, false);
assert.equal(blockedGate.execute, false);
assert.deepEqual(blockedGate.blockers, [
  'position_runtime_autonomous_dispatch_disabled',
  'live_fire_disabled',
]);

const liveFireOnlyGate = resolveAutonomousDispatchGate(
  { executeDispatch: true },
  requestedDecision,
  (name) => ({
    LUNA_POSITION_RUNTIME_AUTONOMOUS_DISPATCH_ENABLED: 'true',
    LUNA_LIVE_FIRE_ENABLED: 'false',
  }[name] || ''),
);
assert.equal(liveFireOnlyGate.ok, false);
assert.deepEqual(liveFireOnlyGate.blockers, ['live_fire_disabled']);

const clearGate = resolveAutonomousDispatchGate(
  { executeDispatch: true },
  requestedDecision,
  (name) => ({
    LUNA_POSITION_RUNTIME_AUTONOMOUS_DISPATCH_ENABLED: 'true',
    LUNA_LIVE_FIRE_ENABLED: 'true',
  }[name] || ''),
);
assert.equal(clearGate.ok, true);
assert.equal(clearGate.execute, true);

console.log(JSON.stringify({
  ok: true,
  status: 'runtime_position_autopilot_live_position_contract_ok',
  markets: allMarkets,
  dispatchGate: {
    blocked: blockedGate.status,
    clear: clearGate.status,
  },
}, null, 2));
