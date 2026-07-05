'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const telemetry = require('../lib/telemetry.ts');

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-telemetry-'));
  const filePath = path.join(tmp, 'telemetry.jsonl');
  const original = process.env.DARWIN_TELEMETRY_PATH;
  process.env.DARWIN_TELEMETRY_PATH = filePath;
  try {
    const first = telemetry.recordTelemetry({ phase: 'fixture', event: 'start' });
    assert.strictEqual(first.ok, true);
    const value = await telemetry.withTelemetry('fixture.phase', async () => 42, { proposalId: 'p1' });
    assert.strictEqual(value, 42);
    const tail = telemetry.tailTelemetry(10, filePath);
    assert.strictEqual(tail.length, 3);
    assert.strictEqual(tail[0].phase, 'fixture');
    assert.strictEqual(tail[2].ok, true);
    console.log('✅ darwin telemetry smoke ok');
  } finally {
    if (original === undefined) delete process.env.DARWIN_TELEMETRY_PATH;
    else process.env.DARWIN_TELEMETRY_PATH = original;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
