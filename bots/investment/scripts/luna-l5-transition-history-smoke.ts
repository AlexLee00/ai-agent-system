#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

process.env.INVESTMENT_OPS_RUNTIME_DIR = mkdtempSync(join(tmpdir(), 'luna-l5-history-'));

const {
  appendLunaL5TransitionHistory,
  readRecentLunaL5TransitionHistory,
  getLunaL5TransitionHistoryPath,
} = await import('../shared/luna-l5-transition-history.ts');

const path = getLunaL5TransitionHistoryPath();
assert.match(path, /luna-l5-transition-history\.jsonl$/);

appendLunaL5TransitionHistory({
  eventType: 'smoke',
  status: 'ok',
  token: 'should-not-leak',
  nested: {
    refresh_token: 'also-hidden',
    safe: 'visible',
  },
});

const history = readRecentLunaL5TransitionHistory({ limit: 1 });
assert.equal(history.rows.length, 1);
assert.equal(history.rows[0].eventType, 'smoke');
assert.equal(history.rows[0].token, '[redacted]');
assert.equal(history.rows[0].nested.refresh_token, '[redacted]');
assert.equal(history.rows[0].nested.safe, 'visible');

console.log(JSON.stringify({ ok: true, file: path, rows: history.rows.length }, null, 2));
