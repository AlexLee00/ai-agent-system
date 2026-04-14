#!/usr/bin/env node
/**
 * pickko-register.ts — 자연어 예약 등록 CLI
 */

const { spawn } = require('child_process');
const path = require('path');
const { parseArgs } = require('../../lib/args');
const { transformAndNormalizeData } = require('../../lib/validation');
const { addReservation, updateReservation, getReservation, markSeen, upsertKioskBlock, recordKioskBlockAttempt } = require('../../lib/db');
const { buildReservationId } = require('../../lib/reservation-key');
const kst = require('../../../../packages/core/lib/kst');
const { fail } = require('../../lib/cli');
const { IS_OPS } = require('../../../../packages/core/lib/env');
const { createAgentMemory } = require('../../../../packages/core/lib/agent-memory');

const ARGS = parseArgs(process.argv);

type RegisterInput = {
  phone: string;
  date: string;
  start: string;
  end: string;
  room: string;
};

const registerMemory = createAgentMemory({ agentId: 'reservation.pickko-register', team: 'reservation' });

const VALID_ROOMS = ['A1', 'A2', 'B'];
const MODE = IS_OPS ? 'ops' : 'dev';
const IS_MANUAL_RETRY = Boolean(ARGS['manual-retry'] || ARGS.manualRetry);
const IS_PENDING_ONLY = Boolean(ARGS['pending-only'] || ARGS.pendingOnly);
const SKIP_NAME_SYNC = IS_MANUAL_RETRY || Boolean(ARGS['skip-name-sync'] || ARGS.skipNameSync);
const SKIP_NAVER_BLOCK = IS_MANUAL_RETRY || Boolean(ARGS['skip-naver-block'] || ARGS.skipNaverBlock);
const PICKKO_ACCURATE_TIMEOUT_MS = 180_000;

const required = ['date', 'start', 'end', 'room', 'phone'];
const missing = required.filter((k) => !ARGS[k]);
if (missing.length > 0) {
  fail(
    `필수 인자 누락: ${missing.join(', ')}\n` +
    '사용법: node /Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/manual/reservation/pickko-register.js --date=YYYY-MM-DD --start=HH:MM --end=HH:MM --room=A1|A2|B --phone=01000000000 --name=이름',
  );
}

const rawInput: RegisterInput = {
  phone: ARGS.phone,
  date: ARGS.date,
  start: ARGS.start,
  end: ARGS.end,
  room: ARGS.room,
};

const normalized = transformAndNormalizeData(rawInput);
if (!normalized) {
  fail(`입력값 형식 오류: ${JSON.stringify(rawInput)}`);
}

if (!VALID_ROOMS.includes(normalized.room)) {
  fail(`유효하지 않은 룸: ${normalized.room} (허용: ${VALID_ROOMS.join(', ')})`);
}

const customerName = (ARGS.name || '고객').replace(/대리예약.*/, '').trim().slice(0, 20) || '고객';

function buildRegisterMemoryQuery(kind: string) {
  return [
    'reservation pickko register',
    kind,
    normalized.room,
    normalized.date,
    `${normalized.start}-${normalized.end}`,
  ].filter(Boolean).join(' ');
}

const accurateScript = path.join(
  __dirname,
  '../../../../dist/ts-runtime/bots/reservation/manual/reservation/pickko-accurate.js',
);
const childArgs = [
  accurateScript,
  `--phone=${normalized.phone}`,
  `--date=${normalized.date}`,
  `--start=${normalized.start}`,
  `--end=${normalized.end}`,
  `--room=${normalized.room}`,
  `--name=${customerName}`,
];

const child = spawn('node', childArgs, {
  cwd: __dirname,
  env: {
    ...process.env,
    MODE,
    SKIP_NAME_SYNC: SKIP_NAME_SYNC ? '1' : '0',
    MANUAL_RETRY: IS_MANUAL_RETRY ? '1' : '0',
    SKIP_FINAL_PAYMENT: IS_PENDING_ONLY ? '1' : '0',
  },
  stdio: ['ignore', process.stderr, process.stderr],
});

let didTimeout = false;
const timeoutHandle = setTimeout(() => {
  didTimeout = true;
  process.stderr.write(`[pickko-register] 시간 초과(${Math.round(PICKKO_ACCURATE_TIMEOUT_MS / 1000)}초) — 하위 프로세스 종료 시도\n`);
  try { child.kill('SIGTERM'); } catch {}
  setTimeout(() => {
    try { child.kill('SIGKILL'); } catch {}
  }, 5000).unref();
}, PICKKO_ACCURATE_TIMEOUT_MS);
timeoutHandle.unref();

child.on('error', (err: Error) => {
  clearTimeout(timeoutHandle);
  fail(`pickko-accurate 실행 실패: ${err.message}`);
});

child.on('close', async (code: number | null) => {
  clearTimeout(timeoutHandle);
  const key = buildReservationId(normalized.phone, normalized.date, normalized.start);
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  if (didTimeout) {
    const memoryQuery = buildRegisterMemoryQuery('timeout');
    const episodicHint = await registerMemory.recallCountHint(memoryQuery, {
      type: 'episodic',
      limit: 2,
      threshold: 0.33,
      title: '최근 유사 등록',
      separator: 'pipe',
      metadataKey: 'kind',
      labels: {
        success: '성공',
        timeout: '시간초과',
        failure: '실패',
      },
      order: ['timeout', 'failure', 'success'],
    }).catch(() => '');
    const semanticHint = await registerMemory.recallHint(`${memoryQuery} consolidated register pattern`, {
      type: 'semantic',
      limit: 2,
      threshold: 0.28,
      title: '최근 통합 패턴',
      separator: 'newline',
    }).catch(() => '');
    const timeoutMessage = `예약 등록 시간 초과 (${Math.round(PICKKO_ACCURATE_TIMEOUT_MS / 1000)}초)`;
    process.stdout.write(`${JSON.stringify({
      success: false,
      message: timeoutMessage,
      memoryHints: {
        episodicHint,
        semanticHint,
      },
    })}\n`);
    await registerMemory.remember([
      '픽코 예약 등록 시간 초과',
      `phone: ${normalized.phone}`,
      `date: ${normalized.date}`,
      `time: ${normalized.start}~${normalized.end}`,
      `room: ${normalized.room}`,
      timeoutMessage,
    ].join('\n'), 'episodic', {
      importance: 0.84,
      expiresIn: 1000 * 60 * 60 * 24 * 30,
      metadata: {
        kind: 'timeout',
        room: normalized.room,
        date: normalized.date,
        start: normalized.start,
        end: normalized.end,
      },
    }).catch(() => {});
    await registerMemory.consolidate({
      olderThanDays: 14,
      limit: 10,
    }).catch(() => {});
    process.exit(1);
  }

  if (code === 0 || code === 2 || code === 3) {
    const pickkoStatus = code === 2
      ? 'time_elapsed'
      : code === 3
        ? 'manual_pending'
        : (IS_MANUAL_RETRY ? 'manual_retry' : 'manual');
    const errorReason = code === 2 ? '시간 경과로 등록 불가' : null;

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
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[pickko-register] 예약 상태 반영 실패 (${key}): ${message}\n`);
    }

    if ((code === 0 || code === 3) && !SKIP_NAVER_BLOCK) {
      upsertKioskBlock(normalized.phone, normalized.date, normalized.start, {
        name: customerName,
        date: normalized.date,
        start: normalized.start,
        end: normalized.end,
        room: normalized.room,
        amount: 0,
        naverBlocked: false,
        firstSeenAt: kst.datetimeStr(),
        blockedAt: null,
        lastBlockAttemptAt: kst.datetimeStr(),
        lastBlockResult: 'queued',
        lastBlockReason: 'manual_register_spawned',
        blockRetryCount: 0,
      }).catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        process.stderr.write(`[pickko-register] kiosk_blocks 선등록 실패: ${message}\n`);
      });

      const blockArgs = [
        path.join(__dirname, '../../../../dist/ts-runtime/bots/reservation/auto/monitors/pickko-kiosk-monitor.js'),
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
      : code === 3
        ? SKIP_NAVER_BLOCK
          ? `결제대기 예약 등록 완료: ${normalized.phone} ${normalized.date} ${normalized.start}~${normalized.end} ${normalized.room}룸 (${customerName})`
          : `결제대기 예약 등록 완료: ${normalized.phone} ${normalized.date} ${normalized.start}~${normalized.end} ${normalized.room}룸 (${customerName}) — 네이버 예약불가 자동 처리 요청 완료 (실패 시 kiosk-monitor가 재시도)`
        : SKIP_NAVER_BLOCK
        ? `예약 등록 완료: ${normalized.phone} ${normalized.date} ${normalized.start}~${normalized.end} ${normalized.room}룸 (${customerName}) — 재등록 모드로 네이버 차단은 생략`
          : `예약 등록 완료: ${normalized.phone} ${normalized.date} ${normalized.start}~${normalized.end} ${normalized.room}룸 (${customerName}) — 네이버 예약불가 자동 처리 요청 완료 (실패 시 kiosk-monitor가 재시도)`;
    const kind = code === 2 ? 'timeout' : 'success';
    const memoryQuery = buildRegisterMemoryQuery(kind);
    const episodicHint = await registerMemory.recallCountHint(memoryQuery, {
      type: 'episodic',
      limit: 2,
      threshold: 0.33,
      title: '최근 유사 등록',
      separator: 'pipe',
      metadataKey: 'kind',
      labels: {
        success: '성공',
        timeout: '시간초과',
        failure: '실패',
      },
      order: ['success', 'timeout', 'failure'],
    }).catch(() => '');
    const semanticHint = await registerMemory.recallHint(`${memoryQuery} consolidated register pattern`, {
      type: 'semantic',
      limit: 2,
      threshold: 0.28,
      title: '최근 통합 패턴',
      separator: 'newline',
    }).catch(() => '');
    await registerMemory.remember([
      '픽코 예약 등록 결과',
      `phone: ${normalized.phone}`,
      `date: ${normalized.date}`,
      `time: ${normalized.start}~${normalized.end}`,
      `room: ${normalized.room}`,
      message,
    ].join('\n'), 'episodic', {
      importance: code === 2 ? 0.74 : 0.66,
      expiresIn: 1000 * 60 * 60 * 24 * 30,
      metadata: {
        kind,
        room: normalized.room,
        date: normalized.date,
        start: normalized.start,
        end: normalized.end,
        pickkoStatus,
      },
    }).catch(() => {});
    await registerMemory.consolidate({
      olderThanDays: 14,
      limit: 10,
    }).catch(() => {});
    process.stdout.write(`${JSON.stringify({
      success: true,
      message,
      memoryHints: {
        episodicHint,
        semanticHint,
      },
    })}\n`);
    process.exit(0);
  }

  const memoryQuery = buildRegisterMemoryQuery('failure');
  const episodicHint = await registerMemory.recallCountHint(memoryQuery, {
    type: 'episodic',
    limit: 2,
    threshold: 0.33,
    title: '최근 유사 등록',
    separator: 'pipe',
    metadataKey: 'kind',
    labels: {
      success: '성공',
      timeout: '시간초과',
      failure: '실패',
    },
    order: ['failure', 'timeout', 'success'],
  }).catch(() => '');
  const semanticHint = await registerMemory.recallHint(`${memoryQuery} consolidated register pattern`, {
    type: 'semantic',
    limit: 2,
    threshold: 0.28,
    title: '최근 통합 패턴',
    separator: 'newline',
  }).catch(() => '');
  const failureMessage = `예약 등록 실패 (exit: ${code}) — 픽코 로그 확인 필요`;
  process.stdout.write(`${JSON.stringify({
    success: false,
    message: failureMessage,
    memoryHints: {
      episodicHint,
      semanticHint,
    },
  })}\n`);
  await registerMemory.remember([
    '픽코 예약 등록 실패',
    `phone: ${normalized.phone}`,
    `date: ${normalized.date}`,
    `time: ${normalized.start}~${normalized.end}`,
    `room: ${normalized.room}`,
    failureMessage,
  ].join('\n'), 'episodic', {
    importance: 0.8,
    expiresIn: 1000 * 60 * 60 * 24 * 30,
    metadata: {
      kind: 'failure',
      room: normalized.room,
      date: normalized.date,
      start: normalized.start,
      end: normalized.end,
      exitCode: code,
    },
  }).catch(() => {});
  await registerMemory.consolidate({
    olderThanDays: 14,
    limit: 10,
  }).catch(() => {});
  process.exit(1);
});
