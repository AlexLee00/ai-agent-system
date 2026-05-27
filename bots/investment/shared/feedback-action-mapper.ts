// @ts-nocheck
/**
 * Luna feedback action mapper.
 *
 * Converts post-trade failure reflexions into parameter-level shadow actions.
 * It is dry-run by default; DB writes require write=true.
 */

import * as db from './db.ts';

const MAPPER_ID = 'luna_feedback_action_mapper_v2';

export interface FeedbackActionCandidate {
  sourceTradeId: number | null;
  parameterName: string;
  oldValue: unknown;
  newValue: unknown;
  reason: string;
  metadata: Record<string, unknown>;
  confidence: number;
}

export interface FeedbackActionMapperResult {
  ok: boolean;
  market: string;
  days: number;
  dryRun: boolean;
  inspected: number;
  mapped: number;
  skipped: number;
  errors: number;
  candidates: FeedbackActionCandidate[];
  generatedAt: string;
}

function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string' || value.trim() === '') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function textOf(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function marketClause(market: string): string {
  return market === 'all'
    ? ''
    : `AND COALESCE(tj.market, lfr.avoid_pattern->>'market', 'crypto') = $3`;
}

async function fetchReflexions({ market, days, limit }: { market: string; days: number; limit: number }) {
  const params = market === 'all'
    ? [Math.max(1, days), Math.max(1, limit)]
    : [Math.max(1, days), Math.max(1, limit), market];
  return db.query(
    `SELECT
       lfr.id AS reflexion_id,
       lfr.trade_id,
       lfr.five_why,
       lfr.stage_attribution,
       lfr.hindsight,
       lfr.avoid_pattern,
       lfr.created_at,
       tj.symbol,
       tj.market,
       tj.exchange,
       tj.trade_mode,
       tj.pnl_percent,
       tj.hold_duration,
       tj.exit_reason,
       tj.market_regime,
       tj.strategy_family
     FROM investment.luna_failure_reflexions lfr
     LEFT JOIN investment.trade_journal tj ON tj.trade_id = lfr.trade_id::text
     WHERE lfr.created_at >= NOW() - ($1::int * INTERVAL '1 day')
       ${marketClause(market)}
       AND NOT EXISTS (
         SELECT 1
           FROM investment.feedback_to_action_map fam
          WHERE fam.source_trade_id = lfr.trade_id
            AND fam.metadata->>'mapper' = '${MAPPER_ID}'
       )
     ORDER BY lfr.created_at DESC
     LIMIT $2`,
    params,
  ).catch(() => []);
}

function classifyAction(row: Record<string, unknown>): FeedbackActionCandidate | null {
  const avoidPattern = asObject(row.avoid_pattern);
  const stage = asObject(row.stage_attribution);
  const evidenceText = [
    textOf(row.hindsight),
    textOf(row.five_why),
    textOf(avoidPattern),
    textOf(stage),
    textOf(row.exit_reason),
  ].join('\n').toLowerCase();

  const sourceTradeId = Number.isFinite(Number(row.trade_id)) ? Number(row.trade_id) : null;
  const symbol = String(row.symbol || avoidPattern.symbol || avoidPattern.symbol_pattern || 'unknown');
  const market = String(row.market || avoidPattern.market || 'crypto');
  const regime = row.market_regime || avoidPattern.regime || null;
  const strategyFamily = row.strategy_family || avoidPattern.strategy_family || null;
  const pnlPct = asNumber(row.pnl_percent, 0);
  const holdHours = asNumber(row.hold_duration, 0) / (60 * 60 * 1000);

  let parameterName = 'luna.entry.min_confidence_delta';
  let actionType = 'entry_threshold_tighten';
  let newValue = { direction: 'increase', delta: 0.03, maxDelta: 0.15 };
  let confidence = 0.58;
  let reason = `${symbol} 손실 reflexion 기반 신규 진입 신뢰도 상향`;

  if (evidenceText.includes('exit') || evidenceText.includes('청산') || evidenceText.includes('stop') || evidenceText.includes('손절')) {
    parameterName = 'luna.exit.recheck_gate';
    actionType = 'exit_recheck_gate_strengthen';
    newValue = { minConfirmations: 2, technicalChangeRequired: true, trailingStopReview: true };
    confidence = 0.68;
    reason = `${symbol} 청산/손절 관련 실패 패턴 반복: exit 재확인 게이트 강화`;
  } else if (Math.abs(pnlPct) >= 3 || evidenceText.includes('size') || evidenceText.includes('sizing') || evidenceText.includes('비중')) {
    parameterName = 'luna.sizing.loss_pattern_multiplier';
    actionType = 'sizing_reduce';
    newValue = { multiplier: 0.5, minSamples: 2, ttlDays: 14 };
    confidence = 0.72;
    reason = `${symbol} 손실 폭/비중 위험 감지: 동일 패턴 sizing 50% 축소`;
  } else if (regime || evidenceText.includes('regime') || evidenceText.includes('레짐')) {
    parameterName = 'luna.strategy.regime_bias';
    actionType = 'regime_bias_reduce';
    newValue = { regime, strategyFamily, biasDelta: -0.2, ttlDays: 21 };
    confidence = 0.64;
    reason = `${symbol} 레짐 의존 손실 감지: 해당 레짐 신규 진입 bias 축소`;
  }

  if (holdHours > 0 && holdHours < 1 && pnlPct < 0) {
    parameterName = 'luna.exit.min_hold_recheck';
    actionType = 'early_exit_recheck_strengthen';
    newValue = { minHoldMinutes: 60, allowHardStopBypass: true, recheckRequired: true };
    confidence = Math.max(confidence, 0.74);
    reason = `${symbol} 1시간 미만 손실 종료: hard stop 외 조기 종료 재확인 강화`;
  }

  return {
    sourceTradeId,
    parameterName,
    oldValue: null,
    newValue,
    reason,
    confidence,
    metadata: {
      mapper: MAPPER_ID,
      reflexionId: row.reflexion_id,
      symbol,
      market,
      exchange: row.exchange || null,
      tradeMode: row.trade_mode || null,
      pnlPct,
      holdHours: Number.isFinite(holdHours) ? Number(holdHours.toFixed(3)) : null,
      actionType,
      regime,
      strategyFamily,
      confidence,
      shadowOnly: true,
    },
  };
}

async function persistCandidate(candidate: FeedbackActionCandidate): Promise<void> {
  await db.run(
    `INSERT INTO investment.feedback_to_action_map
       (source_trade_id, parameter_name, old_value, new_value, reason, metadata, applied_at)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6::jsonb, NOW())`,
    [
      candidate.sourceTradeId,
      candidate.parameterName,
      JSON.stringify(candidate.oldValue),
      JSON.stringify(candidate.newValue),
      candidate.reason,
      JSON.stringify(candidate.metadata || {}),
    ],
  );
}

export async function runFeedbackActionMapper({
  market = 'all',
  days = 30,
  dryRun = true,
  write = false,
  limit = 50,
}: {
  market?: string;
  days?: number;
  dryRun?: boolean;
  write?: boolean;
  limit?: number;
} = {}): Promise<FeedbackActionMapperResult> {
  const effectiveDryRun = dryRun !== false || write !== true;
  const rows = await fetchReflexions({ market, days, limit });
  const candidates: FeedbackActionCandidate[] = [];
  let skipped = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      const candidate = classifyAction(row);
      if (!candidate) {
        skipped += 1;
        continue;
      }
      candidates.push(candidate);
      if (!effectiveDryRun) await persistCandidate(candidate);
    } catch (error) {
      errors += 1;
      console.warn(`[feedback-action-mapper] row_failed:${error?.message || String(error)}`);
    }
  }

  return {
    ok: errors === 0,
    market,
    days,
    dryRun: effectiveDryRun,
    inspected: rows.length,
    mapped: candidates.length,
    skipped,
    errors,
    candidates,
    generatedAt: new Date().toISOString(),
  };
}

export async function getFeedbackActionForSymbol(symbol: string, market = 'crypto'): Promise<FeedbackActionCandidate | null> {
  const row = await db.get(
    `SELECT *
       FROM investment.feedback_to_action_map
      WHERE metadata->>'mapper' = $1
        AND metadata->>'symbol' = $2
        AND COALESCE(metadata->>'market', $3) = $3
      ORDER BY (metadata->>'confidence')::double precision DESC NULLS LAST, applied_at DESC
      LIMIT 1`,
    [MAPPER_ID, symbol, market],
  ).catch(() => null);
  if (!row) return null;
  return {
    sourceTradeId: row.source_trade_id ?? null,
    parameterName: row.parameter_name,
    oldValue: row.old_value,
    newValue: row.new_value,
    reason: row.reason,
    metadata: asObject(row.metadata),
    confidence: asNumber(asObject(row.metadata).confidence, 0),
  };
}

export default { runFeedbackActionMapper, getFeedbackActionForSymbol };
