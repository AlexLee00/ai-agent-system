// @ts-nocheck
/**
 * lifecycle-contract.ts
 *
 * 루나팀 자동매매 6단계 라이프사이클 표준 계약.
 * 각 단계는 input/output/owner_agent/policy_snapshot/evidence_snapshot/idempotency_key를 남긴다.
 *
 * 단계:
 *   phase1_collect       수집
 *   phase2_analyze       분석/전략 추천
 *   phase3_approve       최종 판단/리스크 승인
 *   phase4_execute       체결/포지션 편입
 *   phase5_monitor       실시간 감시/재평가
 *   phase6_closeout      부분조정/청산/회고
 */

import * as db from './db.ts';

export const LIFECYCLE_PHASES = [
  'phase1_collect',
  'phase2_analyze',
  'phase3_approve',
  'phase4_execute',
  'phase5_monitor',
  'phase6_closeout',
] as const;

export type LifecyclePhase = typeof LIFECYCLE_PHASES[number];

export const LIFECYCLE_EVENT_TYPES = {
  started:          'started',
  completed:        'completed',
  skipped:          'skipped',
  blocked:          'blocked',
  failed:           'failed',
  // phase6 전용
  partial_adjust:   'partial_adjust',
  full_exit:        'full_exit',
  exit_deferred:    'exit_deferred',
  review_created:   'review_created',
  review_completed: 'review_completed',
  feedback_applied: 'feedback_applied',
} as const;

export type LifecycleEventType = typeof LIFECYCLE_EVENT_TYPES[keyof typeof LIFECYCLE_EVENT_TYPES];

export interface LifecycleEventInput {
  positionScopeKey: string;
  exchange: string;
  symbol: string;
  tradeMode?: string;
  phase: LifecyclePhase;
  ownerAgent?: string | null;
  eventType: LifecycleEventType | string;
  inputSnapshot?: Record<string, unknown>;
  outputSnapshot?: Record<string, unknown>;
  policySnapshot?: Record<string, unknown>;
  evidenceSnapshot?: Record<string, unknown>;
  idempotencyKey?: string | null;
}

export function buildPositionScopeKey(symbol: string, exchange: string, tradeMode = 'normal'): string {
  return `${exchange}:${symbol}:${tradeMode}`;
}

export async function recordLifecycleEvent(input: LifecycleEventInput): Promise<string | null> {
  return db.insertLifecycleEvent({
    positionScopeKey: input.positionScopeKey,
    exchange: input.exchange,
    symbol: input.symbol,
    tradeMode: input.tradeMode || 'normal',
    phase: input.phase,
    ownerAgent: input.ownerAgent || null,
    eventType: input.eventType,
    inputSnapshot: input.inputSnapshot || {},
    outputSnapshot: input.outputSnapshot || {},
    policySnapshot: input.policySnapshot || {},
    evidenceSnapshot: input.evidenceSnapshot || {},
    idempotencyKey: input.idempotencyKey || null,
  });
}

/**
 * phase6 청산/부분조정 시작 이벤트 기록.
 * idempotency_key = `phase6:<closeout_type>:<symbol>:<exchange>:<tradeMode>:<signal_id>`
 */
export async function recordPhase6Start({
  symbol,
  exchange,
  tradeMode = 'normal',
  closeoutType,
  signalId,
  ownerAgent = 'phase6_closeout_engine',
  inputSnapshot = {},
  policySnapshot = {},
}: {
  symbol: string;
  exchange: string;
  tradeMode?: string;
  closeoutType: string;
  signalId?: string | null;
  ownerAgent?: string;
  inputSnapshot?: Record<string, unknown>;
  policySnapshot?: Record<string, unknown>;
}): Promise<string | null> {
  const scopeKey = buildPositionScopeKey(symbol, exchange, tradeMode);
  const idempotencyKey = signalId
    ? `phase6:${closeoutType}:${symbol}:${exchange}:${tradeMode}:${signalId}`
    : null;
  return recordLifecycleEvent({
    positionScopeKey: scopeKey,
    exchange,
    symbol,
    tradeMode,
    phase: 'phase6_closeout',
    ownerAgent,
    eventType: closeoutType === 'partial_adjust' ? 'partial_adjust' : 'full_exit',
    inputSnapshot,
    policySnapshot,
    idempotencyKey,
  });
}

export async function recordPhase6Result({
  symbol,
  exchange,
  tradeMode = 'normal',
  closeoutType,
  signalId,
  ownerAgent = 'phase6_closeout_engine',
  outputSnapshot = {},
  policySnapshot = {},
  success = true,
}: {
  symbol: string;
  exchange: string;
  tradeMode?: string;
  closeoutType: string;
  signalId?: string | null;
  ownerAgent?: string;
  outputSnapshot?: Record<string, unknown>;
  policySnapshot?: Record<string, unknown>;
  success?: boolean;
}): Promise<string | null> {
  const scopeKey = buildPositionScopeKey(symbol, exchange, tradeMode);
  const idempotencyKey = signalId
    ? `phase6:result:${closeoutType}:${symbol}:${exchange}:${tradeMode}:${signalId}`
    : null;
  return recordLifecycleEvent({
    positionScopeKey: scopeKey,
    exchange,
    symbol,
    tradeMode,
    phase: 'phase6_closeout',
    ownerAgent,
    eventType: success ? 'completed' : 'failed',
    outputSnapshot,
    policySnapshot,
    idempotencyKey,
  });
}

export async function recordPhase6ReviewCreated({
  symbol,
  exchange,
  tradeMode = 'normal',
  reviewId,
  closeoutType,
}: {
  symbol: string;
  exchange: string;
  tradeMode?: string;
  reviewId: string;
  closeoutType: string;
}): Promise<string | null> {
  const scopeKey = buildPositionScopeKey(symbol, exchange, tradeMode);
  return recordLifecycleEvent({
    positionScopeKey: scopeKey,
    exchange,
    symbol,
    tradeMode,
    phase: 'phase6_closeout',
    ownerAgent: 'closeout_review',
    eventType: 'review_created',
    outputSnapshot: { reviewId, closeoutType },
    idempotencyKey: `phase6:review:${reviewId}`,
  });
}

/**
 * 현재 오픈 포지션 기준으로 phase6 커버리지 gap을 감사한다.
 * ADJUST/EXIT 후보가 있는데 phase6 lifecycle event가 없는 포지션을 warning으로 반환한다.
 */
export async function auditPhase6Coverage({
  days = 3,
}: { days?: number } = {}): Promise<{
  total: number;
  covered: number;
  gaps: Array<{ symbol: string; exchange: string; tradeMode: string; recommendation: string }>;
}> {
  const coverage = await db.getLifecyclePhaseCoverage({ days }).catch(() => []);
  const coveredKeys = new Set(
    coverage.map((r) => buildPositionScopeKey(r.symbol, r.exchange, r.trade_mode)),
  );

  const profiles = await db.query(`
    SELECT symbol, exchange, trade_mode,
           strategy_state->>'latestRecommendation' AS recommendation
    FROM investment.position_strategy_profiles
    WHERE status = 'active'
      AND strategy_state->>'latestRecommendation' IN ('ADJUST', 'EXIT')
  `).catch(() => []);

  const gaps = profiles
    .filter((p) => !coveredKeys.has(buildPositionScopeKey(p.symbol, p.exchange, p.trade_mode)))
    .map((p) => ({
      symbol: p.symbol,
      exchange: p.exchange,
      tradeMode: p.trade_mode,
      recommendation: p.recommendation,
    }));

  return {
    total: profiles.length,
    covered: profiles.length - gaps.length,
    gaps,
  };
}

export default {
  LIFECYCLE_PHASES,
  LIFECYCLE_EVENT_TYPES,
  buildPositionScopeKey,
  recordLifecycleEvent,
  recordPhase6Start,
  recordPhase6Result,
  recordPhase6ReviewCreated,
  auditPhase6Coverage,
};
