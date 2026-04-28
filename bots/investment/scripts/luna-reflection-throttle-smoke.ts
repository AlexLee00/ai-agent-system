#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import * as db from '../shared/db.ts';
import { shouldPublishDiscoveryReflectionReport } from '../shared/discovery-reflection.ts';

export async function runLunaReflectionThrottleSmoke() {
  const exchange = `smoke_reflection_${Date.now().toString(36)}`;
  const scopeKey = `reflection_report:${exchange}`;
  try {
    const first = await shouldPublishDiscoveryReflectionReport({
      exchange,
      minHours: 24,
      now: new Date('2026-04-29T00:00:00.000Z'),
      reportMeta: { source: 'smoke' },
    });
    assert.equal(first.publish, true);

    const second = await shouldPublishDiscoveryReflectionReport({
      exchange,
      minHours: 24,
      now: new Date('2026-04-29T00:10:00.000Z'),
      reportMeta: { source: 'smoke' },
    });
    assert.equal(second.publish, false);

    const third = await shouldPublishDiscoveryReflectionReport({
      exchange,
      minHours: 24,
      now: new Date('2026-04-30T01:00:00.000Z'),
      reportMeta: { source: 'smoke' },
    });
    assert.equal(third.publish, true);

    return {
      ok: true,
      first,
      second,
      third,
    };
  } finally {
    await db.run(`DELETE FROM discovery_reflection_state WHERE scope_key = $1`, [scopeKey]).catch(() => {});
  }
}

async function main() {
  const result = await runLunaReflectionThrottleSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna reflection throttle smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna reflection throttle smoke 실패:',
  });
}
