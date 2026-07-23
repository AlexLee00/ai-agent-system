type Logger = (message: string) => void;

const kst = require('../../../packages/core/lib/kst');

export type CancelRetryReason =
  | 'matched_fail'
  | 'member_missing'
  | 'network'
  | 'timeout'
  | 'unknown';

export type CancelRetryStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'manual_required'
  | 'exhausted';

export type CancelRetryDb = {
  query: (sql: string, params?: unknown[]) => Promise<Record<string, any>[]>;
  run: (sql: string, params?: unknown[]) => Promise<any>;
};

export type CancelRetryEngineDeps = {
  db: CancelRetryDb;
  log?: Logger;
  env?: NodeJS.ProcessEnv;
};

const RETRYABLE_REASONS = new Set<CancelRetryReason>(['network', 'timeout']);
const PERMANENT_REASONS = new Set<CancelRetryReason>(['member_missing', 'matched_fail']);

function enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SKA_CANCEL_RETRY_ENABLED === 'true';
}

function maxAttempts(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.SKA_CANCEL_RETRY_MAX_ATTEMPTS || 3);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 3;
}

function baseDelayMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.SKA_CANCEL_RETRY_BASE_DELAY_MINUTES || 10);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 10;
}

function runningLeaseMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.SKA_CANCEL_RETRY_RUNNING_LEASE_MINUTES || 30);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 30;
}

function phoneRaw(booking: Record<string, any>): string {
  return String(booking.phoneRaw || booking.phone || '').replace(/\D/g, '');
}

export function buildCancelRetryKey(booking: Record<string, any>, cancelKey?: string | null): string {
  if (cancelKey) return cancelKey;
  return `cancel_done|${phoneRaw(booking)}|${booking.date}|${booking.start}|${booking.end || ''}|${booking.room || ''}`;
}

export function classifyPickkoCancelFailure({
  output = '',
  failureStage = null,
  exitCode = null,
}: {
  output?: string | null;
  failureStage?: string | null;
  exitCode?: number | null;
}): CancelRetryReason {
  const text = `${failureStage || ''}\n${output || ''}\n${exitCode ?? ''}`;
  if (/CHILD_TIMEOUT|timeout|TimeoutError|Navigation timeout|Waiting failed/i.test(text)) return 'timeout';
  if (/ECONNRESET|ECONNREFUSED|ERR_NETWORK|ERR_NAME_NOT_RESOLVED|net::|socket|fetch failed|network/i.test(text)) return 'network';
  if (/회원.*(없|미발견|검색 안됨)|member.*(missing|not found)|회원 선택.*실패/i.test(text)) return 'member_missing';
  if (/취소 대상 예약 미발견|예약 미발견|매칭 실패|matched?_?fail|no matching reservation/i.test(text)) return 'matched_fail';
  return 'unknown';
}

export function nextRetryDelayMinutes(attempts: number, env: NodeJS.ProcessEnv = process.env): number {
  const base = baseDelayMinutes(env);
  const exponent = Math.max(0, attempts - 1);
  return Math.min(base * (2 ** exponent), 24 * 60);
}

function isMissingTableError(error: any): boolean {
  return error?.code === '42P01' || /cancel_retry_queue|does not exist|undefined_table/i.test(String(error?.message || error));
}

function safeErrorMessage(error: unknown): string {
  return String((error as any)?.message || error || '').slice(0, 500);
}

function maskCancelKey(key: string): string {
  return String(key || '').replace(/(\d{3})\d{4}(\d{4})/g, '$1****$2');
}

export function createCancelRetryEngine({
  db,
  log = () => {},
  env = process.env,
}: CancelRetryEngineDeps) {
  async function recordFailure({
    booking,
    cancelKey,
    output,
    failureStage,
    exitCode,
    firstExitCode,
  }: {
    booking: Record<string, any>;
    cancelKey?: string | null;
    output?: string | null;
    failureStage?: string | null;
    exitCode?: number | null;
    firstExitCode?: number | null;
  }) {
    if (!enabled(env)) return { skipped: true, reason: 'disabled' };
    const reason = classifyPickkoCancelFailure({ output, failureStage, exitCode });
    const key = buildCancelRetryKey(booking, cancelKey);
    const attempts = 0;
    const status: CancelRetryStatus = RETRYABLE_REASONS.has(reason) ? 'pending' : 'manual_required';
    const delayMinutes = nextRetryDelayMinutes(1, env);
    const metadata = {
      firstExitCode,
      failureStage,
      recordedAt: kst.datetimeStr(),
      retryable: RETRYABLE_REASONS.has(reason),
    };

    try {
      await db.run(`
        INSERT INTO cancel_retry_queue
          (cancel_key, booking_id, phone_raw, date, start_time, end_time, room,
           reason, attempts, next_retry_at, status, last_exit_code, last_error, metadata,
           created_at, updated_at)
        VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8,$9,
           CASE WHEN $10 = 'pending' THEN NOW() + ($14::int * INTERVAL '1 minute') ELSE NULL END,
           $10,$11,$12,$13::jsonb,NOW(),NOW())
        ON CONFLICT (cancel_key) DO UPDATE SET
          reason = EXCLUDED.reason,
          next_retry_at = EXCLUDED.next_retry_at,
          status = EXCLUDED.status,
          last_exit_code = EXCLUDED.last_exit_code,
          last_error = EXCLUDED.last_error,
          metadata = cancel_retry_queue.metadata || EXCLUDED.metadata,
          updated_at = NOW()
      `, [
        key,
        booking.bookingId || null,
        phoneRaw(booking),
        booking.date || null,
        booking.start || null,
        booking.end || null,
        booking.room || null,
        reason,
        attempts,
        status,
        exitCode,
        String(output || '').slice(-1000),
        JSON.stringify(metadata),
        delayMinutes,
      ]);
      log(`🔁 [취소 재시도 큐] ${status} 등록: ${maskCancelKey(key)} (${reason})`);
      return { skipped: false, status, reason, cancelKey: key };
    } catch (error) {
      if (isMissingTableError(error)) {
        log('ℹ️ [취소 재시도 큐] cancel_retry_queue 미적용 — 기록 생략');
        return { skipped: true, reason: 'missing_table' };
      }
      log(`⚠️ [취소 재시도 큐] 기록 실패: ${safeErrorMessage(error)}`);
      return { skipped: true, reason: 'db_error', error: safeErrorMessage(error) };
    }
  }

  async function markSucceeded({ booking, cancelKey }: { booking: Record<string, any>; cancelKey?: string | null }) {
    if (!enabled(env)) return { skipped: true, reason: 'disabled' };
    const key = buildCancelRetryKey(booking, cancelKey);
    try {
      await db.run(`
        UPDATE cancel_retry_queue
        SET status = 'succeeded', updated_at = NOW(), next_retry_at = NULL
        WHERE cancel_key = $1
      `, [key]);
      return { skipped: false, status: 'succeeded', cancelKey: key };
    } catch (error) {
      if (isMissingTableError(error)) return { skipped: true, reason: 'missing_table' };
      log(`⚠️ [취소 재시도 큐] 성공 표시 실패: ${safeErrorMessage(error)}`);
      return { skipped: true, reason: 'db_error', error: safeErrorMessage(error) };
    }
  }

  async function listDue(limit = 5) {
    if (!enabled(env)) return [];
    const safeLimit = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 5;
    try {
      return await db.query(`
        SELECT *
        FROM cancel_retry_queue
        WHERE status = 'pending'
          AND next_retry_at <= NOW()
        ORDER BY next_retry_at ASC, created_at ASC
        LIMIT $1
      `, [safeLimit]);
    } catch (error) {
      if (isMissingTableError(error)) {
        log('ℹ️ [취소 재시도 큐] 테이블 미적용 — due 조회 생략');
        return [];
      }
      log(`⚠️ [취소 재시도 큐] due 조회 실패: ${safeErrorMessage(error)}`);
      return [];
    }
  }

  async function claimDue(limit = 5) {
    if (!enabled(env)) return [];
    const safeLimit = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 5;
    try {
      const result = await db.run(`
        WITH due AS (
          SELECT cancel_key
          FROM cancel_retry_queue
          WHERE (
              status = 'pending'
              AND next_retry_at <= NOW()
            ) OR (
              status = 'running'
              AND updated_at < NOW() - ($2::int * INTERVAL '1 minute')
            )
          ORDER BY next_retry_at ASC NULLS FIRST, created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $1
        )
        UPDATE cancel_retry_queue AS queue
        SET status = 'running',
            attempts = queue.attempts + 1,
            updated_at = NOW()
        FROM due
        WHERE queue.cancel_key = due.cancel_key
        RETURNING queue.*
      `, [safeLimit, runningLeaseMinutes(env)]);
      return Array.isArray(result?.rows) ? result.rows : [];
    } catch (error) {
      if (isMissingTableError(error)) {
        log('ℹ️ [취소 재시도 큐] 테이블 미적용 — claim 생략');
        return [];
      }
      log(`⚠️ [취소 재시도 큐] claim 실패: ${safeErrorMessage(error)}`);
      return [];
    }
  }

  async function processDueQueue({
    runPickkoCancel,
    limit = 3,
  }: {
    runPickkoCancel: (booking: Record<string, any>, cancelKey?: string | null) => Promise<number>;
    limit?: number;
  }) {
    if (!enabled(env)) return { skipped: true, processed: 0, reason: 'disabled' };
    const rows = await claimDue(limit);
    let processed = 0;
    for (const row of rows) {
      const key = row.cancel_key;
      const attempts = Number(row.attempts || 0);
      const reason = (row.reason || 'unknown') as CancelRetryReason;
      const booking = {
        bookingId: row.booking_id || null,
        phoneRaw: row.phone_raw,
        phone: row.phone_raw,
        date: row.date,
        start: row.start_time,
        end: row.end_time,
        room: row.room,
      };
      try {
        const result = await runPickkoCancel(booking, key);
        processed += 1;
        if (result === 0) {
          await markSucceeded({ booking, cancelKey: key });
          continue;
        }
        const exhausted = attempts >= maxAttempts(env) || PERMANENT_REASONS.has(reason) || reason === 'unknown';
        if (exhausted) {
          await db.run(`
            UPDATE cancel_retry_queue
            SET status=$2, next_retry_at=NULL, last_exit_code=$3, updated_at=NOW()
            WHERE cancel_key=$1
          `, [key, attempts >= maxAttempts(env) ? 'exhausted' : 'manual_required', result]);
        } else {
          const delayMinutes = nextRetryDelayMinutes(attempts + 1, env);
          await db.run(`
            UPDATE cancel_retry_queue
            SET status='pending',
                next_retry_at=NOW() + ($3::int * INTERVAL '1 minute'),
                last_exit_code=$2,
                updated_at=NOW()
            WHERE cancel_key=$1
          `, [key, result, delayMinutes]);
        }
      } catch (error) {
        const errorText = safeErrorMessage(error);
        const exhausted = attempts >= maxAttempts(env) || PERMANENT_REASONS.has(reason) || reason === 'unknown';
        try {
          if (exhausted) {
            await db.run(`
              UPDATE cancel_retry_queue
              SET status=$2, next_retry_at=NULL, last_error=$3, updated_at=NOW()
              WHERE cancel_key=$1
            `, [key, attempts >= maxAttempts(env) ? 'exhausted' : 'manual_required', errorText]);
          } else {
            const delayMinutes = nextRetryDelayMinutes(attempts + 1, env);
            await db.run(`
              UPDATE cancel_retry_queue
              SET status='pending',
                  next_retry_at=NOW() + ($3::int * INTERVAL '1 minute'),
                  last_error=$2,
                  updated_at=NOW()
              WHERE cancel_key=$1
            `, [key, errorText, delayMinutes]);
          }
        } catch (updateError) {
          log(`⚠️ [취소 재시도 큐] 처리 실패 상태 복구 실패: ${maskCancelKey(key)} ${safeErrorMessage(updateError)}`);
        }
        log(`⚠️ [취소 재시도 큐] 처리 실패: ${maskCancelKey(key)} ${errorText}`);
      }
    }
    return { skipped: false, processed };
  }

  return {
    recordFailure,
    markSucceeded,
    listDue,
    claimDue,
    processDueQueue,
  };
}

export const _testOnly = {
  enabled,
  maxAttempts,
  baseDelayMinutes,
  runningLeaseMinutes,
  isMissingTableError,
  maskCancelKey,
};
