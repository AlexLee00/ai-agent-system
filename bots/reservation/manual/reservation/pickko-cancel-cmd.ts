#!/usr/bin/env node
// @ts-nocheck

/**
 * pickko-cancel-cmd.js — 스카 자연어 취소 명령용 래퍼
 */

const { spawn } = require('child_process');
const path = require('path');
const { parseArgs } = require('../../lib/args');
const { fail } = require('../../lib/cli');
const { IS_OPS } = require('../../../../packages/core/lib/env');

const ARGS = parseArgs(process.argv);

const required = ['phone', 'date', 'start', 'end', 'room'];
const missing = required.filter((k) => !ARGS[k]);
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

function runScript(scriptPath, args, label) {
  return new Promise((resolve) => {
    const child = spawn('node', [scriptPath, ...args], {
      cwd: __dirname,
      env: { ...process.env, MODE: IS_OPS ? 'ops' : 'dev' },
      stdio: ['ignore', process.stderr, process.stderr],
    });
    child.on('error', (err) => {
      process.stderr.write(`[${label}] 실행 실패: ${err.message}\n`);
      resolve(false);
    });
    child.on('close', (code) => resolve(code === 0));
  });
}

const cancelScript = path.join(__dirname, 'pickko-cancel.js');
const cancelArgs = [
  `--phone=${phoneRaw}`,
  `--date=${ARGS.date}`,
  `--start=${ARGS.start}`,
  `--end=${ARGS.end}`,
  `--room=${room}`,
  ...(ARGS.name ? [`--name=${ARGS.name}`] : []),
];

process.stderr.write(`[pickko-cancel-cmd] 픽코 취소 시작: ${phoneRaw} ${ARGS.date} ${ARGS.start}~${ARGS.end} ${room}룸\n`);

runScript(cancelScript, cancelArgs, 'pickko-cancel').then(async (cancelOk) => {
  if (!cancelOk) {
    process.stdout.write(`${JSON.stringify({
      success: false,
      message: '예약 취소 실패 — 픽코 수동 취소 필요',
    })}\n`);
    process.exit(1);
  }

  const nameStr = ARGS.name ? ` (${ARGS.name})` : '';
  const baseInfo = `${phoneRaw} ${ARGS.date} ${ARGS.start}~${ARGS.end} ${room}룸${nameStr}`;

  process.stdout.write(`${JSON.stringify({
    success: true,
    message: `예약 취소 완료: ${baseInfo}`,
  })}\n`);
  process.exit(0);
});
