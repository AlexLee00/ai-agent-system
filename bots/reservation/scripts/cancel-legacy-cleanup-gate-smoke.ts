// @ts-nocheck
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildCancelShadowSummary,
  evaluateCancelLegacyCleanupGate,
  readCancelShadowHistory,
} = require('../lib/cancel-shadow-history.ts');

function summary(day, overrides = {}) {
  return {
    today: day,
    ok: true,
    skipped: false,
    scannerOk: true,
    counts: {
      todayMissingInLegacy: 0,
      todayMissingInUnified: 0,
      futureUnifiedOnly: 1,
      ...overrides.counts,
    },
    ...overrides,
  };
}

async function main() {
  const built = buildCancelShadowSummary({
    ok: true,
    today: '2026-07-03',
    unified: { ok: true, rawCount: 2 },
    diff: { counts: { unified: 2, legacy: 1, todayMissingInLegacy: 0, todayMissingInUnified: 0, futureUnifiedOnly: 1 } },
  });
  assert.equal(built.today, '2026-07-03');
  assert.equal(built.counts.futureUnifiedOnly, 1);
  assert.equal(built.scannerOk, true);

  const ready = evaluateCancelLegacyCleanupGate({
    days: 3,
    history: [
      summary('2026-07-01'),
      summary('2026-07-02'),
      summary('2026-07-03'),
    ],
  });
  assert.equal(ready.ready, true);
  assert.deepStrictEqual(ready.blockers, []);

  const insufficient = evaluateCancelLegacyCleanupGate({
    days: 3,
    history: [summary('2026-07-02'), summary('2026-07-03')],
  });
  assert.equal(insufficient.ready, false);
  assert.match(insufficient.blockers.join(','), /insufficient_shadow_days:2\/3/);

  const mismatch = evaluateCancelLegacyCleanupGate({
    days: 3,
    history: [
      summary('2026-07-01'),
      summary('2026-07-02', { counts: { todayMissingInLegacy: 1 } }),
      summary('2026-07-03'),
    ],
  });
  assert.equal(mismatch.ready, false);
  assert.match(mismatch.blockers.join(','), /today_mismatch:2026-07-02/);

  const skipped = evaluateCancelLegacyCleanupGate({
    days: 3,
    history: [
      summary('2026-07-01'),
      summary('2026-07-02', { skipped: true, reason: 'login_required' }),
      summary('2026-07-03'),
    ],
  });
  assert.equal(skipped.ready, false);
  assert.match(skipped.blockers.join(','), /scanner_skipped:2026-07-02:login_required/);

  const noFuture = evaluateCancelLegacyCleanupGate({
    days: 3,
    history: [
      summary('2026-07-01', { counts: { futureUnifiedOnly: 0 } }),
      summary('2026-07-02', { counts: { futureUnifiedOnly: 0 } }),
      summary('2026-07-03', { counts: { futureUnifiedOnly: 0 } }),
    ],
  });
  assert.equal(noFuture.ready, false);
  assert.match(noFuture.blockers.join(','), /future_unified_only_not_observed/);

  const sameDayFailureThenSuccess = evaluateCancelLegacyCleanupGate({
    days: 3,
    history: [
      summary('2026-07-01'),
      summary('2026-07-02', { skipped: true, reason: 'login_required' }),
      summary('2026-07-02'),
      summary('2026-07-03'),
    ],
  });
  assert.equal(sameDayFailureThenSuccess.ready, false);
  assert.match(sameDayFailureThenSuccess.blockers.join(','), /scanner_skipped:2026-07-02:login_required/);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ska-shadow-history-'));
  const filePath = path.join(temp, 'history.jsonl');
  fs.writeFileSync(filePath, `${JSON.stringify(summary('2026-07-02'))}\n${JSON.stringify(summary('2026-07-03'))}\n`, 'utf8');
  const loaded = readCancelShadowHistory({ filePath, limit: 10 });
  assert.equal(loaded.length, 2);
  assert.equal(loaded[1].today, '2026-07-03');

  console.log(JSON.stringify({
    ok: true,
    tests: ['summary', 'ready', 'insufficient', 'mismatch', 'skipped', 'same-day-worst-case', 'future-evidence', 'history-read'],
  }));
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
