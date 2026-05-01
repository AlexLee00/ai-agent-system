#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { calculateRealizedPnl } from '../shared/realized-pnl-calculator.ts';
import { buildGuardrailResult, defineGuardrailCli } from './guardrail-check-common.ts';

export async function runRealizedPnlCheck() {
  const sanity = calculateRealizedPnl({
    buy: { price: 100, quantity: 2, fee: 0.5 },
    sell: { price: 112, quantity: 2, fee: 0.5 },
  });
  const recentSell = await db.get(
    `SELECT COUNT(*)::int AS cnt
     FROM trades
     WHERE UPPER(side) = 'SELL'
       AND created_at >= NOW() - INTERVAL '30 days'`,
    [],
  ).catch(() => null);
  return buildGuardrailResult({
    name: 'realized_pnl_calculation',
    severity: 'high',
    owner: 'sweeper',
    blockers: sanity.ok === true ? [] : ['realized_pnl_sanity_failed'],
    warnings: Number(recentSell?.cnt || 0) === 0 ? ['no_recent_sell_trades_to_verify'] : [],
    evidence: {
      sanity,
      recentSellTrades30d: Number(recentSell?.cnt || 0),
    },
  });
}

defineGuardrailCli(import.meta.url, {
  name: 'realized_pnl_calculation',
  run: runRealizedPnlCheck,
});
