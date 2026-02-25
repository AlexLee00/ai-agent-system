#!/usr/bin/env node

/**
 * pickko-cancel-cmd.js — 스카 자연어 취소 명령용 래퍼
 *
 * 스카봇이 텔레그램 취소 명령을 받으면 이 파일을 실행함.
 * (naver-monitor.js 자동 취소는 pickko-cancel.js를 직접 사용)
 *
 * 사용법:
 *   node src/pickko-cancel-cmd.js \
 *     --phone=01012345678 --date=2026-03-05 \
 *     --start=15:00 --end=17:00 --room=A1 [--name=홍길동]
 *
 * 출력 (stdout JSON):
 *   { success: true,  message: "예약 취소 완료: ..." }
 *   { success: false, message: "오류 내용" }
 *
 * 로그: pickko-cancel.js 출력이 stderr로 전달됨
 */

const { spawn } = require('child_process');
const path = require('path');
const { parseArgs } = require('../lib/args');

const ARGS = parseArgs(process.argv);

function fail(message) {
  process.stdout.write(JSON.stringify({ success: false, message }) + '\n');
  process.exit(1);
}

// ── 필수 인자 검증 ──
const required = ['phone', 'date', 'start', 'end', 'room'];
const missing = required.filter(k => !ARGS[k]);
if (missing.length > 0) {
  fail(`필수 인자 누락: ${missing.join(', ')}\n사용법: node pickko-cancel-cmd.js --phone=01000000000 --date=YYYY-MM-DD --start=HH:MM --end=HH:MM --room=A1|A2|B`);
}

const phoneRaw = ARGS.phone.replace(/\D/g, '');
if (!/^\d{10,11}$/.test(phoneRaw)) {
  fail(`전화번호 형식 오류: ${ARGS.phone}`);
}

if (!/^\d{4}-\d{2}-\d{2}$/.test(ARGS.date)) {
  fail(`날짜 형식 오류: ${ARGS.date} (YYYY-MM-DD 필요)`);
}

const VALID_ROOMS = ['A1', 'A2', 'B'];
const room = ARGS.room.replace(/룸|room/gi, '').toUpperCase();
if (!VALID_ROOMS.includes(room)) {
  fail(`유효하지 않은 룸: ${ARGS.room} (허용: ${VALID_ROOMS.join(', ')})`);
}

// ── pickko-cancel.js 실행 ──
const cancelScript = path.join(__dirname, 'pickko-cancel.js');
const childArgs = [
  cancelScript,
  `--phone=${phoneRaw}`,
  `--date=${ARGS.date}`,
  `--start=${ARGS.start}`,
  `--end=${ARGS.end}`,
  `--room=${room}`,
  ...(ARGS.name ? [`--name=${ARGS.name}`] : [])
];

const child = spawn('node', childArgs, {
  cwd: __dirname,
  env: { ...process.env, MODE: process.env.MODE || 'ops' },
  // child의 stdout/stderr → 부모의 stderr (로그용), 부모 stdout은 JSON 전용
  stdio: ['ignore', process.stderr, process.stderr]
});

child.on('error', err => {
  fail(`pickko-cancel.js 실행 실패: ${err.message}`);
});

child.on('close', code => {
  if (code === 0) {
    process.stdout.write(JSON.stringify({
      success: true,
      message: `예약 취소 완료: ${phoneRaw} ${ARGS.date} ${ARGS.start}~${ARGS.end} ${room}룸${ARGS.name ? ` (${ARGS.name})` : ''}`
    }) + '\n');
    process.exit(0);
  } else {
    process.stdout.write(JSON.stringify({
      success: false,
      message: `예약 취소 실패 (exit: ${code}) — 픽코 수동 취소 필요`
    }) + '\n');
    process.exit(1);
  }
});
