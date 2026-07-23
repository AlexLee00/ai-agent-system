#!/usr/bin/env node
'use strict';
/**
 * Reviewed JSON batch input -> Pickko registration -> Naver slot blocking.
 * Room fallback is allowed only when Pickko registration did not complete.
 */

const { spawn } = require('child_process');
const fs = require('node:fs');
const path = require('path');
const { classifyBatchRegisterExitCode } = require('../lib/pickko-register-contract');

const NODE_BIN = process.execPath || '/opt/homebrew/bin/node';

type Booking = {
  name: string;
  phone: string;
  date: string;
  start: string;
  end: string;
  room: 'A1' | 'A2' | 'B';
};

const ROOM_FALLBACK: Record<Booking['room'], Booking['room'][]> = {
  A1: ['A1', 'A2', 'B'],
  A2: ['A2', 'B'],
  B: ['B'],
};

const PICKKO_REGISTER = path.join(__dirname, '../manual/reservation/pickko-register.ts');

function runNode(scriptPath: string, args: string[]): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE_BIN, [scriptPath, ...args], {
      cwd: path.dirname(scriptPath),
      stdio: 'inherit',
      env: { ...process.env, MODE: 'ops', HOLD_BROWSER_ON_ERROR: '0' },
    });
    child.on('close', (code) => resolve(code));
    child.on('error', reject);
  });
}

function loadBookings(argv = process.argv): Booking[] {
  const inputArg = argv.find((arg) => arg.startsWith('--input='));
  if (!inputArg) return [];
  const inputPath = path.resolve(inputArg.slice('--input='.length));
  const parsed = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('batch input must be a JSON array');
  return parsed.map((booking, index) => {
    const missing = ['name', 'phone', 'date', 'start', 'end', 'room'].filter((key) => !booking?.[key]);
    if (missing.length > 0 || !['A1', 'A2', 'B'].includes(booking.room)) {
      throw new Error(`invalid booking at index ${index}: ${missing.join(',') || 'room'}`);
    }
    return booking as Booking;
  });
}

async function main() {
  const bookings = loadBookings();
  if (bookings.length === 0) {
    throw new Error('no bookings: pass a reviewed JSON file with --input=/absolute/path/bookings.json');
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`대리예약 배치: ${bookings.length}건`);
  console.log(`${'═'.repeat(60)}`);

  let bookingOk = 0;
  let bookingFail = 0;
  let bookingFollowup = 0;

  for (const booking of bookings) {
    const baseLabel = `${booking.date} ${booking.start}~${booking.end} (${booking.name})`;
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`📋 처리 중: ${baseLabel}`);
    console.log(`${'─'.repeat(60)}`);

    const fallbacks = ROOM_FALLBACK[booking.room] || [booking.room];
    let bookedRoom = null;

    for (const room of fallbacks) {
      console.log(`\n[1/1] 예약 등록 — ${room}룸 시도`);
      const code = await runNode(PICKKO_REGISTER, [
        `--phone=${booking.phone}`,
        `--date=${booking.date}`,
        `--start=${booking.start}`,
        `--end=${booking.end}`,
        `--room=${room}`,
        `--name=${booking.name}`,
        '--skip-name-sync',
      ]).catch(() => 1);

      const outcome = classifyBatchRegisterExitCode(code);
      if (outcome === 'complete') {
        bookedRoom = room;
        bookingOk += 1;
        console.log(`✅ 예약 등록 + 네이버 차단 성공 (exit ${code}) — ${room}룸`);
        break;
      }
      if (outcome === 'registered_followup') {
        bookedRoom = room;
        bookingFollowup += 1;
        console.log(`⚠️ 픽코 등록 완료·네이버 차단 후속 필요 (exit ${code}) — 다음 룸 재시도 금지`);
        break;
      }
      if (outcome === 'terminal_failure') {
        console.log(`⚠️ ${room}룸 등록 불가 (exit ${code}) — 룸 폴백으로 해소할 수 없어 재시도 중단`);
        break;
      }
      console.log(`⚠️ ${room}룸 미등록 (exit ${code}) → 다음 룸 시도`);
    }

    if (!bookedRoom) {
      console.error(`❌ 예약 등록 실패: ${baseLabel}`);
      bookingFail += 1;
    }
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log('배치 완료 결과');
  console.log(`${'═'.repeat(60)}`);
  console.log(`예약 등록 + 네이버 차단: ✅ ${bookingOk}건 / ❌ ${bookingFail}건`);
  console.log(`픽코 등록 완료·네이버 후속 필요: ⚠️ ${bookingFollowup}건`);
  console.log(`${'═'.repeat(60)}\n`);

  if (bookingFail > 0 || bookingFollowup > 0) process.exit(1);
}

module.exports = {
  ROOM_FALLBACK,
  loadBookings,
  runNode,
  main,
};

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ 배치 실행 오류: ${message}`);
    process.exit(1);
  });
}
