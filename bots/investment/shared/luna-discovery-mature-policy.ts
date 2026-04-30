// @ts-nocheck
/**
 * shared/luna-discovery-mature-policy.ts — Phase Ω2: Discovery Mature 단계 정책
 *
 * 배경:
 *   Discovery Phase H (Mature) — 오래된 active position에 대해
 *   새 진입 회피 및 Hold 우선 정책을 적용한다.
 *
 * Mature 조건 (기본값):
 *   - position 보유 ≥ MATURE_DAYS일 (default 7)
 *   - strategy validity score ≥ MATURE_VALIDITY_MIN (default 0.7)
 *   - 최근 24h PnL drift < MATURE_DRIFT_MAX (default 5%)
 *
 * Kill Switch:
 *   LUNA_DISCOVERY_MATURE_POLICY_ENABLED=true → 활성 (default false)
 */

import * as db from './db.ts';

const ENABLED = () => {
  const raw = String(process.env.LUNA_DISCOVERY_MATURE_POLICY_ENABLED ?? 'false').toLowerCase();
  return raw === 'true' || raw === '1';
};

const MATURE_DAYS = () => Math.max(1, Number(process.env.LUNA_DISCOVERY_MATURE_DAYS || 7));
const MATURE_VALIDITY_MIN = () => Math.max(0, Number(process.env.LUNA_DISCOVERY_MATURE_VALIDITY_MIN || 0.7));
const MATURE_DRIFT_MAX = () => Math.max(0, Number(process.env.LUNA_DISCOVERY_MATURE_DRIFT_MAX || 0.05));

export type MatureSignalClass = 'mature' | 'immature' | 'unknown';

export interface MaturePosition {
  positionScopeKey: string;
  symbol: string;
  exchange: string;
  daysHeld: number;
  validityScore: number;
  pnlDrift24h: number;
  classification: MatureSignalClass;
  reason: string;
}

export interface MaturePolicyResult {
  enabled: boolean;
  checked: number;
  matureCount: number;
  immatureCount: number;
  positions: MaturePosition[];
}

/**
 * 단일 position의 Mature 분류.
 * validity_score와 days_held, pnl_drift를 기반으로 판단.
 */
export function classifyMatureSignal(opts: {
  daysHeld: number;
  validityScore?: number;
  pnlDrift24h?: number;
}): { classification: MatureSignalClass; reason: string } {
  const days = Number(opts.daysHeld || 0);
  const validity = Number(opts.validityScore ?? 1.0);
  const drift = Math.abs(Number(opts.pnlDrift24h ?? 0));

  if (days < MATURE_DAYS()) {
    return {
      classification: 'immature',
      reason: `보유 ${days}일 < mature 기준 ${MATURE_DAYS()}일`,
    };
  }
  if (validity < MATURE_VALIDITY_MIN()) {
    return {
      classification: 'immature',
      reason: `validity ${validity.toFixed(2)} < 기준 ${MATURE_VALIDITY_MIN()}`,
    };
  }
  if (drift > MATURE_DRIFT_MAX()) {
    return {
      classification: 'immature',
      reason: `24h PnL drift ${(drift * 100).toFixed(1)}% > 기준 ${(MATURE_DRIFT_MAX() * 100).toFixed(1)}%`,
    };
  }

  return {
    classification: 'mature',
    reason: `보유 ${days}일, validity ${validity.toFixed(2)}, drift ${(drift * 100).toFixed(1)}%`,
  };
}

/**
 * DB에서 open positions 조회 → Mature 분류 적용.
 * exchange 미지정 시 모든 거래소 대상.
 */
export async function classifyAllActiveMatureSignals(
  opts: { exchange?: string; limit?: number } = {},
): Promise<MaturePolicyResult> {
  if (!ENABLED()) {
    return { enabled: false, checked: 0, matureCount: 0, immatureCount: 0, positions: [] };
  }

  const params: unknown[] = [];
  let exchangeClause = '';
  if (opts.exchange) {
    params.push(opts.exchange);
    exchangeClause = `AND p.exchange = $${params.length}`;
  }
  params.push(opts.limit ?? 200);

  const rows = await db.query(
    `SELECT
       p.position_scope_key,
       p.symbol,
       p.exchange,
       EXTRACT(EPOCH FROM (NOW() - p.opened_at)) / 86400 AS days_held,
       COALESCE(sve.overall_score, 1.0)                  AS validity_score,
       COALESCE(
         (p.current_price - p.average_price) / NULLIF(p.average_price, 0),
         0
       )                                                  AS pnl_drift_24h
     FROM investment.positions p
     LEFT JOIN LATERAL (
       SELECT sve.overall_score
       FROM investment.strategy_validity_evaluations sve
       WHERE sve.position_scope_key = p.position_scope_key
       ORDER BY sve.evaluated_at DESC
       LIMIT 1
     ) sve ON true
     WHERE p.is_open = true
       ${exchangeClause}
     ORDER BY days_held DESC
     LIMIT $${params.length}`,
    params,
  ).catch(() => []);

  const positions: MaturePosition[] = (rows || []).map((row: any) => {
    const { classification, reason } = classifyMatureSignal({
      daysHeld: Number(row.days_held || 0),
      validityScore: Number(row.validity_score || 1.0),
      pnlDrift24h: Number(row.pnl_drift_24h || 0),
    });
    return {
      positionScopeKey: row.position_scope_key,
      symbol: row.symbol,
      exchange: row.exchange,
      daysHeld: Math.round(Number(row.days_held || 0) * 10) / 10,
      validityScore: Number(row.validity_score || 1.0),
      pnlDrift24h: Number(row.pnl_drift_24h || 0),
      classification,
      reason,
    };
  });

  const matureCount = positions.filter(p => p.classification === 'mature').length;
  const immatureCount = positions.filter(p => p.classification === 'immature').length;

  return {
    enabled: true,
    checked: positions.length,
    matureCount,
    immatureCount,
    positions,
  };
}

/**
 * 진입 후보 중 Mature position이 있는 심볼 필터.
 * discovery-orchestrator에서 새 진입 결정 전 호출.
 *
 * @returns 진입 허용 심볼 목록 (mature 심볼 제외)
 */
export async function filterMatureFromNewEntries(
  candidateSymbols: string[],
  exchange?: string,
): Promise<{
  allowed: string[];
  held: string[];
  matureDetail: Record<string, string>;
}> {
  if (!ENABLED() || candidateSymbols.length === 0) {
    return { allowed: candidateSymbols, held: [], matureDetail: {} };
  }

  const result = await classifyAllActiveMatureSignals({ exchange });
  const matureSymbols = new Set(
    result.positions
      .filter(p => p.classification === 'mature')
      .map(p => p.symbol),
  );

  const allowed: string[] = [];
  const held: string[] = [];
  const matureDetail: Record<string, string> = {};

  for (const sym of candidateSymbols) {
    if (matureSymbols.has(sym)) {
      held.push(sym);
      const pos = result.positions.find(p => p.symbol === sym && p.classification === 'mature');
      if (pos) matureDetail[sym] = pos.reason;
    } else {
      allowed.push(sym);
    }
  }

  if (held.length > 0) {
    console.log(`[mature-policy] 새 진입 Hold: ${held.join(', ')} (mature 포지션 보유 중)`);
  }

  return { allowed, held, matureDetail };
}

/**
 * 심볼 단일 조회 — entry-trigger-engine에서 간단 체크용.
 */
export async function isMaturePosition(
  symbol: string,
  exchange?: string,
): Promise<boolean> {
  if (!ENABLED()) return false;

  const rows = await db.query(
    `SELECT
       EXTRACT(EPOCH FROM (NOW() - p.opened_at)) / 86400 AS days_held,
       COALESCE(sve.overall_score, 1.0) AS validity_score,
       COALESCE(
         ABS((p.current_price - p.average_price) / NULLIF(p.average_price, 0)),
         0
       ) AS pnl_drift
     FROM investment.positions p
     LEFT JOIN LATERAL (
       SELECT sve.overall_score
       FROM investment.strategy_validity_evaluations sve
       WHERE sve.position_scope_key = p.position_scope_key
       ORDER BY sve.evaluated_at DESC
       LIMIT 1
     ) sve ON true
     WHERE p.is_open = true
       AND p.symbol = $1
       ${exchange ? 'AND p.exchange = $2' : ''}
     LIMIT 1`,
    exchange ? [symbol, exchange] : [symbol],
  ).catch(() => []);

  if (!rows || rows.length === 0) return false;

  const row = rows[0];
  const { classification } = classifyMatureSignal({
    daysHeld: Number(row.days_held || 0),
    validityScore: Number(row.validity_score || 1.0),
    pnlDrift24h: Number(row.pnl_drift || 0),
  });

  return classification === 'mature';
}
