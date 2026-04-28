#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  buildLunaL5PhaseActivationPlan,
  patchLifecyclePhases,
} from './luna-l5-phase-activation-operator.ts';

const baseConfig = {
  position_lifecycle: {
    mode: 'shadow',
    signal_refresh: { enabled: false },
    dynamic_position_sizing: { enabled: false },
    dynamic_trailing: { enabled: false },
    reflexive_portfolio_monitoring: { enabled: false },
    event_stream: { enabled: false },
  },
};

const nextPlan = buildLunaL5PhaseActivationPlan({ config: baseConfig, requestedPhase: 'next' });
assert.equal(nextPlan.ok, true);
assert.equal(nextPlan.steps[0].phase, 'phaseD');
assert.match(nextPlan.steps[0].smokeCommand, /position-signal-refresh-smoke/);

const patched = patchLifecyclePhases(baseConfig, ['phaseD', 'phaseE']);
assert.equal(patched.position_lifecycle.signal_refresh.enabled, true);
assert.equal(patched.position_lifecycle.dynamic_position_sizing.enabled, true);
assert.equal(baseConfig.position_lifecycle.signal_refresh.enabled, false);

const allPlan = buildLunaL5PhaseActivationPlan({ config: patched, requestedPhase: 'all' });
assert.equal(allPlan.steps.length, 5);

console.log(JSON.stringify({ ok: true, next: nextPlan.steps[0].phase, all: allPlan.steps.length }, null, 2));
