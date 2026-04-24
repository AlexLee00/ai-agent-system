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
  buildPositionScopeKey,
  recordPhase6Start,
  recordPhase6Result,
  recordPhase6ReviewCreated,
} from './lifecycle-contract.ts';

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function extractTag(text = '', key = '') {
  return String(text || '').match(new RegExp(`${key}=([^:]+)`))?.[1] || null;
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
  const recent = await db.query(
    `SELECT id, created_at FROM investment.position_closeout_reviews
     WHERE symbol = $1 AND exchange = $2 AND trade_mode = $3 AND closeout_type = $4
       AND created_at >= now() - ($5::int * INTERVAL '1 minute')
     ORDER BY created_at DESC
     LIMIT 1`,
    [symbol, exchange, tradeMode, closeoutType, cooldownMinutes],
  ).catch(() => []);
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

  const success = !error && executeResult != null;
  const reviewStatus = success ? 'pending' : 'failed';
  const closeoutReason = error?.message || reasonCode || String(incidentLink || '');
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
    reviewResult: error ? { error: error.message, stack: error.stack?.slice(0, 300) } : {},
    policySuggestions: [],
    idempotencyKey: reviewIdemKey,
  });

  const lifecycleEventId = await recordPhase6Result({
    symbol, exchange, tradeMode,
    closeoutType,
    signalId: signalId || null,
    outputSnapshot: {
      reviewId, tradeId, executedRatio, executedNotional, pnlRealized,
      success, error: error?.message || null,
    },
    policySnapshot,
    success,
  }).catch(() => null);

  if (reviewId) {
    await recordPhase6ReviewCreated({
      symbol, exchange, tradeMode, reviewId, closeoutType,
    }).catch(() => null);
  }

  return {
    ok: success,
    signalId,
    tradeId: String(tradeId || '') || null,
    reviewId,
    lifecycleEventId,
    executedRatio,
    executedNotional,
    pnlRealized,
    error: error?.message || null,
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
    const existing = await db.get(
      `SELECT id FROM investment.position_lifecycle_events WHERE idempotency_key = $1`,
      [idempotencyKey],
    ).catch(() => null);
    if (existing) {
      return { ok: false, reason: `idempotency: 이미 처리된 key (${idempotencyKey})` };
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

  const lifecycleEventId = await recordPhase6Start({
    symbol: ctx.symbol,
    exchange: ctx.exchange,
    tradeMode: ctx.tradeMode || 'normal',
    closeoutType: ctx.closeoutType,
    signalId: ctx.idempotencyKey ? ctx.idempotencyKey.split(':').pop() : null,
    inputSnapshot: {
      reasonCode: ctx.reasonCode,
      plannedRatio: ctx.plannedRatio,
      plannedNotional: ctx.plannedNotional,
      regime: ctx.regime,
      setupType: ctx.setupType,
    },
    policySnapshot: ctx.policySnapshot || {},
  }).catch(() => null);

  return { ok: true, lifecycleEventId };
}

export default {
  beginCloseout,
  finalizeCloseout,
  preflightCloseout,
};
