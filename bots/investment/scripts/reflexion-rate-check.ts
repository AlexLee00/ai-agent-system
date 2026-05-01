#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { buildGuardrailResult, defineGuardrailCli } from './guardrail-check-common.ts';

export async function runReflexionRateCheck() {
  const total = await db.get(`SELECT COUNT(*)::int AS cnt FROM investment.luna_failure_reflexions`, []).catch(() => null);
  const recent = await db.get(
    `SELECT COUNT(*)::int AS cnt
     FROM investment.luna_failure_reflexions
     WHERE created_at >= NOW() - INTERVAL '7 days'`,
    [],
  ).catch(() => null);
  const totalCount = Number(total?.cnt || 0);
  const recentCount = Number(recent?.cnt || 0);
  return buildGuardrailResult({
    name: 'reflexion_extraction_rate',
    severity: 'medium',
    owner: 'luna',
    warnings: totalCount < 5 ? [`insufficient_reflexion_samples:${totalCount}`] : [],
    evidence: { totalCount, recent7dCount: recentCount, targetMinimum: 5 },
  });
}

defineGuardrailCli(import.meta.url, {
  name: 'reflexion_extraction_rate',
  run: runReflexionRateCheck,
});
