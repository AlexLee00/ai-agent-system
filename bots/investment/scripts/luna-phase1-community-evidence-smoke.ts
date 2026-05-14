#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { get } from '../shared/db/core.ts';
import { runCommunityEvidenceRefresh } from './runtime-luna-community-evidence-refresh.ts';

async function safeCount() {
  const row = await get(`
    SELECT count(*)::int AS count
      FROM external_evidence_events
     WHERE source_type = 'community'
  `).catch(() => null);
  return row?.count ?? null;
}

const before = await safeCount();
const result = await runCommunityEvidenceRefresh({
  json: true,
  dryRun: true,
  fixture: true,
  limit: 10,
});
const after = await safeCount();

assert.equal(result.ok, true);
assert.equal(result.dryRun, true);
assert.equal(result.fixture, true);
assert.equal(result.inserted, 0);
assert.ok(result.collected > 0, 'fixture community evidence should collect at least one row');
if (before != null && after != null) assert.equal(after, before, 'dry-run must not write community evidence rows');

const sample = result.sample?.[0];
assert.ok(sample?.rawRef?.sourceDiversity, 'sample rawRef must include sourceDiversity');
assert.ok(sample?.rawRef?.freshness, 'sample rawRef must include freshness');
assert.ok(sample?.rawRef?.botNoise, 'sample rawRef must include botNoise');
assert.ok(sample?.rawRef?.hypeSpike, 'sample rawRef must include hypeSpike');

const payload = {
  ok: true,
  smoke: 'luna-phase1-community-evidence',
  dryRunRowsUnchanged: before == null || after == null ? 'table_missing_or_unchecked' : before === after,
  collected: result.collected,
  sampleRawRefKeys: Object.keys(sample?.rawRef || {}).sort(),
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('luna-phase1-community-evidence-smoke ok');
}
