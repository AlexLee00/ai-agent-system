#!/usr/bin/env node
/**
 * 픽코 예약 일괄 재등록 (감지3 오취소 복구용)
 */

const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../../..');

type Reservation = {
  phone: string;
  date: string;
  start: string;
  end: string;
  room: string;
  name: string;
};

const reservations: Reservation[] = [
  { phone: '01090187345', date: '2026-03-05', start: '17:30', end: '18:20', room: 'A2', name: '이효진' },
  { phone: '01043602074', date: '2026-03-06', start: '17:30', end: '18:20', room: 'A1', name: '김경혜' },
  { phone: '01030903105', date: '2026-03-07', start: '10:30', end: '12:00', room: 'A2', name: '이원준' },
  { phone: '01033973384', date: '2026-03-07', start: '13:30', end: '17:30', room: 'B', name: '배솔' },
  { phone: '01029320478', date: '2026-03-08', start: '13:00', end: '16:00', room: 'B', name: '고객' },
  { phone: '01089623069', date: '2026-03-09', start: '19:00', end: '22:00', room: 'A1', name: '한송이' },
  { phone: '01090187345', date: '2026-03-10', start: '20:00', end: '20:50', room: 'A1', name: '이효진' },
  { phone: '01021875073', date: '2026-03-14', start: '09:00', end: '11:00', room: 'B', name: '이영화' },
  { phone: '01030903105', date: '2026-03-14', start: '10:30', end: '12:00', room: 'A2', name: '이원준' },
  { phone: '01033973384', date: '2026-03-14', start: '13:30', end: '17:30', room: 'B', name: '배솔' },
  { phone: '01090187345', date: '2026-03-17', start: '20:00', end: '20:50', room: 'A1', name: '이효진' },
  { phone: '01033973384', date: '2026-03-21', start: '13:30', end: '17:30', room: 'B', name: '배솔' },
  { phone: '01089623069', date: '2026-03-23', start: '19:00', end: '22:00', room: 'A1', name: '한송이' },
  { phone: '01090187345', date: '2026-03-24', start: '20:00', end: '20:50', room: 'A1', name: '이효진' },
  { phone: '01030903105', date: '2026-03-28', start: '10:30', end: '12:00', room: 'A1', name: '이원준' },
  { phone: '01089623069', date: '2026-03-30', start: '19:00', end: '22:00', room: 'A1', name: '한송이' },
  { phone: '01090187345', date: '2026-03-31', start: '20:00', end: '20:50', room: 'A1', name: '이효진' },
];

const REGISTER_SCRIPT = path.join(
  ROOT,
  'dist/ts-runtime/bots/reservation/manual/reservation/pickko-accurate.js',
);

function runRegister(res: Reservation, index: number): Promise<number | null> {
  return new Promise((resolve) => {
    console.log(`\n[${index + 1}/${reservations.length}] ${res.date} ${res.start}~${res.end} ${res.room} ${res.phone} (${res.name})`);
    const args = [
      REGISTER_SCRIPT,
      `--phone=${res.phone}`,
      `--date=${res.date}`,
      `--start=${res.start}`,
      `--end=${res.end}`,
      `--room=${res.room}`,
      `--name=${res.name}`,
    ];
    const child = spawn('node', args, {
      stdio: 'inherit',
      env: { ...process.env, MODE: 'ops' },
    });
    child.on('exit', (code: number | null) => {
      if (code === 0) {
        console.log(`  ✅ 완료: ${res.date} ${res.phone}`);
      } else {
        console.log(`  ❌ 실패(exit ${code}): ${res.date} ${res.phone}`);
      }
      resolve(code);
    });
  });
}

async function main() {
  console.log('🔄 픽코 예약 일괄 재등록 시작 (17건)');
  console.log('⚠️  감지3 오취소 복구 배치');
  const results = { ok: 0, fail: 0 };
  for (let i = 0; i < reservations.length; i++) {
    const code = await runRegister(reservations[i], i);
    if (code === 0) results.ok++;
    else results.fail++;
    if (i < reservations.length - 1) {
      console.log('  ⏳ 3초 대기...');
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  console.log(`\n✅ 완료: 성공 ${results.ok}건 / 실패 ${results.fail}건`);
}

module.exports = {
  reservations,
  runRegister,
  main,
};

main().catch((e: unknown) => {
  const message = e instanceof Error ? e.message : String(e);
  console.error('오류:', message);
  process.exit(1);
});
