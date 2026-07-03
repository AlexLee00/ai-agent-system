// @ts-nocheck
'use strict';

const assert = require('assert');
const { buildSkaCancelOpsAdvisory } = require('../lib/ska-ops-read-service.ts');

async function main() {
  const session = buildSkaCancelOpsAdvisory({
    type: 'session_expired',
    payload: { monitor: 'cancel-shadow-diff' },
  });
  assert.equal(session.ok, true);
  assert.equal(session.alertLevel, 3);
  assert.match(session.message, /세션/);

  const manual = buildSkaCancelOpsAdvisory({
    type: 'cancel_retry_manual_required',
    payload: { cancelKey: 'masked-key', reason: 'member_missing' },
  });
  assert.equal(manual.ok, true);
  assert.equal(manual.alertLevel, 2);
  assert.match(manual.message, /재시도/);

  const unsupported = buildSkaCancelOpsAdvisory({ type: 'unknown' });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.reason, 'unsupported_advisory_type');

  console.log(JSON.stringify({ ok: true, tests: ['session-expired', 'manual-required', 'unsupported'] }));
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
