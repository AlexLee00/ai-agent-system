#!/usr/bin/env node

/**
 * pickko-register.js — 자연어 예약 등록 CLI 래퍼
 *
 * 사용법:
 *   node src/pickko-register.js \
 *     --date=2026-03-05 \
 *     --start=15:00 \
 *     --end=17:00 \
 *     --room=A1 \
 *     --phone=01012345678 \
 *     --name=홍길동
 *
 * 출력 (stdout JSON):
 *   { success: true,  message: "예약 등록 완료: ..." }
 *   { success: false, message: "오류 내용" }
 *
 * 로그: pickko-accurate.js 출력이 stderr로 전달됨
 */

const { spawn } = require('child_process');
const path = require('path');
const { parseArgs } = require('../lib/args');
const { transformAndNormalizeData } = require('../lib/validation');
const { loadJson, saveJson } = require('../lib/files');

const ARGS = parseArgs(process.argv);

const VALID_ROOMS = ['A1', 'A2', 'B'];
const MODE = process.env.MODE || 'ops';
const SEEN_FILE = path.join(__dirname, '..', MODE === 'ops' ? 'naver-seen.json' : 'naver-seen-dev.json');

function fail(message) {
  process.stdout.write(JSON.stringify({ success: false, message }) + '\n');
  process.exit(1);
}

// ── 필수 인자 검증 ──
const required = ['date', 'start', 'end', 'room', 'phone'];
const missing = required.filter(k => !ARGS[k]);
if (missing.length > 0) {
  fail(`필수 인자 누락: ${missing.join(', ')}\n사용법: node pickko-register.js --date=YYYY-MM-DD --start=HH:MM --end=HH:MM --room=A1|A2|B --phone=01000000000 --name=이름`);
}

// ── 입력값 정규화 (lib/validation.js) ──
const rawInput = {
  phone: ARGS.phone,
  date: ARGS.date,
  start: ARGS.start,
  end: ARGS.end,
  room: ARGS.room
};

const normalized = transformAndNormalizeData(rawInput);
if (!normalized) {
  fail(`입력값 형식 오류: ${JSON.stringify(rawInput)}`);
}

// ── 룸 유효성 검증 ──
if (!VALID_ROOMS.includes(normalized.room)) {
  fail(`유효하지 않은 룸: ${normalized.room} (허용: ${VALID_ROOMS.join(', ')})`);
}

const customerName = (ARGS.name || '고객').replace(/대리예약.*/, '').trim().slice(0, 20) || '고객';

// ── pickko-accurate.js 실행 ──
const accurateScript = path.join(__dirname, 'pickko-accurate.js');
const childArgs = [
  accurateScript,
  `--phone=${normalized.phone}`,
  `--date=${normalized.date}`,
  `--start=${normalized.start}`,
  `--end=${normalized.end}`,
  `--room=${normalized.room}`,
  `--name=${customerName}`
];

const child = spawn('node', childArgs, {
  cwd: __dirname,
  env: { ...process.env, MODE: process.env.MODE || 'ops' },
  // child stdout/stderr → 부모의 stderr (로그용), 부모 stdout은 JSON 전용
  stdio: ['ignore', process.stderr, process.stderr]
});

child.on('error', err => {
  fail(`pickko-accurate.js 실행 실패: ${err.message}`);
});

child.on('close', code => {
  if (code === 0) {
    // naver-seen.json에 manual 항목 기록 (pickko-daily-audit 오탐 방지)
    try {
      const seenData = loadJson(SEEN_FILE);
      const key = `manual-${normalized.phone}-${normalized.date}-${normalized.start.replace(':', '')}`;
      if (!seenData[key]) {
        seenData[key] = {
          compositeKey: `${normalized.phone}-${normalized.date}-${normalized.start}`,
          name: customerName,
          phone: normalized.phone.replace(/(\d{3})(\d{4})(\d{4})/, '$1-$2-$3'),
          phoneRaw: normalized.phone,
          date: normalized.date,
          start: normalized.start,
          end: normalized.end,
          room: normalized.room,
          detectedAt: new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
          status: 'completed',
          pickkoStatus: 'manual',
          pickkoOrderId: null,
          errorReason: null,
          retries: 0,
          pickkoStartTime: new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
        };
        saveJson(SEEN_FILE, seenData);
      }
    } catch (e) {
      // seen 기록 실패는 등록 성공에 영향 없음
    }
    process.stdout.write(JSON.stringify({
      success: true,
      message: `예약 등록 완료: ${normalized.phone} ${normalized.date} ${normalized.start}~${normalized.end} ${normalized.room}룸 (${customerName})`
    }) + '\n');
    process.exit(0);
  } else {
    process.stdout.write(JSON.stringify({
      success: false,
      message: `예약 등록 실패 (exit: ${code}) — 픽코 로그 확인 필요`
    }) + '\n');
    process.exit(1);
  }
});
