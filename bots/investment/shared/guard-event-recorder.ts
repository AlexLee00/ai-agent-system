// @ts-nocheck
/**
 * shared/guard-event-recorder.ts — 가드 이벤트 기록 유틸리티
 *
 * 가드 트리거 시 DB에 비동기(fire-and-forget) 기록.
 * 호출 함수의 동기성을 유지하면서 이벤트를 누적한다.
 *
 * DB: investment.guard_events (migration: 20260603000002_guard_events.sql)
 */

import { run } from './db/core.ts';

export type GuardSeverity = 'info' | 'warning' | 'danger';

export interface GuardEventInput {
  guardName: string;
  symbol?: string | null;
  exchange?: string | null;
  market?: string | null;
  reason: string;
  severity?: GuardSeverity;
  decisionBefore?: unknown;
  decisionAfter?: unknown;
  tradeId?: string | null;
  guardMetadata?: unknown;
}

async function insertGuardEvent(input: GuardEventInput): Promise<void> {
  const {
    guardName,
    symbol = null,
    exchange = null,
    market = null,
    reason,
    severity = 'warning',
    decisionBefore = null,
    decisionAfter = null,
    tradeId = null,
    guardMetadata = null,
  } = input;

  const safeSeverity: GuardSeverity = ['info', 'warning', 'danger'].includes(severity as string)
    ? (severity as GuardSeverity)
    : 'warning';

  await run(
    `INSERT INTO investment.guard_events
       (guard_name, symbol, exchange, market, reason, severity,
        decision_before, decision_after, trade_id, guard_metadata)
     VALUES ($1, $2, $3, $4, $5, $6,
             $7::jsonb, $8::jsonb, $9, $10::jsonb)`,
    [
      String(guardName || 'unknown'),
      symbol ?? null,
      exchange ?? null,
      market ?? null,
      String(reason || ''),
      safeSeverity,
      decisionBefore != null ? JSON.stringify(decisionBefore) : null,
      decisionAfter != null ? JSON.stringify(decisionAfter) : null,
      tradeId ?? null,
      guardMetadata != null ? JSON.stringify(guardMetadata) : null,
    ],
  );
}

/**
 * 가드 이벤트를 비동기(fire-and-forget)로 기록한다.
 * 동기 가드 함수에서 호출 시 실행 흐름을 차단하지 않는다.
 * 실패해도 절대 throw하지 않는다.
 */
export function recordGuardEvent(input: GuardEventInput): void {
  setImmediate(() => {
    insertGuardEvent(input).catch(() => null);
  });
}

/**
 * 여러 가드 이벤트를 한번에 기록 (blockers 배열 전달용).
 */
export function recordGuardEvents(
  events: GuardEventInput[],
): void {
  if (!Array.isArray(events) || events.length === 0) return;
  setImmediate(() => {
    Promise.allSettled(events.map((ev) => insertGuardEvent(ev))).catch(() => null);
  });
}

export default { recordGuardEvent, recordGuardEvents };
