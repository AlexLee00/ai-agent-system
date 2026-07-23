#!/usr/bin/env tsx

import assert from 'node:assert/strict';

const adapter = require('../lib/commanders/base-command-adapter.ts');
const buildSummary = adapter._testOnly?.buildBotCommandFinalSummary;

assert.equal(typeof buildSummary, 'function');

const completed = buildSummary(
  { status: 'done', result: { output: 'ok' } },
  { commandId: 11, incidentKey: 'incident:done', team: 'claude' },
);
assert.equal(completed.ok, true);
assert.equal(completed.status, 'completed');

for (const status of ['error', 'failed', 'rejected', 'dead_letter']) {
  const failed = buildSummary(
    { status, result: { error: `${status}_detail` } },
    { commandId: 12, incidentKey: `incident:${status}`, team: 'claude' },
  );
  assert.equal(failed.ok, false, `${status} must not be reported as success`);
  assert.equal(failed.status, 'failed');
  assert.match(String(failed.error), new RegExp(status));
}

const unknown = buildSummary(
  { status: 'mystery', result: null },
  { commandId: 13, incidentKey: 'incident:mystery', team: 'claude' },
);
assert.equal(unknown.ok, false);
assert.equal(unknown.status, 'failed');

console.log('jay_command_terminal_semantics_smoke_ok');
