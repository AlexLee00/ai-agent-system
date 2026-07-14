// @ts-nocheck

import * as db from './db.ts';

export async function ensureDailyReflexionBudget({
  dryRun = false,
  budgetUsd = 3,
  getFn = db.get,
} = {}) {
  if (dryRun) return { ok: true, usedEstimateUsd: 0 };
  const safeBudget = Math.max(0, Number(budgetUsd || 0));
  if (safeBudget <= 0) return { ok: true, usedEstimateUsd: 0 };
  const row = await Promise.resolve(getFn(
    `SELECT (
       SELECT COUNT(*)::int
         FROM investment.luna_failure_reflexions
        WHERE created_at >= NOW()::date
          AND trade_id > 0
          AND COALESCE(avoid_pattern->>'source', '') <> 'failed-signal-reflexion-trigger'
     ) + (
       SELECT COUNT(*)::int
         FROM investment.trade_quality_evaluations
        WHERE evaluated_at >= NOW()::date
          AND jsonb_typeof(sub_score_breakdown->'reflection') = 'object'
          AND COALESCE(sub_score_breakdown->'reflection'->>'source', '') <> 'deduplicated'
     ) AS cnt`,
    [],
  )).catch(() => ({ cnt: 0 }));
  const usedEstimateUsd = Number(row?.cnt || 0) * 0.04;
  return { ok: usedEstimateUsd < safeBudget, usedEstimateUsd };
}

export default { ensureDailyReflexionBudget };
