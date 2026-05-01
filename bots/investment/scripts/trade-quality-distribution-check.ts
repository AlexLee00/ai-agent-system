#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { buildGuardrailResult, defineGuardrailCli } from './guardrail-check-common.ts';

export async function runTradeQualityDistributionCheck() {
  const rows = await db.query(
    `SELECT category, COUNT(*)::int AS cnt
     FROM trade_quality_evaluations
     WHERE evaluated_at >= NOW() - INTERVAL '30 days'
     GROUP BY category
     ORDER BY category`,
    [],
  ).catch(() => []);
  const distribution = Object.fromEntries((rows || []).map((row) => [row.category || 'unknown', Number(row.cnt || 0)]));
  const total = Object.values(distribution).reduce((sum, value) => sum + Number(value || 0), 0);
  return buildGuardrailResult({
    name: 'trade_quality_distribution',
    severity: 'medium',
    owner: 'chronos',
    warnings: total === 0 ? ['no_trade_quality_evaluations_30d'] : [],
    evidence: { total30d: total, distribution },
  });
}

defineGuardrailCli(import.meta.url, {
  name: 'trade_quality_distribution',
  run: runTradeQualityDistributionCheck,
});
