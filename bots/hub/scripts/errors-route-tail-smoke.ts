import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { errorsRecentRoute } from '../lib/routes/errors.ts';

async function callRecent(service: string) {
  let payload: any = null;
  await errorsRecentRoute(
    { query: { minutes: '60', service } },
    { json: (value: any) => { payload = value; return value; } },
  );
  return payload;
}

async function main() {
  const service = `hub-errors-route-tail-smoke-${process.pid}`;
  const filePath = path.join('/tmp', `${service}.err.log`);

  try {
    const staleError = '[hub-client] llm: fetch failed';
    const benign = Array.from({ length: 450 }, (_, idx) => `✅ normal heartbeat ${idx}`);
    fs.writeFileSync(filePath, [staleError, ...benign].join('\n') + '\n');

    const staleOnly = await callRecent(service);
    assert.equal(staleOnly.total_errors, 0, 'old error outside the recent tail window must not be counted');

    fs.appendFileSync(filePath, 'fatal: fresh route smoke failure\n');
    const fresh = await callRecent(service);
    assert.equal(fresh.total_errors, 1, 'fresh error in the recent tail window must be counted');
    assert.equal(fresh.services[0].service, service);
    assert.deepEqual(fresh.services[0].recent_errors, ['fatal: fresh route smoke failure']);

    const quietRecovery = Array.from({ length: 50 }, (_, idx) => `normal recovery line ${idx}`);
    fs.appendFileSync(filePath, quietRecovery.join('\n') + '\n');
    const recovered = await callRecent(service);
    assert.equal(recovered.total_errors, 0, 'errors followed by enough quiet lines must be treated as recovered');

    console.log('errors-route-tail-smoke ok');
  } finally {
    fs.rmSync(filePath, { force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
