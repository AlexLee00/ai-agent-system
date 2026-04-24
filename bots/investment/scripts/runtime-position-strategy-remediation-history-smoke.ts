#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildPositionStrategyRemediationHistory } from './runtime-position-strategy-remediation-history.ts';

export async function runPositionStrategyRemediationHistorySmoke() {
  const file = path.join(os.tmpdir(), `position-strategy-remediation-history-smoke-${process.pid}-${Date.now()}.jsonl`);
  try {
    const first = await buildPositionStrategyRemediationHistory({ file, json: true });
    assert.equal(first.ok, true);
    assert.equal(first.historyCount, 1);
    assert.equal(first.delta.duplicateManaged, 0);
    assert.equal(first.lastRecordedAt, first.current.recordedAt);
    assert.equal(typeof first.stale, 'boolean');
    assert.ok(first.current.flat);
    assert.match(
      first.current.nextCommand || '',
      /runtime:position-strategy-(?:remediation|hygiene)/,
    );

    const second = await buildPositionStrategyRemediationHistory({ file, json: true });
    assert.equal(second.ok, true);
    assert.equal(second.historyCount, 2);
    assert.ok(typeof second.statusChanged === 'boolean');
    assert.ok(typeof second.nextCommandChanged === 'boolean');
    assert.ok(Object.prototype.hasOwnProperty.call(second, 'nextCommandTransition'));
    assert.ok(Object.prototype.hasOwnProperty.call(second.delta, 'orphanProfiles'));
    assert.equal(typeof second.ageMinutes, 'number');
    assert.equal(typeof second.current.flat?.headline, 'string');
    assert.equal(typeof second.current.refreshCommand, 'string');

    return {
      ok: true,
      firstCount: first.historyCount,
      secondCount: second.historyCount,
      statusChanged: second.statusChanged,
      nextCommand: second.current.nextCommand,
      nextCommandTransition: second.nextCommandTransition,
    };
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

async function main() {
  const result = await runPositionStrategyRemediationHistorySmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('runtime position strategy remediation history smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime position strategy remediation history smoke 실패:',
  });
}
