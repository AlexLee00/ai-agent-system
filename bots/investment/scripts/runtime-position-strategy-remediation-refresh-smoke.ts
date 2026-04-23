#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runPositionStrategyRemediationRefresh } from './runtime-position-strategy-remediation-refresh.ts';

export async function runPositionStrategyRemediationRefreshSmoke() {
  const file = path.join(os.tmpdir(), `position-strategy-remediation-refresh-smoke-${process.pid}-${Date.now()}.jsonl`);
  try {
    const result = await runPositionStrategyRemediationRefresh({ file, json: true });
    assert.equal(result.ok, true);
    assert.equal(result.before.historyCount, 0);
    assert.equal(result.after.historyCount, 1);
    assert.equal(result.refreshState.needed, false);
    assert.match(result.refreshState.reason, /history refresh executed/);
    return {
      ok: true,
      beforeCount: result.before.historyCount,
      afterCount: result.after.historyCount,
    };
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

async function main() {
  const result = await runPositionStrategyRemediationRefreshSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('runtime position strategy remediation refresh smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime position strategy remediation refresh smoke 실패:',
  });
}
