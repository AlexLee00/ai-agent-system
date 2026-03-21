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
 * 흐름:
 *   1. pickko-cancel.js  — 픽코 어드민에서 예약 취소 처리
 *   2. pickko-kiosk-monitor.js --unblock-slot — 네이버 예약불가 → 예약가능 복구
 *
 * 로그: 각 child 출력이 stderr로 전달됨
 */

const { spawn } = require('child_process');
const path = require('path');
const { parseArgs } = require('../../lib/args');
const { fail } = require('../../lib/cli');

const ARGS = parseArgs(process.argv);

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

// ── 공통 spawn 헬퍼 ──
function runScript(scriptPath, args, label) {
  return new Promise((resolve) => {
    const child = spawn('node', [scriptPath, ...args], {
      cwd: __dirname,
      env: { ...process.env, MODE: process.env.MODE || 'ops' },
      stdio: ['ignore', process.stderr, process.stderr]
    });
    child.on('error', err => {
      process.stderr.write(`[${label}] 실행 실패: ${err.message}\n`);
      resolve(false);
    });
    child.on('close', code => resolve(code === 0));
  });
}

// ── Step 1: 픽코 예약 취소 ──
const cancelScript = path.join(__dirname, 'pickko-cancel.js');
const cancelArgs = [
  `--phone=${phoneRaw}`,
  `--date=${ARGS.date}`,
  `--start=${ARGS.start}`,
  `--end=${ARGS.end}`,
  `--room=${room}`,
  ...(ARGS.name ? [`--name=${ARGS.name}`] : [])
];

process.stderr.write(`[pickko-cancel-cmd] 픽코 취소 시작: ${phoneRaw} ${ARGS.date} ${ARGS.start}~${ARGS.end} ${room}룸\n`);

runScript(cancelScript, cancelArgs, 'pickko-cancel').then(async (cancelOk) => {
  if (!cancelOk) {
    process.stdout.write(JSON.stringify({
      success: false,
      message: `예약 취소 실패 — 픽코 수동 취소 필요`
    }) + '\n');
    process.exit(1);
  }

  process.stderr.write(`[pickko-cancel-cmd] 픽코 취소 완료 → 네이버 해제 시작\n`);

  // ── Step 2: 네이버 예약불가 → 예약가능 해제 ──
  const kioskScript = path.join(__dirname, '../../auto/monitors/pickko-kiosk-monitor.js');
  const unblockArgs = [
    '--unblock-slot',
    `--phone=${phoneRaw}`,
    `--date=${ARGS.date}`,
    `--start=${ARGS.start}`,
    `--end=${ARGS.end}`,
    `--room=${room}`,
    ...(ARGS.name ? [`--name=${ARGS.name}`] : [])
  ];

  const unblockOk = await runScript(kioskScript, unblockArgs, 'unblock-slot');

  const nameStr = ARGS.name ? ` (${ARGS.name})` : '';
  const baseInfo = `${phoneRaw} ${ARGS.date} ${ARGS.start}~${ARGS.end} ${room}룸${nameStr}`;

  if (unblockOk) {
    process.stdout.write(JSON.stringify({
      success: true,
      message: `예약 취소 완료: ${baseInfo}`
    }) + '\n');
    process.exit(0);
  } else {
    // 픽코 취소는 성공했지만 네이버 해제 실패
    // 상위 응답 레이어가 success만 보고 완전 성공으로 안내하지 않도록
    // partial failure를 명시적으로 실패로 돌려준다.
    process.stdout.write(JSON.stringify({
      success: false,
      partialSuccess: true,
      pickkoCancelled: true,
      naverUnblockFailed: true,
      message: `예약 취소 완료 (픽코), 네이버 해제 실패 — 수동 확인 필요: ${baseInfo}`
    }) + '\n');
    process.exit(2);
  }
});
