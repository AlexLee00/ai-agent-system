// @ts-nocheck
/**
 * position-closeout-engine.ts
 *
 * Phase 6 청산/부분조정 엔진.
 * partial-adjust-runner, strategy-exit-runner가 이 엔진을 통해 closeout review를 생성한다.
 *
 * 핵심 계약:
 *   1. 실행 전 idempotency check
 *   2. 실행 후 closeout review 생성 (성공/실패/부분체결 모두 기록)
 *   3. lifecycle event 발행 (phase6_closeout)
 *   4. cooldown 검사
 */

import * as db from './db.ts';
import {
  buildPhase6EventIdempotencyKey,
  recordPhase6Start,
  recordPhase6Result,
  recordPhase6ReviewCreated,
  recordPhase6ReviewCompleted,
} from './lifecycle-contract.ts';

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function extractTag(text = '', key = '') {
  return String(text || '').match(new RegExp(`${key}=([^:]+)`))?.[1] || null;
}

function normalizeExecutionStatus(executeResult: Record<string, unknown> | null = null) {
  const raw = String(
    executeResult?.status
    || executeResult?.trade?.status
    || executeResult?.result
    || '',
  ).trim().toLowerCase();
  return raw || null;
}

const SUCCESS_STATUSES = new Set([
  'completed',
  'closed',
  'filled',
  'executed',
  'success',
  'ok',
  'done',
  'settled',
]);

const FAILURE_STATUSES = new Set([
  'failed',
  'error',
  'rejected',
  'blocked',
  'skipped',
  'cancelled',
  'canceled',
  'aborted',
]);

const PENDING_STATUSES = new Set([
  'pending',
  'open',
  'new',
  'submitted',
  'accepted',
  'queued',
  'processing',
]);

function normalizeBoolean(value) {
  if (value === true || value === false) return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function hasPositiveExecutionFill(executeResult: Record<string, unknown> | null = null) {
  const metrics = [
    executeResult?.executedNotional,
    executeResult?.total_usdt,
    executeResult?.notional,
    executeResult?.filled,
    executeResult?.amount,
    executeResult?.trade?.filled,
    executeResult?.trade?.amount,
  ];
  return metrics.some((value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0;
  });
}

function hasExplicitExecutionFailure(executeResult: Record<string, unknown> | null = null, status: string | null = null) {
  if (!executeResult) return true;
  if (normalizeBoolean(executeResult?.success) === false) return true;
  if (normalizeBoolean(executeResult?.ok) === false) return true;
  if (normalizeBoolean(executeResult?.filled) === false) return true;
  if (status && FAILURE_STATUSES.has(status)) return true;
  return false;
}

function deriveExecutionSuccess(
  executeResult: Record<string, unknown> | null = null,
  error: Error | null = null,
  tradeId: string | null = null,
) {
  if (error) return false;
  const status = normalizeExecutionStatus(executeResult);
  if (hasExplicitExecutionFailure(executeResult, status)) return false;
  if (status && SUCCESS_STATUSES.has(status)) return true;
  if (status && PENDING_STATUSES.has(status)) return false;
  if (normalizeBoolean(executeResult?.success) === true) return true;
  if (normalizeBoolean(executeResult?.ok) === true) return true;
  if (normalizeBoolean(executeResult?.filled) === true) return true;
  if (hasPositiveExecutionFill(executeResult)) return true;
  return false;
}

function extractExecutionFailureMessage(
  executeResult: Record<string, unknown> | null = null,
  error: Error | null = null,
  status: string | null = null,
) {
  if (error?.message) return error.message;
  if (!executeResult) return 'execution_result_missing';
  const reason = executeResult?.reason
    || executeResult?.error
    || executeResult?.message
    || executeResult?.trade?.rejectReason
    || null;
  if (reason) return String(reason);
  if (status && FAILURE_STATUSES.has(status)) return `execution_status_${status}`;
  return 'execution_unsuccessful';
}

function shouldMarkReviewCompleted(executeResult: Record<string, unknown> | null = null, tradeId: string | null = null) {
  const status = normalizeExecutionStatus(executeResult);
  if (status && FAILURE_STATUSES.has(status)) return false;
  if (status && PENDING_STATUSES.has(status)) return false;
  if (status && SUCCESS_STATUSES.has(status)) {
    return true;
  }
  if (normalizeBoolean(executeResult?.filled) === true) return true;
  if (hasPositiveExecutionFill(executeResult)) return true;
  return false;
}

export function normalizeExecutionOutcome(
  executeResult: Record<string, unknown> | null = null,
  error: Error | null = null,
  tradeId: string | null = null,
) {
  const executionStatus = normalizeExecutionStatus(executeResult);
  const success = deriveExecutionSuccess(executeResult, error, tradeId);
  const failureReason = success
    ? null
    : extractExecutionFailureMessage(executeResult, error, executionStatus);
  const reviewStatus = !success
    ? (executionStatus && PENDING_STATUSES.has(executionStatus) ? 'pending' : 'failed')
    : shouldMarkReviewCompleted(executeResult, tradeId)
      ? 'completed'
      : 'pending';
  return {
    success,
    reviewStatus,
    executionStatus,
    failureReason,
  };
}

export function assessPhase6SafetyReadiness() {
  const checks = [];
  const pendingWithTradeId = normalizeExecutionOutcome({ tradeId: 't1', status: 'pending' }, null, 't1');
  checks.push({
    key: 'trade_id_pending_not_completed',
    ok: pendingWithTradeId.success === false && pendingWithTradeId.reviewStatus !== 'completed',
    observed: pendingWithTradeId,
  });

  const rejectedWithTradeId = normalizeExecutionOutcome({ tradeId: 't2', ok: false, status: 'rejected' }, null, 't2');
  checks.push({
    key: 'trade_id_rejected_failed',
    ok: rejectedWithTradeId.success === false && rejectedWithTradeId.reviewStatus === 'failed',
    observed: rejectedWithTradeId,
  });

  const filledWithTradeId = normalizeExecutionOutcome({ tradeId: 't3', status: 'filled', filled: true }, null, 't3');
  checks.push({
    key: 'filled_trade_completed',
    ok: filledWithTradeId.success === true && filledWithTradeId.reviewStatus === 'completed',
    observed: filledWithTradeId,
  });

  const failedObject = normalizeExecutionOutcome({ success: false, reason: 'blocked' }, null, null);
  checks.push({
    key: 'explicit_failure_object_failed',
    ok: failedObject.success === false && failedObject.reviewStatus === 'failed',
    observed: failedObject,
  });

  return {
    ok: checks.every((check) => check.ok === true),
    checkedAt: new Date().toISOString(),
    checks,
  };
}

export interface CloseoutContext {
  symbol: string;
  exchange: string;
  tradeMode?: string;
  closeoutType: 'partial_adjust' | 'full_exit';
  reasonCode?: string | null;
  incidentLink?: string | null;
  plannedRatio?: number | null;
  plannedNotional?: number | null;
  regime?: string | null;
  setupType?: string | null;
  strategyFamily?: string | null;
  familyBias?: string | null;
  policySnapshot?: Record<string, unknown>;
  /** 체결 직전 idempotency_key. null이면 자동 생성 안 함 */
  idempotencyKey?: string | null;
  cooldownMinutes?: number;
}

export interface CloseoutResult {
  ok: boolean;
  blocked?: boolean;
  blockReason?: string | null;
  signalId?: string | null;
  tradeId?: string | null;
  reviewId?: string | null;
  lifecycleEventId?: string | null;
  reviewStatus?: string | null;
  executedRatio?: number | null;
  executedNotional?: number | null;
  pnlRealized?: number | null;
  error?: string | null;
}

/**
 * 최근 같은 symbol/exchange/tradeMode/closeoutType의 review가 cooldown 이내인지 확인.
 */
async function checkCooldown(
  symbol: string,
  exchange: string,
  tradeMode: string,
  closeoutType: string,
  cooldownMinutes: number,
): Promise<{ ok: boolean; reason?: string }> {
  if (cooldownMinutes <= 0) return { ok: true };
  let recent = [];
  try {
    recent = await db.query(
      `SELECT id, created_at FROM investment.position_closeout_reviews
       WHERE symbol = $1 AND exchange = $2 AND trade_mode = $3 AND closeout_type = $4
         AND created_at >= now() - ($5::int * INTERVAL '1 minute')
       ORDER BY created_at DESC
       LIMIT 1`,
      [symbol, exchange, tradeMode, closeoutType, cooldownMinutes],
    );
  } catch (error) {
    return {
      ok: false,
      reason: `cooldown_check_failed:${error?.message || String(error)}`,
    };
  }

  if (recent.length > 0) {
    return {
      ok: false,
      reason: `cooldown: 최근 ${cooldownMinutes}분 이내 동일 closeout 존재 (${recent[0].id})`,
    };
  }
  return { ok: true };
}

/**
 * 체결 결과(executeResult)를 받아 closeout review를 생성하고 lifecycle event를 남긴다.
 *
 * @param ctx      closeout 컨텍스트
 * @param signalId 생성된 signal ID
 * @param executeResult 체결 함수 결과 (null이면 체결 안 됨)
 * @param error    체결 중 발생한 오류 (없으면 null)
 */
export async function finalizeCloseout(
  ctx: CloseoutContext,
  signalId: string | null,
  executeResult: Record<string, unknown> | null,
  error: Error | null = null,
): Promise<CloseoutResult> {
  const {
    symbol, exchange, tradeMode = 'normal',
    closeoutType, reasonCode, incidentLink,
    plannedRatio, plannedNotional,
    regime, setupType, strategyFamily,
    policySnapshot = {},
    idempotencyKey = null,
  } = ctx;

  const familyBias = ctx.familyBias
    || extractTag(incidentLink || '', 'family_bias')
    || null;
  const resolvedFamily = strategyFamily
    || extractTag(incidentLink || '', 'family')
    || null;

  const tradeId = executeResult?.tradeId
    || executeResult?.trade?.id
    || executeResult?.id
    || null;
  const executedNotional = safeNumber(
    executeResult?.executedNotional
    || executeResult?.total_usdt
    || executeResult?.notional,
    null,
  ) || null;
  const pnlRealized = safeNumber(executeResult?.pnlRealized, null) || null;
  const executedRatio = executeResult?.executedRatio != null
    ? safeNumber(executeResult.executedRatio)
    : (plannedRatio != null ? safeNumber(plannedRatio) : null);

  const executionOutcome = normalizeExecutionOutcome(executeResult, error, String(tradeId || '') || null);
  const success = executionOutcome.success;
  const executionStatus = executionOutcome.executionStatus;
  const failureReason = executionOutcome.failureReason;
  const reviewStatus = executionOutcome.reviewStatus;
  const closeoutReason = failureReason || reasonCode || String(incidentLink || '');
  const reviewIdemKey = idempotencyKey ? `review:${idempotencyKey}` : null;

  const reviewId = await db.insertCloseoutReview({
    signalId: signalId || null,
    tradeId: String(tradeId || '') || null,
    exchange, symbol, tradeMode,
    closeoutType,
    closeoutReason,
    plannedRatio: plannedRatio != null ? safeNumber(plannedRatio) : null,
    executedRatio,
    plannedNotional: plannedNotional != null ? safeNumber(plannedNotional) : null,
    executedNotional,
    pnlRealized,
    regime: regime || null,
    setupType: setupType || null,
    strategyFamily: resolvedFamily,
    familyBias,
    reviewStatus,
    reviewResult: !success ? {
      error: failureReason,
      status: executionStatus,
      stack: error?.stack?.slice(0, 300) || null,
    } : {},
    policySuggestions: [],
    idempotencyKey: reviewIdemKey,
  });

  const lifecycleEventId = await recordPhase6Result({
    symbol, exchange, tradeMode,
    closeoutType,
    signalId: signalId || null,
    idempotencyKey,
    outputSnapshot: {
      reviewId, tradeId, executedRatio, executedNotional, pnlRealized,
      success,
      reviewStatus,
      executionStatus,
      error: failureReason,
    },
    policySnapshot,
    success,
  }).catch(() => null);

  if (reviewId) {
    await recordPhase6ReviewCreated({
      symbol, exchange, tradeMode, reviewId, closeoutType,
    }).catch(() => null);
    if (reviewStatus === 'completed') {
      await recordPhase6ReviewCompleted({
        symbol,
        exchange,
        tradeMode,
        reviewId,
        closeoutType,
        reviewStatus,
      }).catch(() => null);
    }
  }

  return {
    ok: success,
    signalId,
    tradeId: String(tradeId || '') || null,
    reviewId,
    lifecycleEventId,
    reviewStatus,
    executedRatio,
    executedNotional,
    pnlRealized,
    error: failureReason,
  };
}

/**
 * 체결 실행 전 guard: idempotency + cooldown + 기타 preflight.
 * ok=false면 실행 차단.
 */
export async function preflightCloseout(ctx: CloseoutContext): Promise<{
  ok: boolean;
  reason?: string | null;
}> {
  const { symbol, exchange, tradeMode = 'normal', closeoutType, idempotencyKey, cooldownMinutes = 0 } = ctx;

  if (idempotencyKey) {
    const lifecycleKey = buildPhase6EventIdempotencyKey({
      eventKind: 'start',
      closeoutType,
      symbol,
      exchange,
      tradeMode,
      idempotencyKey,
    });
    let existing = null;
    try {
      existing = await db.get(
        `SELECT id FROM investment.position_lifecycle_events WHERE idempotency_key = $1`,
        [lifecycleKey],
      );
    } catch (error) {
      return {
        ok: false,
        reason: `idempotency_lifecycle_check_failed:${error?.message || String(error)}`,
      };
    }
    if (existing) {
      return { ok: false, reason: `idempotency: 이미 처리된 lifecycle key (${idempotencyKey})` };
    }
    let existingReview = null;
    try {
      existingReview = await db.get(
        `SELECT id FROM investment.position_closeout_reviews WHERE idempotency_key = $1`,
        [`review:${idempotencyKey}`],
      );
    } catch (error) {
      return {
        ok: false,
        reason: `idempotency_review_check_failed:${error?.message || String(error)}`,
      };
    }
    if (existingReview) {
      return { ok: false, reason: `idempotency: 이미 처리된 review key (${idempotencyKey})` };
    }
  }

  const cooldown = await checkCooldown(symbol, exchange, tradeMode, closeoutType, cooldownMinutes);
  if (!cooldown.ok) return { ok: false, reason: cooldown.reason };

  return { ok: true };
}

/**
 * phase6 시작 이벤트 발행 + preflight를 한번에 처리.
 * ok=false면 실행 차단.
 */
export async function beginCloseout(ctx: CloseoutContext): Promise<{
  ok: boolean;
  lifecycleEventId?: string | null;
  reason?: string | null;
}> {
  const preflight = await preflightCloseout(ctx);
  if (!preflight.ok) return { ok: false, reason: preflight.reason };

  let lifecycleEventId = null;
  try {
    lifecycleEventId = await recordPhase6Start({
      symbol: ctx.symbol,
      exchange: ctx.exchange,
      tradeMode: ctx.tradeMode || 'normal',
      closeoutType: ctx.closeoutType,
      signalId: ctx.idempotencyKey ? ctx.idempotencyKey.split(':').pop() : null,
      idempotencyKey: ctx.idempotencyKey || null,
      inputSnapshot: {
        reasonCode: ctx.reasonCode,
        plannedRatio: ctx.plannedRatio,
        plannedNotional: ctx.plannedNotional,
        regime: ctx.regime,
        setupType: ctx.setupType,
      },
      policySnapshot: ctx.policySnapshot || {},
    });
  } catch (error) {
    return {
      ok: false,
      reason: `phase6_start_record_failed:${error?.message || String(error)}`,
    };
  }

  if (!lifecycleEventId) {
    return {
      ok: false,
      reason: 'phase6_start_record_failed:empty_lifecycle_event_id',
    };
  }

  return { ok: true, lifecycleEventId };
}

export default {
  beginCloseout,
  finalizeCloseout,
  preflightCloseout,
};
