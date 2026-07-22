// @ts-nocheck
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  assessPickkoLiveSnapshot,
  loadPickkoLiveSnapshot,
  persistPickkoLiveSnapshot,
} = require('../lib/pickko-live-snapshot.ts');
const { buildReservationSyncCheck } = require('../lib/ska-ops-read-service.ts');
const { createKioskPickkoCycleService } = require('../lib/kiosk-pickko-cycle-service.ts');

function createSnapshotPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickko-live-snapshot-'));
  return {
    dir,
    snapshotPath: path.join(dir, 'trusted.json'),
    attemptPath: path.join(dir, 'attempt.json'),
  };
}

function createSnapshot(overrides = {}) {
  return {
    version: 1,
    collectedAt: '2026-07-22T03:00:00.000Z',
    coverage: { from: '2026-07-22', to: '2026-08-22', complete: true },
    fetchOk: true,
    entries: [
      { date: '2026-07-22', start: '11:00', end: '11:50', room: 'A2', status: 'paid' },
      { date: '2026-07-22', start: '12:00', end: '12:50', room: 'B', status: 'paid' },
      { date: '2026-07-22', start: '14:00', end: '14:50', room: 'A1', status: 'paid' },
      { date: '2026-08-01', start: '09:00', end: '09:50', room: 'A1', status: 'paid' },
    ],
    ...overrides,
  };
}

function runPersistenceContract() {
  const paths = createSnapshotPaths();
  try {
    const complete = persistPickkoLiveSnapshot({
      collectedAt: '2026-07-22T03:00:00.000Z',
      coverageFrom: '2026-07-22',
      coverageTo: '2026-08-22',
      complete: true,
      fetchOk: true,
      entries: [{
        name: '민감이름',
        phoneRaw: '01012345678',
        date: '2026-07-22',
        start: '11:00',
        end: '11:50',
        room: '스터디룸A2',
        statusText: '결제완료',
      }],
    }, paths);

    assert.equal(complete.trustedUpdated, true);
    const serialized = fs.readFileSync(paths.snapshotPath, 'utf8');
    assert.equal(serialized.includes('민감이름'), false);
    assert.equal(serialized.includes('01012345678'), false);
    assert.deepStrictEqual(loadPickkoLiveSnapshot(paths), {
      version: 1,
      collectedAt: '2026-07-22T03:00:00.000Z',
      coverage: { from: '2026-07-22', to: '2026-08-22', complete: true },
      fetchOk: true,
      entryCount: 1,
      entries: [{ date: '2026-07-22', start: '11:00', end: '11:50', room: 'A2', status: 'paid' }],
    });

    const partial = persistPickkoLiveSnapshot({
      collectedAt: '2026-07-22T04:00:00.000Z',
      coverageFrom: '2026-07-22',
      coverageTo: '2026-08-22',
      complete: false,
      fetchOk: true,
      entries: [{ date: '2026-07-23', start: '09:00', end: '09:50', room: 'A1' }],
    }, paths);
    assert.equal(partial.trustedUpdated, false);
    assert.equal(loadPickkoLiveSnapshot(paths).collectedAt, '2026-07-22T03:00:00.000Z');
    assert.equal(JSON.parse(fs.readFileSync(paths.attemptPath, 'utf8')).coverage.complete, false);
  } finally {
    fs.rmSync(paths.dir, { recursive: true, force: true });
  }
}

function runAssessmentContract() {
  const snapshot = createSnapshot();
  assert.equal(assessPickkoLiveSnapshot(snapshot, {
    from: '2026-07-22',
    to: '2026-07-23',
    nowMs: Date.parse('2026-07-22T05:00:00.000Z'),
  }).usable, true);
  assert.equal(assessPickkoLiveSnapshot(snapshot, {
    from: '2026-07-22',
    to: '2026-07-23',
    nowMs: Date.parse('2026-07-24T12:00:00.000Z'),
  }).reason, 'pickko_snapshot_stale');
  assert.equal(assessPickkoLiveSnapshot(snapshot, {
    from: '2026-07-22',
    to: '2026-09-20',
    nowMs: Date.parse('2026-07-22T05:00:00.000Z'),
  }).reason, 'pickko_snapshot_coverage_gap');
}

function createSyncQueryMock() {
  const calls = [];
  const rows = [
    { id: 1, date: '2026-07-22', start_time: '10:00', end_time: '11:00', room: 'A1', status: 'completed', updated_at: '2026-07-22T02:00:00.000Z' },
    { id: 2, date: '2026-07-22', start_time: '11:00', end_time: '12:00', room: 'A2', status: 'completed', updated_at: '2026-07-22T02:00:00.000Z' },
    { id: 3, date: '2026-07-22', start_time: '12:00', end_time: '13:00', room: 'B', status: 'cancelled', updated_at: '2026-07-22T02:00:00.000Z' },
    { id: 4, date: '2026-07-22', start_time: '15:00', end_time: '16:00', room: 'B', status: 'completed', updated_at: '2026-07-22T04:00:00.000Z' },
    { id: 5, date: '2026-07-22', start_time: '16:00', end_time: '17:00', room: 'A1', status: 'completed', updated_at: null },
  ];
  return {
    calls,
    async queryReadonly(schema, sql) {
      calls.push({ schema, sql });
      assert.equal(schema, 'reservation');
      assert.equal(/pickko_order_raw/i.test(sql), false, 'sync check must not treat historical raw rows as a live snapshot');
      if (/COUNT\(\*\)/i.test(sql)) return [{ count: 1 }];
      if (/FROM reservations/i.test(sql)) return rows;
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

async function runSyncCheckContract() {
  const mock = createSyncQueryMock();
  const snapshot = createSnapshot();
  const sync = await buildReservationSyncCheck({ date: '2026-07-22' }, {
    queryReadonly: mock.queryReadonly,
    readPickkoSnapshot: () => snapshot,
    nowMs: Date.parse('2026-07-22T05:00:00.000Z'),
  });
  assert.equal(sync.skipped, false);
  assert.equal(sync.evidence.source, 'pickko_live_snapshot');
  assert.equal(sync.counts.naverCompletedMissingPickko, 1);
  assert.equal(sync.counts.cancelledButPickkoEvidence, 1);
  assert.equal(sync.counts.pickkoOnly, 1);
  assert.equal(sync.counts.pickkoRows, 3);
  assert.equal(sync.counts.pendingSnapshotRefresh, 2);
  assert.equal(sync.pendingSnapshotRefresh[0].id, 4);
  assert.equal(sync.pendingSnapshotRefresh[1].id, 5);

  const stale = await buildReservationSyncCheck({ date: '2026-07-22' }, {
    queryReadonly: mock.queryReadonly,
    readPickkoSnapshot: () => snapshot,
    nowMs: Date.parse('2026-07-24T12:00:00.000Z'),
  });
  assert.equal(stale.skipped, true);
  assert.equal(stale.reason, 'pickko_snapshot_stale');
  assert.equal(stale.counts.naverCompletedMissingPickko, 0);
}

async function runCyclePersistenceContract() {
  const persisted = [];
  const logs = [];
  const createDeps = (persist) => ({
    log: (message) => logs.push(String(message)),
    delay: async () => {},
    loginToPickko: async () => {},
    fetchPickkoEntries: async (_page, date, options = {}) => {
      if (options.statusKeyword === '취소' || options.statusKeyword === '환불') return { entries: [], fetchOk: true };
      return {
        entries: [{
          name: 'snapshot-test',
          phoneRaw: '01000000000',
          date,
          start: '10:00',
          end: '10:50',
          room: '스터디룸A1',
          statusText: '결제완료',
        }],
        fetchOk: true,
      };
    },
    getKioskBlock: async () => null,
    compareEntrySequence: () => 0,
    maskName: (value) => value,
    maskPhone: (value) => value,
    persistPickkoLiveSnapshot: persist,
  });
  const service = createKioskPickkoCycleService({
    ...createDeps((payload) => persisted.push(payload)),
  });
  await service.preparePickkoCycle({
    page: { url: () => 'https://pickkoadmin.test/study/index.html' },
    today: '2026-07-22',
    pickkoId: 'id',
    pickkoPw: 'pw',
  });
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].complete, true);
  assert.equal(persisted[0].coverageFrom, '2026-07-22');
  assert.equal(persisted[0].coverageTo, '2026-08-22');

  const isolated = createKioskPickkoCycleService({
    ...createDeps(() => { throw new Error('snapshot disk unavailable'); }),
  });
  await isolated.preparePickkoCycle({
    page: { url: () => 'https://pickkoadmin.test/study/index.html' },
    today: '2026-07-22',
    pickkoId: 'id',
    pickkoPw: 'pw',
  });
  assert.ok(logs.some((line) => line.includes('기록 실패 — 모니터 계속 진행')));
}

function runRangeSourceContract() {
  const source = fs.readFileSync(path.join(__dirname, 'collect-pickko-order-raw-range.ts'), 'utf8');
  assert.equal(source.includes('dist/ts-runtime'), false);
  assert.equal(source.includes('collect-pickko-order-raw.ts'), true);
  assert.equal(source.includes("require.resolve('tsx')"), true);
  assert.match(source, /['"]--import['"],\s*tsxImport/);

  const collectorSource = fs.readFileSync(path.join(__dirname, 'collect-pickko-order-raw.ts'), 'utf8');
  assert.equal(collectorSource.includes('dist/ts-runtime'), false);
}

async function main() {
  runPersistenceContract();
  runAssessmentContract();
  await runSyncCheckContract();
  await runCyclePersistenceContract();
  runRangeSourceContract();
  console.log(JSON.stringify({
    ok: true,
    tests: ['pii-safe-persistence', 'stale-and-coverage', 'sync-guard', 'monitor-wiring', 'tsx-source-range'],
  }));
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
