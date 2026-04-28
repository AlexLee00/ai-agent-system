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
export const POSITION_STAGE_IDS = [
  'stage_1',
  'stage_2',
  'stage_3',
  'stage_4',
  'stage_5',
  'stage_6',
  'stage_7',
  'stage_8',
] as const;
export type PositionStageId = typeof POSITION_STAGE_IDS[number];

export const POSITION_STAGE_LABELS: Record<PositionStageId, string> = {
  stage_1: 'discovery_collect',
  stage_2: 'strategy_analyze',
  stage_3: 'approval_risk_gate',
  stage_4: 'entry_or_strategy_mutation',
  stage_5: 'continuous_monitor',
  stage_6: 'adjust_or_exit_execution',
  stage_7: 'posttrade_review',
  stage_8: 'feedback_learning',
} as const;

export const POSITION_STAGE_TO_PHASE: Record<PositionStageId, LifecyclePhase> = {
  stage_1: 'phase1_collect',
  stage_2: 'phase2_analyze',
  stage_3: 'phase3_approve',
  stage_4: 'phase4_execute',
  stage_5: 'phase5_monitor',
  stage_6: 'phase6_closeout',
  stage_7: 'phase6_closeout',
  stage_8: 'phase6_closeout',
} as const;

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
  stageId?: PositionStageId | null;
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

export function buildPhase6EventIdempotencyKey({
  eventKind = 'start',
  closeoutType,
  symbol,
  exchange,
  tradeMode = 'normal',
  signalId = null,
  idempotencyKey = null,
}: {
  eventKind?: 'start' | 'result';
  closeoutType: string;
  symbol: string;
  exchange: string;
  tradeMode?: string;
  signalId?: string | null;
  idempotencyKey?: string | null;
}): string | null {
  if (idempotencyKey) {
    return `phase6:${eventKind}:${closeoutType}:${idempotencyKey}`;
  }
  if (signalId) {
    return `phase6:${eventKind}:${closeoutType}:${symbol}:${exchange}:${tradeMode}:${signalId}`;
  }
  return null;
}

export async function recordLifecycleEvent(input: LifecycleEventInput): Promise<string | null> {
  return db.insertLifecycleEvent({
    positionScopeKey: input.positionScopeKey,
    exchange: input.exchange,
    symbol: input.symbol,
    tradeMode: input.tradeMode || 'normal',
    phase: input.phase,
    stageId: input.stageId || null,
    ownerAgent: input.ownerAgent || null,
    eventType: input.eventType,
    inputSnapshot: input.inputSnapshot || {},
    outputSnapshot: input.outputSnapshot || {},
    policySnapshot: input.policySnapshot || {},
    evidenceSnapshot: input.evidenceSnapshot || {},
    idempotencyKey: input.idempotencyKey || null,
  });
}

export function deriveLifecycleStageId(phase: LifecyclePhase, eventType: string | null = null): PositionStageId {
  const normalizedEventType = String(eventType || '').trim().toLowerCase();
  if (normalizedEventType.startsWith('strategy_mutat')) return 'stage_4';
  if (normalizedEventType === 'review_created' || normalizedEventType === 'review_completed') return 'stage_7';
  if (normalizedEventType === 'feedback_applied') return 'stage_8';
  switch (phase) {
    case 'phase1_collect':
      return 'stage_1';
    case 'phase2_analyze':
      return 'stage_2';
    case 'phase3_approve':
      return 'stage_3';
    case 'phase4_execute':
      return 'stage_4';
    case 'phase5_monitor':
      return 'stage_5';
    case 'phase6_closeout':
    default:
      return 'stage_6';
  }
}

export async function recordLifecyclePhaseSnapshot({
  symbol,
  exchange,
  tradeMode = 'normal',
  phase,
  stageId = null,
  ownerAgent = null,
  eventType = 'completed',
  inputSnapshot = {},
  outputSnapshot = {},
  policySnapshot = {},
  evidenceSnapshot = {},
  idempotencyKey = null,
}: {
  symbol: string;
  exchange: string;
  tradeMode?: string;
  phase: LifecyclePhase;
  stageId?: PositionStageId | null;
  ownerAgent?: string | null;
  eventType?: LifecycleEventType | string;
  inputSnapshot?: Record<string, unknown>;
  outputSnapshot?: Record<string, unknown>;
  policySnapshot?: Record<string, unknown>;
  evidenceSnapshot?: Record<string, unknown>;
  idempotencyKey?: string | null;
}): Promise<string | null> {
  return recordLifecycleEvent({
    positionScopeKey: buildPositionScopeKey(symbol, exchange, tradeMode),
    symbol,
    exchange,
    tradeMode,
    phase,
    stageId: stageId || deriveLifecycleStageId(phase, eventType),
    ownerAgent,
    eventType,
    inputSnapshot,
    outputSnapshot,
    policySnapshot,
    evidenceSnapshot,
    idempotencyKey,
  });
}

export async function recordPositionLifecycleStageEvent({
  symbol,
  exchange,
  tradeMode = 'normal',
  stageId,
  phase,
  ownerAgent = null,
  eventType = 'completed',
  inputSnapshot = {},
  outputSnapshot = {},
  policySnapshot = {},
  evidenceSnapshot = {},
  idempotencyKey = null,
}: {
  symbol: string;
  exchange: string;
  tradeMode?: string;
  stageId: PositionStageId;
  phase?: LifecyclePhase;
  ownerAgent?: string | null;
  eventType?: LifecycleEventType | string;
  inputSnapshot?: Record<string, unknown>;
  outputSnapshot?: Record<string, unknown>;
  policySnapshot?: Record<string, unknown>;
  evidenceSnapshot?: Record<string, unknown>;
  idempotencyKey?: string | null;
}) {
  const resolvedPhase = phase || POSITION_STAGE_TO_PHASE[stageId] || 'phase5_monitor';
  return recordLifecyclePhaseSnapshot({
    symbol,
    exchange,
    tradeMode,
    phase: resolvedPhase,
    stageId,
    ownerAgent,
    eventType,
    inputSnapshot,
    outputSnapshot,
    policySnapshot,
    evidenceSnapshot,
    idempotencyKey,
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
  idempotencyKey = null,
  ownerAgent = 'phase6_closeout_engine',
  inputSnapshot = {},
  policySnapshot = {},
}: {
  symbol: string;
  exchange: string;
  tradeMode?: string;
  closeoutType: string;
  signalId?: string | null;
  idempotencyKey?: string | null;
  ownerAgent?: string;
  inputSnapshot?: Record<string, unknown>;
  policySnapshot?: Record<string, unknown>;
}): Promise<string | null> {
  const scopeKey = buildPositionScopeKey(symbol, exchange, tradeMode);
  const phase6IdempotencyKey = buildPhase6EventIdempotencyKey({
    eventKind: 'start',
    closeoutType,
    symbol,
    exchange,
    tradeMode,
    signalId,
    idempotencyKey,
  });
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
    idempotencyKey: phase6IdempotencyKey,
  });
}

export async function recordPhase6Result({
  symbol,
  exchange,
  tradeMode = 'normal',
  closeoutType,
  signalId,
  idempotencyKey = null,
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
  idempotencyKey?: string | null;
  ownerAgent?: string;
  outputSnapshot?: Record<string, unknown>;
  policySnapshot?: Record<string, unknown>;
  success?: boolean;
}): Promise<string | null> {
  const scopeKey = buildPositionScopeKey(symbol, exchange, tradeMode);
  const phase6IdempotencyKey = buildPhase6EventIdempotencyKey({
    eventKind: 'result',
    closeoutType,
    symbol,
    exchange,
    tradeMode,
    signalId,
    idempotencyKey,
  });
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
    idempotencyKey: phase6IdempotencyKey,
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

export async function recordPhase6ReviewCompleted({
  symbol,
  exchange,
  tradeMode = 'normal',
  reviewId,
  closeoutType,
  reviewStatus = 'completed',
}: {
  symbol: string;
  exchange: string;
  tradeMode?: string;
  reviewId: string;
  closeoutType: string;
  reviewStatus?: string;
}): Promise<string | null> {
  const scopeKey = buildPositionScopeKey(symbol, exchange, tradeMode);
  return recordLifecycleEvent({
    positionScopeKey: scopeKey,
    exchange,
    symbol,
    tradeMode,
    phase: 'phase6_closeout',
    ownerAgent: 'closeout_review',
    eventType: 'review_completed',
    outputSnapshot: { reviewId, closeoutType, reviewStatus },
    idempotencyKey: `phase6:review-completed:${reviewId}`,
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
    coverage
      .filter((r) => Array.isArray(r.covered_phases) && r.covered_phases.includes('phase6_closeout'))
      .map((r) => buildPositionScopeKey(r.symbol, r.exchange, r.trade_mode)),
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
  POSITION_STAGE_IDS,
  LIFECYCLE_EVENT_TYPES,
  deriveLifecycleStageId,
  buildPositionScopeKey,
  buildPhase6EventIdempotencyKey,
  recordLifecycleEvent,
  recordLifecyclePhaseSnapshot,
  recordPositionLifecycleStageEvent,
  recordPhase6Start,
  recordPhase6Result,
  recordPhase6ReviewCreated,
  recordPhase6ReviewCompleted,
  auditPhase6Coverage,
};
