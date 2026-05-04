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
const { buildReservationCliInsight } = require('../../lib/cli-insight');

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
const ASYNC_NAVER_BLOCK = Boolean(ARGS['async-naver-block'] || ARGS.asyncNaverBlock);
const PICKKO_ACCURATE_TIMEOUT_MS = 180_000;

function safeWrite(stream: NodeJS.WriteStream, text: string): void {
  try {
    stream.write(text);
  } catch (error) {
    const code = error && typeof error === 'object' ? (error as { code?: string }).code : undefined;
    if (code === 'EPIPE') return;
    throw error;
  }
}

function parsePickkoOrderId(output: string): string | null {
  const match = String(output || '').match(/\/order\/view\/(\d+)/);
  return match ? match[1] : null;
}

function hasStrongCompletionEvidence(code: number | null, output: string): boolean {
  if (code !== 0) return false;
  const text = String(output || '');
  return Boolean(
    parsePickkoOrderId(text)
    || text.includes('픽코 예약등록 + 결제 완료됨!')
    || text.includes('결제완료 처리:')
    || text.includes('이미 결제완료 상태')
  );
}

function runNaverBlockSlotSync(args: string[]): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn('/opt/homebrew/bin/tsx', args, {
      cwd: __dirname,
      env: process.env,
      stdio: ['ignore', process.stderr, process.stderr],
    });
    child.on('close', (code) => resolve(code));
    child.on('error', reject);
  });
}

const required = ['date', 'start', 'end', 'room', 'phone'];
const missing = required.filter((k) => !ARGS[k]);
if (missing.length > 0) {
  fail(
    `필수 인자 누락: ${missing.join(', ')}\n` +
    '사용법: node /Users/alexlee/projects/ai-agent-system/bots/reservation/manual/reservation/pickko-register.ts --date=YYYY-MM-DD --start=HH:MM --end=HH:MM --room=A1|A2|B --phone=01000000000 --name=이름',
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
  '../../../../bots/reservation/manual/reservation/pickko-accurate.ts',
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

const child = spawn('/opt/homebrew/bin/tsx', childArgs, {
  cwd: __dirname,
  env: {
    ...process.env,
    MODE,
    SKIP_NAME_SYNC: SKIP_NAME_SYNC ? '1' : '0',
    MANUAL_RETRY: IS_MANUAL_RETRY ? '1' : '0',
    SKIP_FINAL_PAYMENT: IS_PENDING_ONLY ? '1' : '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let outputBuf = '';
child.stdout.on('data', (chunk: Buffer | string) => {
  const text = chunk.toString();
  outputBuf += text;
  safeWrite(process.stdout, text);
});
child.stderr.on('data', (chunk: Buffer | string) => {
  const text = chunk.toString();
  outputBuf += text;
  safeWrite(process.stderr, text);
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
    const aiSummary = await buildReservationCliInsight({
      bot: 'pickko-register',
      requestType: 'register-result',
      title: '픽코 예약 등록 결과',
      data: {
        kind: 'timeout',
        room: normalized.room,
        date: normalized.date,
        start: normalized.start,
        end: normalized.end,
      },
      fallback: '등록이 시간 초과되어 픽코 처리 상태와 같은 슬롯 점유 여부를 먼저 확인하는 편이 좋습니다.',
    });
    process.stdout.write(`${JSON.stringify({
      success: false,
      message: timeoutMessage,
      aiSummary,
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
    const strongCompletionEvidence = hasStrongCompletionEvidence(code, outputBuf);
    const pickkoOrderId = parsePickkoOrderId(outputBuf);
    const ambiguousSuccess = code === 0 && !strongCompletionEvidence;
    if (ambiguousSuccess) {
      const message = `픽코 성공 검증 부족: ${normalized.phone} ${normalized.date} ${normalized.start}~${normalized.end} ${normalized.room}룸 — order/view 또는 결제완료 근거가 없어 자동 완료 처리 보류`;
      try {
        const existing = await getReservation(key);
        if (existing) {
          await updateReservation(key, {
            status: 'failed',
            errorReason: 'pickko_success_unverified',
            pickkoStartTime: now,
          });
        }
      } catch (e: unknown) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        process.stderr.write(`[pickko-register] 예약 보류 상태 반영 실패 (${key}): ${errorMessage}\n`);
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
      const aiSummary = await buildReservationCliInsight({
        bot: 'pickko-register',
        requestType: 'register-result',
        title: '픽코 예약 등록 결과',
        data: {
          kind: 'failure',
          room: normalized.room,
          date: normalized.date,
          start: normalized.start,
          end: normalized.end,
          reason: 'pickko_success_unverified',
        },
        fallback: '등록 성공 로그가 애매해 자동 완료로 닫지 않고, 관리자 화면에서 실제 반영 여부를 다시 확인하는 편이 안전합니다.',
      });
      process.stdout.write(`${JSON.stringify({
        success: false,
        message,
        aiSummary,
        memoryHints: {
          episodicHint,
          semanticHint,
        },
      })}\n`);
      await registerMemory.remember([
        '픽코 예약 등록 결과',
        `phone: ${normalized.phone}`,
        `date: ${normalized.date}`,
        `time: ${normalized.start}~${normalized.end}`,
        `room: ${normalized.room}`,
        message,
      ].join('\n'), 'episodic', {
        importance: 0.85,
        expiresIn: 1000 * 60 * 60 * 24 * 30,
        metadata: {
          kind: 'failure',
          room: normalized.room,
          date: normalized.date,
          start: normalized.start,
          end: normalized.end,
          reason: 'pickko_success_unverified',
        },
      }).catch(() => {});
      await registerMemory.consolidate({
        olderThanDays: 14,
        limit: 10,
      }).catch(() => {});
      process.exit(1);
    }

    const pickkoStatus = code === 2
      ? 'time_elapsed'
      : code === 3
        ? 'manual_pending'
        : (IS_MANUAL_RETRY ? 'manual_retry' : 'manual');
    const errorReason = code === 2 ? '시간 경과로 등록 불가' : null;

    try {
      const existing = await getReservation(key);
      if (existing) {
        await updateReservation(key, {
          status: 'completed',
          pickkoStatus,
          pickkoOrderId,
          errorReason,
          pickkoStartTime: now,
        });
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
          pickkoOrderId,
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

    let naverBlockExitCode: number | null = null;
    if ((code === 0 || code === 3) && !SKIP_NAVER_BLOCK) {
      await upsertKioskBlock(normalized.phone, normalized.date, normalized.start, {
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
        path.join(__dirname, '../../../../bots/reservation/auto/monitors/pickko-kiosk-monitor.ts'),
        '--block-slot',
        `--date=${normalized.date}`,
        `--start=${normalized.start}`,
        `--end=${normalized.end}`,
        `--room=${normalized.room}`,
        `--phone=${normalized.phone}`,
        `--name=${customerName}`,
      ];
      if (ASYNC_NAVER_BLOCK) {
        const blockChild = spawn('/opt/homebrew/bin/tsx', blockArgs, {
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
      } else {
        try {
          naverBlockExitCode = await runNaverBlockSlotSync(blockArgs);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          naverBlockExitCode = 1;
          await recordKioskBlockAttempt(normalized.phone, normalized.date, normalized.start, {
            name: customerName,
            date: normalized.date,
            start: normalized.start,
            end: normalized.end,
            room: normalized.room,
            amount: 0,
            naverBlocked: false,
            lastBlockAttemptAt: kst.datetimeStr(),
            lastBlockResult: 'spawn_failed',
            lastBlockReason: message,
            incrementRetry: true,
          }).catch((dbError) => process.stderr.write(`[pickko-register] kiosk_blocks spawn 실패 기록 실패: ${dbError.message}\n`));
        }
      }
    }

    const message = code === 2
      ? `시간 경과로 픽코 등록 생략: ${normalized.phone} ${normalized.date} ${normalized.start}~${normalized.end} ${normalized.room}룸 — 픽코에서 직접 확인 필요`
      : code === 3
        ? SKIP_NAVER_BLOCK
          ? `결제대기 예약 등록 완료: ${normalized.phone} ${normalized.date} ${normalized.start}~${normalized.end} ${normalized.room}룸 (${customerName})`
          : ASYNC_NAVER_BLOCK
            ? `결제대기 예약 등록 완료: ${normalized.phone} ${normalized.date} ${normalized.start}~${normalized.end} ${normalized.room}룸 (${customerName}) — 네이버 예약불가 차단 대기열 등록`
            : naverBlockExitCode === 0
              ? `결제대기 예약 등록 완료: ${normalized.phone} ${normalized.date} ${normalized.start}~${normalized.end} ${normalized.room}룸 (${customerName}) — 네이버 예약불가 처리 완료`
              : `결제대기 예약 등록 완료: ${normalized.phone} ${normalized.date} ${normalized.start}~${normalized.end} ${normalized.room}룸 (${customerName}) — 네이버 예약불가 후속 처리 필요`
        : SKIP_NAVER_BLOCK
        ? `예약 등록 완료: ${normalized.phone} ${normalized.date} ${normalized.start}~${normalized.end} ${normalized.room}룸 (${customerName}) — 재등록 모드로 네이버 차단은 생략`
          : ASYNC_NAVER_BLOCK
            ? `예약 등록 완료: ${normalized.phone} ${normalized.date} ${normalized.start}~${normalized.end} ${normalized.room}룸 (${customerName}) — 네이버 예약불가 차단 대기열 등록`
            : naverBlockExitCode === 0
              ? `예약 등록 완료: ${normalized.phone} ${normalized.date} ${normalized.start}~${normalized.end} ${normalized.room}룸 (${customerName}) — 네이버 예약불가 처리 완료`
              : `예약 등록 완료: ${normalized.phone} ${normalized.date} ${normalized.start}~${normalized.end} ${normalized.room}룸 (${customerName}) — 네이버 예약불가 후속 처리 필요`;
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
    const aiSummary = await buildReservationCliInsight({
      bot: 'pickko-register',
      requestType: 'register-result',
      title: '픽코 예약 등록 결과',
      data: {
        kind,
        room: normalized.room,
        date: normalized.date,
        start: normalized.start,
        end: normalized.end,
        pickkoStatus,
        skipNaverBlock: SKIP_NAVER_BLOCK,
        asyncNaverBlock: ASYNC_NAVER_BLOCK,
        naverBlockExitCode,
      },
      fallback: code === 2
        ? '시간 경과로 자동 등록이 멈춰 후속 수동 확인이 필요합니다.'
        : naverBlockExitCode === 0
          ? '등록과 네이버 차단까지 완료되었습니다.'
          : '등록은 완료되었지만 네이버 차단은 후속 확인이 필요합니다.',
    });
    process.stdout.write(`${JSON.stringify({
      success: naverBlockExitCode === null ? true : naverBlockExitCode === 0,
      message,
      naverBlock: {
        skipped: SKIP_NAVER_BLOCK,
        async: ASYNC_NAVER_BLOCK,
        exitCode: naverBlockExitCode,
        ok: naverBlockExitCode === null ? !SKIP_NAVER_BLOCK ? ASYNC_NAVER_BLOCK : true : naverBlockExitCode === 0,
      },
      aiSummary,
      memoryHints: {
        episodicHint,
        semanticHint,
      },
    })}\n`);
    process.exit(naverBlockExitCode === null || naverBlockExitCode === 0 ? 0 : 1);
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
  const aiSummary = await buildReservationCliInsight({
    bot: 'pickko-register',
    requestType: 'register-result',
    title: '픽코 예약 등록 결과',
    data: {
      kind: 'failure',
      room: normalized.room,
      date: normalized.date,
      start: normalized.start,
      end: normalized.end,
      exitCode: code,
    },
    fallback: '등록이 실패해 픽코 로그와 같은 시간대 슬롯 상태를 함께 확인하는 편이 좋습니다.',
  });
  process.stdout.write(`${JSON.stringify({
    success: false,
    message: failureMessage,
    aiSummary,
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
