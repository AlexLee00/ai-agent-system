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
const { parseArgs } = require('../../lib/args');
const { transformAndNormalizeData } = require('../../lib/validation');
const { addReservation, updateReservation, getReservation, markSeen, upsertKioskBlock, recordKioskBlockAttempt } = require('../../lib/db');
const { buildReservationId } = require('../../lib/reservation-key');
const kst = require('../../../../packages/core/lib/kst');
const { fail } = require('../../lib/cli');

const ARGS = parseArgs(process.argv);

const VALID_ROOMS = ['A1', 'A2', 'B'];
const MODE = process.env.MODE || 'ops';
const IS_MANUAL_RETRY = Boolean(ARGS['manual-retry'] || ARGS.manualRetry);
const SKIP_NAME_SYNC = IS_MANUAL_RETRY || Boolean(ARGS['skip-name-sync'] || ARGS.skipNameSync);
const SKIP_NAVER_BLOCK = IS_MANUAL_RETRY || Boolean(ARGS['skip-naver-block'] || ARGS.skipNaverBlock);

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
  env: {
    ...process.env,
    MODE: process.env.MODE || 'ops',
    SKIP_NAME_SYNC: SKIP_NAME_SYNC ? '1' : '0',
    MANUAL_RETRY: IS_MANUAL_RETRY ? '1' : '0',
  },
  // child stdout/stderr → 부모의 stderr (로그용), 부모 stdout은 JSON 전용
  stdio: ['ignore', process.stderr, process.stderr]
});

child.on('error', err => {
  fail(`pickko-accurate.js 실행 실패: ${err.message}`);
});

child.on('close', async (code) => {
  const key = buildReservationId(normalized.phone, normalized.date, normalized.start);
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  if (code === 0 || code === 2) {
    // DB에 항목 기록 (code 0: manual 완료, code 2: 시간 경과 완료)
    const pickkoStatus = code === 2 ? 'time_elapsed' : (IS_MANUAL_RETRY ? 'manual_retry' : 'manual');
    const errorReason  = code === 2 ? '시간 경과로 등록 불가' : null;
    try {
      const existing = await getReservation(key);
      if (existing) {
        await updateReservation(key, { status: 'completed', pickkoStatus, errorReason, pickkoStartTime: now });
      } else {
        await addReservation(key, {
          compositeKey: key,
          name: customerName,
          phone: normalized.phone.replace(/(\d{3})(\d{4})(\d{4})/, '$1-$2-$3'),
          phoneRaw: normalized.phone,
          date: normalized.date,
          start: normalized.start,
          end: normalized.end,
          room: normalized.room,
          detectedAt: now,
          status: 'completed',
          pickkoStatus,
          errorReason,
          retries: 0,
          pickkoStartTime: now,
        });
      }
      await markSeen(key);
    } catch (e) {
      process.stderr.write(`[pickko-register] 예약 상태 반영 실패 (${key}): ${e.message}\n`);
    }

    // 픽코 등록 성공(code 0) 시 네이버 예약불가 처리
    if (code === 0 && !SKIP_NAVER_BLOCK) {
      // 1. DB 선등록 (naverBlocked=false) — spawn 실패 시 kiosk-monitor Phase 2A가 자동 재시도
      upsertKioskBlock(normalized.phone, normalized.date, normalized.start, {
        name: customerName, date: normalized.date, start: normalized.start,
        end: normalized.end, room: normalized.room, amount: 0,
        naverBlocked: false, firstSeenAt: kst.datetimeStr(), blockedAt: null,
        lastBlockAttemptAt: kst.datetimeStr(),
        lastBlockResult: 'queued',
        lastBlockReason: 'manual_register_spawned',
        blockRetryCount: 0,
      }).catch(e => process.stderr.write(`[pickko-register] kiosk_blocks 선등록 실패: ${e.message}\n`));

      // 2. spawn으로 즉시 차단 시도 (빠른 경로, fire-and-forget)
      const blockArgs = [
        path.join(__dirname, '../../auto/monitors/pickko-kiosk-monitor.js'),
        '--block-slot',
        `--date=${normalized.date}`,
        `--start=${normalized.start}`,
        `--end=${normalized.end}`,
        `--room=${normalized.room}`,
        `--phone=${normalized.phone}`,
        `--name=${customerName}`,
      ];
      const blockChild = spawn('node', blockArgs, {
        cwd: __dirname,
        env: process.env,
        stdio: ['ignore', process.stderr, process.stderr],
        detached: true,
      });
      blockChild.on('error', (error) => {
        recordKioskBlockAttempt(normalized.phone, normalized.date, normalized.start, {
          name: customerName,
          date: normalized.date,
          start: normalized.start,
          end: normalized.end,
          room: normalized.room,
          amount: 0,
          naverBlocked: false,
          lastBlockAttemptAt: kst.datetimeStr(),
          lastBlockResult: 'spawn_failed',
          lastBlockReason: error.message,
          incrementRetry: true,
        }).catch((dbError) => process.stderr.write(`[pickko-register] kiosk_blocks spawn 실패 기록 실패: ${dbError.message}\n`));
      });
      blockChild.unref();
    }

    const message = code === 2
      ? `시간 경과로 픽코 등록 생략: ${normalized.phone} ${normalized.date} ${normalized.start}~${normalized.end} ${normalized.room}룸 — 픽코에서 직접 확인 필요`
      : SKIP_NAVER_BLOCK
        ? `예약 등록 완료: ${normalized.phone} ${normalized.date} ${normalized.start}~${normalized.end} ${normalized.room}룸 (${customerName}) — 재등록 모드로 네이버 차단은 생략`
        : `예약 등록 완료: ${normalized.phone} ${normalized.date} ${normalized.start}~${normalized.end} ${normalized.room}룸 (${customerName}) — 네이버 예약불가 자동 처리 요청 완료 (실패 시 kiosk-monitor가 재시도)`;
    process.stdout.write(JSON.stringify({ success: true, message }) + '\n');
    process.exit(0);
  } else {
    process.stdout.write(JSON.stringify({
      success: false,
      message: `예약 등록 실패 (exit: ${code}) — 픽코 로그 확인 필요`
    }) + '\n');
    process.exit(1);
  }
});
