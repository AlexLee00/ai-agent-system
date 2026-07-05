#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { queryReadonly } = require('../../../packages/core/lib/pg-pool');
const {
  getReservation,
  updateReservation,
  removeCancelledKey,
  markSeen,
} = require('../lib/db.ts');
const kst = require('../../../packages/core/lib/kst');

const PROJECT_ROOT = process.env.PROJECT_ROOT || '/Users/alexlee/projects/ai-agent-system';
const NODE_BIN = process.execPath || '/opt/homebrew/bin/node';
const PICKKO_ACCURATE = path.join(PROJECT_ROOT, 'dist/daemons/ai.ska.pickko-accurate.cjs');
const LOG_PATH = '/tmp/restore-false-pickko-cancellations-20260703.log';
const APPLY = process.argv.includes('--apply');
const INCLUDE_ELAPSED = process.argv.includes('--include-elapsed');
const FUTURE_CANCELLED_CONFIRMED = process.argv.includes('--future-cancelled-confirmed');
const ONLY_ID = String(process.argv.find((arg) => arg.startsWith('--only-id=')) || '').split('=')[1] || '';
const LIMIT_ARG = String(process.argv.find((arg) => arg.startsWith('--limit=')) || '').split('=')[1] || '';
const LIMIT = Number.isFinite(Number(LIMIT_ARG)) && Number(LIMIT_ARG) > 0 ? Number(LIMIT_ARG) : 0;

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function maskPhone(value) {
  const raw = normalizePhone(value);
  if (raw.length < 8) return '***';
  return `${raw.slice(0, 3)}****${raw.slice(-4)}`;
}

function nowKstText() {
  return kst.datetimeStr ? kst.datetimeStr() : new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
}

function isElapsedCandidate(row) {
  const today = kst.today ? kst.today() : new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  if (row.date !== today) return false;
  const now = new Date();
  const start = new Date(`${row.date}T${row.start}:00+09:00`);
  return start.getTime() <= now.getTime();
}

function parsePickkoOrderId(output) {
  const match = String(output || '').match(/\/order\/view\/(\d+)/);
  return match ? match[1] : null;
}

function parsePickkoReservationInfo(output) {
  const match = String(output || '').match(/예약정보:\s*(\d+)\s*\/\s*(\d{4}-\d{2}-\d{2})\s*\/\s*(\d{2}:\d{2})~(\d{2}:\d{2})\s*\/\s*([A-Z0-9]+)/);
  if (!match) return null;
  return {
    phone: match[1],
    date: match[2],
    start: match[3],
    end: match[4],
    room: match[5],
  };
}

function isExactPickkoReservation(row, info) {
  if (!info) return false;
  return info.date === row.date
    && info.start === row.start
    && info.end === row.end
    && info.room === row.room;
}

/**
 * @returns {Promise<{ code: number | null, output: string, error: string | null }>}
 */
function runPickkoAccurate(row) {
  return new Promise((resolve) => {
    const args = [
      PICKKO_ACCURATE,
      `--phone=${row.phone}`,
      `--date=${row.date}`,
      `--start=${row.start}`,
      `--end=${row.end}`,
      `--room=${row.room}`,
      `--name=${row.name || '고객'}`,
    ];
    const child = spawn(NODE_BIN, args, {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PROJECT_ROOT,
        MODE: 'ops',
        MANUAL_RETRY: '1',
        PICKKO_STRICT_REQUEST_WINDOW: '1',
        SKIP_NAME_SYNC: '1',
        HOLD_BROWSER_ON_ERROR: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    const append = (chunk) => {
      const text = String(chunk || '');
      output += text;
      fs.appendFileSync(LOG_PATH, text);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (error) => {
      resolve({ code: 1, output, error: error.message });
    });
    child.on('close', (code) => {
      resolve({ code, output, error: null });
    });
  });
}

function pickkoResultOutput(result) {
  return String(result && typeof result === 'object' && 'output' in result ? result.output : '');
}

function pickkoResultCode(result) {
  const code = result && typeof result === 'object' && 'code' in result ? result.code : 1;
  return typeof code === 'number' && Number.isFinite(code) ? code : 1;
}

function pickkoResultError(result) {
  return String(result && typeof result === 'object' && 'error' in result ? result.error || '' : '');
}

async function loadCandidates() {
  const rows = await queryReadonly('reservation', FUTURE_CANCELLED_CONFIRMED ? `
    select f.booking_key, f.phone_raw, f.room, f.date, f.start_time, f.end_time,
           r.status, r.pickko_status, r.updated_at
    from naver_future_confirmed f
    join reservations r on r.id = f.booking_key
    where (f.date::date > current_date or (f.date::date = current_date and f.start_time::time > current_time))
      and (r.status like 'cancelled%' or r.error_reason like 'false_cancel_restore_failed:%')
    order by f.date, f.start_time
  ` : `
    select f.booking_key, f.phone_raw, f.room, f.date, f.start_time, f.end_time,
           r.status, r.pickko_status, r.updated_at
    from naver_future_confirmed f
    join reservations r on r.id = f.booking_key
    where r.updated_at >= '2026-07-03 10:00:00'
      and (
        (r.updated_at < '2026-07-03 10:12:00' and r.status like 'cancelled%')
        or r.error_reason like 'false_cancel_restore_failed:%'
      )
    order by f.date, f.start_time
  `);

  const candidates = [];
  for (const row of rows) {
    const reservation = await getReservation(row.booking_key);
    const phone = reservation?.phoneRaw || row.phone_raw;
    candidates.push({
      id: row.booking_key,
      name: reservation?.name || '고객',
      phone,
      room: row.room,
      date: row.date,
      start: row.start_time,
      end: row.end_time,
      status: row.status,
      pickkoStatus: row.pickko_status,
      updatedAt: row.updated_at,
      elapsed: isElapsedCandidate({
        date: row.date,
        start: row.start_time,
      }),
    });
  }
  return candidates;
}

async function clearCancelKeys(row) {
  const raw = normalizePhone(row.phone);
  const keys = [
    `cancelid|${row.id}`,
    `cancel_done|${raw}|${row.date}|${row.start}|${row.end}|${row.room}`,
    `cancel|${row.date}|${row.start}|${row.end}|${row.room}|${raw}`,
  ];
  for (const key of keys) {
    await removeCancelledKey(key);
  }
  return keys;
}

async function main() {
  const candidates = await loadCandidates();
  let actionable = candidates.filter((row) => INCLUDE_ELAPSED || !row.elapsed);
  if (ONLY_ID) actionable = actionable.filter((row) => row.id === ONLY_ID);
  if (LIMIT > 0) actionable = actionable.slice(0, LIMIT);
  const elapsed = candidates.filter((row) => row.elapsed);

  console.log(JSON.stringify({
    apply: APPLY,
    includeElapsed: INCLUDE_ELAPSED,
    futureCancelledConfirmed: FUTURE_CANCELLED_CONFIRMED,
    totalCandidates: candidates.length,
    actionable: actionable.length,
    elapsedSkipped: INCLUDE_ELAPSED ? 0 : elapsed.length,
    onlyId: ONLY_ID || null,
    limit: LIMIT || null,
    logPath: LOG_PATH,
    candidates: candidates.map((row) => ({
      id: row.id,
      name: row.name,
      phone: maskPhone(row.phone),
      date: row.date,
      start: row.start,
      end: row.end,
      room: row.room,
      elapsed: row.elapsed,
      status: row.status,
      pickkoStatus: row.pickkoStatus,
    })),
  }, null, 2));

  if (!APPLY) return;

  fs.writeFileSync(LOG_PATH, `[${nowKstText()}] false pickko cancellation restore start\n`, 'utf8');
  const results = [];

  for (const row of actionable) {
    const label = `${row.id} ${row.date} ${row.start}~${row.end} ${row.room} ${maskPhone(row.phone)}`;
    console.log(`RESTORE_START ${label}`);
    fs.appendFileSync(LOG_PATH, `\n===== RESTORE ${label} =====\n`);

    const result = await runPickkoAccurate(row);
    const resultOutput = pickkoResultOutput(result);
    const resultCode = pickkoResultCode(result);
    const resultError = pickkoResultError(result);
    const pickkoOrderId = parsePickkoOrderId(resultOutput);
    const pickkoInfo = parsePickkoReservationInfo(resultOutput);
    const exactReservation = isExactPickkoReservation(row, pickkoInfo);
    const ok = resultCode === 0 && (
      pickkoOrderId
      || resultOutput.includes('픽코 예약등록 + 결제 완료됨')
      || resultOutput.includes('이미 결제완료 상태')
    ) && exactReservation;

    if (ok) {
      await updateReservation(row.id, {
        status: 'completed',
        pickkoStatus: 'paid',
        pickkoOrderId,
        errorReason: null,
        pickkoCompleteTime: nowKstText(),
      });
      await markSeen(row.id);
      const removedKeys = await clearCancelKeys(row);
      results.push({ id: row.id, ok: true, code: resultCode, pickkoOrderId, removedKeys });
      console.log(`RESTORE_OK ${label} order=${pickkoOrderId || '-'}`);
      continue;
    }

    const failureReason = resultError || (pickkoInfo && !exactReservation ? `pickko_time_mismatch:${pickkoInfo.start}-${pickkoInfo.end}` : 'pickko_not_completed');
    await updateReservation(row.id, {
      status: 'failed',
      pickkoStatus: row.pickkoStatus,
      errorReason: `false_cancel_restore_failed:${resultCode}:${failureReason}`,
      pickkoCompleteTime: nowKstText(),
    });
    results.push({ id: row.id, ok: false, code: resultCode, error: failureReason });
    console.log(`RESTORE_FAIL ${label} code=${resultCode} error=${failureReason}`);
  }

  console.log(JSON.stringify({
    apply: true,
    futureCancelledConfirmed: FUTURE_CANCELLED_CONFIRMED,
    restored: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    elapsedSkipped: INCLUDE_ELAPSED ? 0 : elapsed.length,
    results,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
