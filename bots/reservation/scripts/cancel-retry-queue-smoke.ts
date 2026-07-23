// @ts-nocheck
'use strict';

const assert = require('assert');
const {
  buildCancelRetryKey,
  classifyPickkoCancelFailure,
  createCancelRetryEngine,
  nextRetryDelayMinutes,
} = require('../lib/cancel-retry-engine.ts');

function createDb() {
  const rows = new Map();
  const calls = [];
  return {
    rows,
    calls,
    async run(sql, params = []) {
      calls.push({ sql, params });
      if (/WITH due AS/i.test(sql) && /FOR UPDATE SKIP LOCKED/i.test(sql)) {
        const claimed = Array.from(rows.values())
          .filter((row) => row.status === 'pending')
          .slice(0, Number(params[0] || 5));
        for (const row of claimed) {
          row.status = 'running';
          row.attempts = Number(row.attempts || 0) + 1;
        }
        return { rowCount: claimed.length, rows: claimed };
      } else if (/INSERT INTO cancel_retry_queue/i.test(sql)) {
        rows.set(params[0], {
          cancel_key: params[0],
          booking_id: params[1],
          phone_raw: params[2],
          date: params[3],
          start_time: params[4],
          end_time: params[5],
          room: params[6],
          reason: params[7],
          attempts: params[8],
          status: params[9],
          last_exit_code: params[10],
          last_error: params[11],
        });
      } else if (/status = 'succeeded'/.test(sql)) {
        const row = rows.get(params[0]);
        if (row) row.status = 'succeeded';
      } else if (/SET status=\$2/.test(sql)) {
        const row = rows.get(params[0]);
        row.status = params[1];
        if (/last_exit_code=\$3/.test(sql)) row.last_exit_code = params[2];
        if (/last_error=\$3/.test(sql)) row.last_error = params[2];
      } else if (/SET status='pending'/.test(sql)) {
        const row = rows.get(params[0]);
        row.status = 'pending';
        if (/last_exit_code=\$2/.test(sql)) row.last_exit_code = params[1];
        if (/last_error=\$2/.test(sql)) row.last_error = params[1];
      }
      return { rowCount: 1 };
    },
    async query() {
      return Array.from(rows.values()).filter((row) => row.status === 'pending');
    },
  };
}

async function main() {
  assert.equal(classifyPickkoCancelFailure({ failureStage: 'CHILD_TIMEOUT' }), 'timeout');
  assert.equal(classifyPickkoCancelFailure({ output: 'net::ERR_NETWORK_CHANGED' }), 'network');
  assert.equal(classifyPickkoCancelFailure({ output: '회원 검색 안됨' }), 'member_missing');
  assert.equal(classifyPickkoCancelFailure({ output: '취소 대상 예약 미발견' }), 'matched_fail');
  assert.equal(classifyPickkoCancelFailure({ output: 'something else' }), 'unknown');
  assert.equal(nextRetryDelayMinutes(1, { SKA_CANCEL_RETRY_BASE_DELAY_MINUTES: '10' }), 10);
  assert.equal(nextRetryDelayMinutes(3, { SKA_CANCEL_RETRY_BASE_DELAY_MINUTES: '10' }), 40);

  const booking = {
    bookingId: 'b1',
    phone: '01012345678',
    date: '2026-07-03',
    start: '10:00',
    end: '11:00',
    room: 'A1',
  };
  assert.equal(buildCancelRetryKey(booking), 'cancel_done|01012345678|2026-07-03|10:00|11:00|A1');

  const disabledDb = createDb();
  const disabled = createCancelRetryEngine({
    db: disabledDb,
    env: {},
  });
  assert.equal((await disabled.recordFailure({ booking, output: 'timeout', exitCode: 1 })).skipped, true);
  assert.equal(disabledDb.calls.length, 0, 'env OFF must not write queue');

  const db = createDb();
  const engine = createCancelRetryEngine({
    db,
    env: { SKA_CANCEL_RETRY_ENABLED: 'true', SKA_CANCEL_RETRY_MAX_ATTEMPTS: '1', SKA_CANCEL_RETRY_BASE_DELAY_MINUTES: '5' },
  });

  const pending = await engine.recordFailure({ booking, output: 'TimeoutError', exitCode: 1 });
  assert.equal(pending.status, 'pending');
  assert.equal(pending.reason, 'timeout');
  assert.equal(db.rows.get(pending.cancelKey).status, 'pending');

  await engine.markSucceeded({ booking, cancelKey: pending.cancelKey });
  assert.equal(db.rows.get(pending.cancelKey).status, 'succeeded');

  const permanent = await engine.recordFailure({ booking: { ...booking, bookingId: 'b2' }, cancelKey: 'cancelid|b2', output: '회원 검색 안됨', exitCode: 1 });
  assert.equal(permanent.status, 'manual_required');
  assert.equal(permanent.reason, 'member_missing');

  await engine.recordFailure({ booking: { ...booking, bookingId: 'b3' }, cancelKey: 'cancelid|b3', output: 'TimeoutError', exitCode: 1 });
  const result = await engine.processDueQueue({
    runPickkoCancel: async () => 1,
    limit: 5,
  });
  assert.equal(result.processed >= 1, true);
  assert.equal(db.rows.get('cancelid|b3').status, 'exhausted');
  const claimCall = db.calls.find((call) => /WITH due AS/i.test(call.sql));
  assert.ok(claimCall, 'queue processor must atomically claim due rows');
  assert.match(claimCall.sql, /FOR UPDATE SKIP LOCKED/i);
  assert.match(claimCall.sql, /status = 'running'/i);
  assert.match(claimCall.sql, /updated_at < NOW\(\) -/i);

  await engine.recordFailure({ booking: { ...booking, bookingId: 'b4' }, cancelKey: 'cancel_done|01012345678|2026-07-03|10:00|11:00|A1', output: 'TimeoutError', exitCode: 1 });
  await engine.processDueQueue({
    runPickkoCancel: async () => { throw new Error('temporary browser crash'); },
    limit: 5,
  });
  assert.equal(db.rows.get('cancel_done|01012345678|2026-07-03|10:00|11:00|A1').status, 'exhausted');
  assert.match(db.rows.get('cancel_done|01012345678|2026-07-03|10:00|11:00|A1').last_error, /temporary browser crash/);

  console.log(JSON.stringify({ ok: true, tests: ['classify', 'backoff', 'env-off', 'record', 'processor'] }));
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
