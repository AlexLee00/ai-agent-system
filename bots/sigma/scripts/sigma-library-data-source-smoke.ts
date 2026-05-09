import assert from 'node:assert/strict';
import {
  buildFixtureLibraryRecords,
  buildSelfImprovementSignalsFromRecords,
} from '../ts/lib/library-data-source.js';

const records = buildFixtureLibraryRecords();
assert.equal(records.length, 3);
assert.ok(records.every((record) => record.contentHash.length === 64));
assert.ok(records.every((record) => record.piiRedactedText && record.createdAt));
assert.ok(records.some((record) => record.redactions.includes('token')));

const repeat = buildFixtureLibraryRecords();
assert.deepEqual(
  repeat.map((record) => record.contentHash),
  records.map((record) => record.contentHash),
);

const signals = buildSelfImprovementSignalsFromRecords(records);
assert.ok(signals.some((signal) => signal.outcome === 'failure'));
assert.ok(signals.some((signal) => signal.outcome === 'success'));

console.log(JSON.stringify({
  ok: true,
  status: 'sigma_library_data_source_smoke_passed',
  records: records.length,
  signals: signals.length,
  redacted: records.filter((record) => record.redactions.length > 0).length,
}, null, 2));
