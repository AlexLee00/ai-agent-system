#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { buildLunaL5ConfigDoctor } from './luna-l5-config-doctor.ts';

const flags = {
  mode: 'supervised_l4',
  phaseD: { enabled: true },
  phaseE: { enabled: true },
  phaseF: { enabled: true },
  phaseG: { enabled: true },
  phaseH: { enabled: true },
};

const clean = buildLunaL5ConfigDoctor({
  flags,
  targetMode: 'autonomous_l5',
  configDoc: {
    exists: true,
    data: {
      position_lifecycle: {
        mode: 'supervised_l4',
        signal_refresh: { enabled: true },
        dynamic_position_sizing: { enabled: true },
        dynamic_trailing: { enabled: true },
        reflexive_portfolio_monitoring: { enabled: true },
        event_stream: { enabled: true },
      },
    },
  },
  exampleDoc: {
    exists: true,
    data: { position_lifecycle: {} },
  },
});
assert.equal(clean.ok, true);

const blocked = buildLunaL5ConfigDoctor({
  flags: { ...flags, mode: 'shadow', phaseD: { enabled: false } },
  targetMode: 'autonomous_l5',
  configDoc: {
    exists: true,
    data: { position_lifecycle: { mode: 'shadow' } },
  },
  exampleDoc: {
    exists: true,
    data: { position_lifecycle: {} },
  },
});
assert.equal(blocked.ok, false);
assert.ok(blocked.blockers.some((item) => item.includes('autonomous_target_requires')));
assert.ok(blocked.blockers.includes('runtime_phase_disabled:phaseD'));

console.log(JSON.stringify({ ok: true, clean: clean.status, blocked: blocked.status }, null, 2));
