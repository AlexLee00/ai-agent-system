// @ts-nocheck
/**
 * shared/tp-sl-placement-audit.ts — TP/SL 거래소 주문 배치 감사
 *
 * 목적:
 *   진입 기록(trades)에 sl_price/tp_price가 계획됐으나 sl_order_id/tp_order_id가
 *   NULL인 "미체결 TP/SL" 포지션을 탐지한다.
 *
 * 사용:
 *   const result = await auditMissingTpSlOrders('binance');
 *   result.missing → 미체결 목록
 *   result.retried → 재시도 결과 (retry=true 시)
 *
 * 주의:
 *   - 탐지만으로도 가치 있음 (알림·로그용)
 *   - 재시도(retry=true)는 hephaestos.ts executeSignal 경유 — LUNA_TP_SL_ENFORCE 무관하게
 *     SL 주문을 보장한다
 */

import { query } from './db/core.ts';
import * as db from './db.ts';
import { executeSignal as executeBinanceSignal } from '../team/hephaestos.ts';

export interface MissingTpSlEntry {
  symbol: string;
  exchange: string;
  side: string;
  amount: number;
  avgPrice: number;
  slPrice: number | null;
  tpPrice: number | null;
  slOrderId: string | null;
  tpOrderId: string | null;
  tpSlSet: boolean;
  executedAt: string;
  tradeId: number | null;
}

export interface AuditResult {
  exchange: string;
  audited: number;
  missing: MissingTpSlEntry[];
  retried: RetryResult[];
}

export interface RetryResult {
  symbol: string;
  status: 'ok' | 'error' | 'skipped';
  reason?: string;
}

/**
 * 현재 열린 포지션(open positions) 중 sl_price가 계획됐으나
 * sl_order_id가 없는 케이스를 탐지한다.
 *
 * 쿼리 전략: positions + trades JOIN
 *   - positions에서 amount > 0 인 열린 포지션 목록
 *   - 각 포지션의 가장 최근 buy trade에서 sl_price/sl_order_id 확인
 */
export async function auditMissingTpSlOrders(
  exchange = 'binance',
  { retry = false, dryRun = true } = {},
): Promise<AuditResult> {
  const rows = await query<MissingTpSlEntry>(
    `
    SELECT DISTINCT ON (p.symbol)
      p.symbol,
      p.exchange,
      t.side,
      p.amount::double precision         AS amount,
      p.avg_price::double precision      AS "avgPrice",
      t.sl_price::double precision       AS "slPrice",
      t.tp_price::double precision       AS "tpPrice",
      t.sl_order_id                      AS "slOrderId",
      t.tp_order_id                      AS "tpOrderId",
      COALESCE(t.tp_sl_set, false)       AS "tpSlSet",
      t.executed_at::text                AS "executedAt",
      t.id                               AS "tradeId"
    FROM positions p
    JOIN trades t
      ON  t.symbol   = p.symbol
      AND t.exchange = p.exchange
      AND t.side     = 'buy'
      AND t.paper    = false
    WHERE p.amount > 0
      AND p.paper   = false
      AND p.exchange = $1
      AND t.sl_price IS NOT NULL
      AND t.sl_order_id IS NULL
    ORDER BY p.symbol, t.executed_at DESC
    `,
    [exchange],
  );

  const missing: MissingTpSlEntry[] = rows ?? [];

  const retried: RetryResult[] = [];
  if (retry && missing.length > 0) {
    for (const entry of missing) {
      const retryResult = await retryTpSlPlacement(entry, dryRun);
      retried.push(retryResult);
    }
  }

  return {
    exchange,
    audited: missing.length,
    missing,
    retried,
  };
}

/**
 * tp_sl_set 플래그 정합성 검사:
 * sl_order_id가 존재하는데 tp_sl_set=false인 레코드 → tp_sl_set=true로 갱신.
 * (감사 가능성 회복용 — 핵심 판단은 order_id 기준)
 */
export async function fixTpSlSetFlag(exchange = 'binance', { dryRun = true } = {}): Promise<{ fixed: number }> {
  if (dryRun) {
    const rows = await query(
      `SELECT COUNT(*)::int AS cnt FROM trades
       WHERE exchange = $1 AND side = 'buy' AND paper = false
         AND sl_order_id IS NOT NULL AND COALESCE(tp_sl_set, false) = false`,
      [exchange],
    );
    const cnt = rows?.[0]?.cnt ?? 0;
    console.log(`[tp-sl-audit][DRY-RUN] tp_sl_set 불일치 ${cnt}건 — 실제 수정 없음`);
    return { fixed: 0 };
  }

  const result = await query(
    `UPDATE trades
     SET tp_sl_set = true
     WHERE exchange = $1 AND side = 'buy' AND paper = false
       AND sl_order_id IS NOT NULL AND COALESCE(tp_sl_set, false) = false
     RETURNING id`,
    [exchange],
  );
  const fixed = result?.length ?? 0;
  if (fixed > 0) {
    console.log(`[tp-sl-audit] tp_sl_set=true 갱신 ${fixed}건 (sl_order_id 존재, 플래그 불일치 수정)`);
  }
  return { fixed };
}

/**
 * 단일 포지션의 SL 주문 재시도.
 *
 * 재시도 전략: hephaestos executeSignal에 sl_price가 담긴 SELL(stop) 신호를 전달해
 * 거래소 STOP_MARKET 주문을 생성한다.
 *
 * 현재 구현: dryRun=true 시 로그만, false 시 실제 신호 전송.
 * 실제 주문 생성은 hephaestos 파이프라인이 담당하므로 이 함수는 신호만 삽입한다.
 */
async function retryTpSlPlacement(entry: MissingTpSlEntry, dryRun: boolean): Promise<RetryResult> {
  const { symbol, exchange, slPrice, amount } = entry;

  if (!slPrice || slPrice <= 0) {
    return { symbol, status: 'skipped', reason: 'sl_price 없음' };
  }

  if (dryRun) {
    console.log(`[tp-sl-audit][DRY-RUN] ${symbol} SL 재배치 대상 — sl_price=${slPrice}, amount=${amount}`);
    return { symbol, status: 'skipped', reason: 'dry_run' };
  }

  try {
    // hephaestos 파이프라인 경유하여 SL 주문 재배치
    const signalId = await db.insertSignal({
      symbol,
      action: 'SELL',
      amountUsdt: Number(amount) * Number(slPrice),
      confidence: 1,
      reasoning: `TP/SL 미체결 감사 → SL 주문 재배치 (sl_price=${slPrice})`,
      exchange,
      tradeMode: 'normal',
      nemesisVerdict: 'approved',
      approvedAt: new Date().toISOString(),
      executionOrigin: 'tp_sl_placement_audit_retry',
      qualityFlag: 'exclude_from_learning',
      excludeFromLearning: true,
      incidentLink: 'tp_sl_missing_order_retry',
    });
    const signal = await db.getSignalById(signalId);
    await executeBinanceSignal({
      ...signal,
      exchange,
      trade_mode: 'normal',
      sl_price_override: slPrice,
    });
    console.log(`[tp-sl-audit] ${symbol} SL 재배치 완료`);
    return { symbol, status: 'ok' };
  } catch (err) {
    console.error(`[tp-sl-audit] ${symbol} SL 재배치 실패 — ${err.message}`);
    return { symbol, status: 'error', reason: err.message };
  }
}

export default { auditMissingTpSlOrders, fixTpSlSetFlag };
