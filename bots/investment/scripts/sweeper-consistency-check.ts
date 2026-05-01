#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { buildGuardrailResult, defineGuardrailCli } from './guardrail-check-common.ts';

export async function runSweeperConsistencyCheck() {
  const positions = await db.getAllPositions(null, false).catch((error) => ({ error: String(error?.message || error) }));
  if (!Array.isArray(positions)) {
    return buildGuardrailResult({
      name: 'wallet_db_consistency',
      severity: 'critical',
      owner: 'sweeper',
      blockers: ['position_ledger_unavailable'],
      evidence: { error: positions?.error || 'unknown' },
    });
  }
  const invalid = positions.filter((position) => !position.symbol || !position.exchange);
  const dust = positions.filter((position) => {
    const notional = Math.abs(Number(position.amount || 0) * Number(position.avg_price || position.avgPrice || 0));
    return position.exchange === 'binance' && notional > 0 && notional < 10;
  });
  return buildGuardrailResult({
    name: 'wallet_db_consistency',
    severity: 'critical',
    owner: 'sweeper',
    blockers: invalid.length > 0 ? [`invalid_position_rows:${invalid.length}`] : [],
    warnings: dust.length > 0 ? [`dust_positions_present:${dust.length}`] : [],
    evidence: {
      positionCount: positions.length,
      invalidCount: invalid.length,
      dustCount: dust.length,
    },
  });
}

defineGuardrailCli(import.meta.url, {
  name: 'wallet_db_consistency',
  run: runSweeperConsistencyCheck,
});
