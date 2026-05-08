#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  commitResearchAlertState,
  evaluateResearchAlertState,
  recordResearchAlertState,
  shouldPublishResearchAlert,
} from '../shared/research-alert-policy.ts';

function runSmoke() {
  const t0 = new Date('2026-05-08T00:00:00.000Z');
  const first = shouldPublishResearchAlert({
    market: 'overseas',
    symbols: ['AAPL', 'NVDA'],
    state: { markets: {} },
    now: t0,
    cooldownMinutes: 360,
  });
  assert.equal(first.shouldPublish, true);
  assert.equal(first.reason, 'first_research_alert');

  const state = recordResearchAlertState({
    market: 'overseas',
    symbols: ['NVDA', 'AAPL'],
    state: { markets: {} },
    now: t0,
  });

  const repeated = shouldPublishResearchAlert({
    market: 'overseas',
    symbols: ['AAPL', 'NVDA'],
    state,
    now: new Date('2026-05-08T00:30:00.000Z'),
    cooldownMinutes: 360,
  });
  assert.equal(repeated.shouldPublish, false);
  assert.equal(repeated.reason, 'cooldown_suppressed');
  assert.equal(repeated.nextEligibleAt, '2026-05-08T06:00:00.000Z');

  const changed = shouldPublishResearchAlert({
    market: 'overseas',
    symbols: ['AAPL', 'MSFT', 'NVDA'],
    state,
    now: new Date('2026-05-08T00:31:00.000Z'),
    cooldownMinutes: 360,
  });
  assert.equal(changed.shouldPublish, true);
  assert.equal(changed.reason, 'watchlist_changed');

  const elapsed = shouldPublishResearchAlert({
    market: 'overseas',
    symbols: ['AAPL', 'NVDA'],
    state,
    now: new Date('2026-05-08T06:01:00.000Z'),
    cooldownMinutes: 360,
  });
  assert.equal(elapsed.shouldPublish, true);
  assert.equal(elapsed.reason, 'cooldown_elapsed');

  const forced = shouldPublishResearchAlert({
    market: 'overseas',
    symbols: ['AAPL', 'NVDA'],
    state,
    now: new Date('2026-05-08T00:32:00.000Z'),
    cooldownMinutes: 360,
    env: { LUNA_RESEARCH_ALERT_EVERY_CYCLE: 'true' },
  });
  assert.equal(forced.shouldPublish, true);
  assert.equal(forced.reason, 'forced_every_cycle');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'research-alert-policy-smoke-'));
  const statePath = path.join(tmp, 'state.json');
  const evalFirst = evaluateResearchAlertState({
    market: 'domestic',
    symbols: ['005930', '000660'],
    statePath,
    now: t0,
    cooldownMinutes: 360,
  });
  assert.equal(evalFirst.shouldPublish, true);
  assert.equal(fs.existsSync(statePath), true);

  const evalRepeat = evaluateResearchAlertState({
    market: 'domestic',
    symbols: ['000660', '005930'],
    statePath,
    now: new Date('2026-05-08T01:00:00.000Z'),
    cooldownMinutes: 360,
  });
  assert.equal(evalRepeat.shouldPublish, false);
  assert.equal(evalRepeat.reason, 'cooldown_suppressed');

  const deferredStatePath = path.join(tmp, 'deferred-state.json');
  const deferred = evaluateResearchAlertState({
    market: 'domestic',
    symbols: ['005930'],
    statePath: deferredStatePath,
    now: t0,
    cooldownMinutes: 360,
    write: false,
  });
  assert.equal(deferred.shouldPublish, true);
  assert.equal(fs.existsSync(deferredStatePath), false);
  commitResearchAlertState({
    market: 'domestic',
    symbols: ['005930'],
    statePath: deferredStatePath,
    now: t0,
  });
  assert.equal(fs.existsSync(deferredStatePath), true);

  return {
    smoke: 'research-alert-policy',
    ok: true,
    checked: ['first', 'repeat_suppressed', 'watchlist_changed', 'cooldown_elapsed', 'forced'],
  };
}

try {
  const result = runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('research-alert-policy-smoke ok');
} catch (error) {
  console.error(`❌ research-alert-policy-smoke 실패: ${error?.stack || error?.message || error}`);
  process.exit(1);
}
