#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  appendPositionRuntimeAutopilotHistory,
  compactPositionRuntimeAutopilotHistory,
  readPositionRuntimeAutopilotHistoryLines,
  readPositionRuntimeAutopilotHistorySummary,
} from './runtime-position-runtime-autopilot-history-store.ts';

export function runPositionRuntimeAutopilotHistoryStoreSmoke() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-runtime-autopilot-history-'));
  const file = path.join(dir, 'history.jsonl');

  for (let index = 0; index < 6; index++) {
    appendPositionRuntimeAutopilotHistory(
      { recordedAt: new Date(1778337000000 + index).toISOString(), index },
      file,
      { maxLines: 3, compactOverflowLines: 0 },
    );
  }

  const rows = readPositionRuntimeAutopilotHistoryLines(file);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.index), [3, 4, 5]);

  const summary = readPositionRuntimeAutopilotHistorySummary(file);
  assert.equal(summary.historyCount, 3);
  assert.equal(summary.current.index, 5);
  assert.equal(summary.previous.index, 4);

  const compacted = compactPositionRuntimeAutopilotHistory(file, { maxLines: 2 });
  assert.equal(compacted.compacted, true);
  assert.equal(compacted.before, 3);
  assert.equal(compacted.after, 2);
  assert.deepEqual(readPositionRuntimeAutopilotHistoryLines(file).map((row) => row.index), [4, 5]);

  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true, smoke: 'position-runtime-autopilot-history-store', retained: 2 };
}

async function main() {
  const result = runPositionRuntimeAutopilotHistoryStoreSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('position runtime autopilot history store smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ position runtime autopilot history store smoke 실패:',
  });
}
