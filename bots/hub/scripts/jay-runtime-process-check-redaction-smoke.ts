#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { _testOnly } from './jay-runtime-process-check.ts';

const secret = 'do-not-leak-this-value';
const loaded = _testOnly.buildLaunchctlDiagnostic({
  status: 0,
  stdout: `environment = {\n  DATABASE_URL => postgres://jay:${secret}@127.0.0.1/jay\n}`,
  stderr: '',
});
assert.deepEqual(loaded, { status: 0, error: null });
assert.equal(JSON.stringify(loaded).includes(secret), false);

const failed = _testOnly.buildLaunchctlDiagnostic({
  status: 3,
  stdout: '',
  stderr: `lookup failed token=${secret}`,
});
assert.equal(failed.status, 3);
assert.match(String(failed.error), /token=<redacted>/i);
assert.equal(JSON.stringify(failed).includes(secret), false);

const spawnFailed = _testOnly.buildLaunchctlDiagnostic({
  status: null,
  stdout: '',
  stderr: `spawn failed password=${secret}`,
});
assert.equal(spawnFailed.status, 1);
assert.match(String(spawnFailed.error), /password=<redacted>/i);
assert.equal(JSON.stringify(spawnFailed).includes(secret), false);

console.log('jay_runtime_process_check_redaction_smoke_ok');
