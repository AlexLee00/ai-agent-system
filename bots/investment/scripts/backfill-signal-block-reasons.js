#!/usr/bin/env node

import * as db from '../shared/db.js';
import { pathToFileURL } from 'url';

const DOMESTIC_MIN_KRW = 10_000;
const DOMESTIC_MAX_KRW = 5_000_000;
const OVERSEAS_MIN_USD = 10;
const OVERSEAS_MAX_USD = 1_000;

function inferBlockReason(row) {
  const exchange = row.exchange || 'unknown';
  const action = String(row.action || '').toUpperCase();
  const amount = Number(row.amount_usdt || 0);

  if (exchange === 'kis') {
    if (action === 'BUY' && amount > 0 && amount < DOMESTIC_MIN_KRW) {
      return `최소 주문금액 미달 (${amount.toLocaleString()}원)`;
    }
    if (action === 'BUY' && amount > DOMESTIC_MAX_KRW) {
      return `최대 주문금액 초과 (${amount.toLocaleString()}원)`;
    }
    return 'legacy_executor_failed_without_reason';
  }

  if (exchange === 'kis_overseas') {
    if (action === 'BUY' && amount > 0 && amount < OVERSEAS_MIN_USD) {
      return `최소 주문금액 미달 ($${amount})`;
    }
    if (action === 'BUY' && amount > OVERSEAS_MAX_USD) {
      return `최대 주문금액 초과 ($${amount})`;
    }
    return 'legacy_order_rejected_without_reason';
  }

  if (exchange === 'binance') {
    return 'legacy_executor_failed_without_reason';
  }

  return 'legacy_missing_block_reason';
}

export async function backfillSignalBlockReasons({ dryRun = false, days = 30 } = {}) {
  await db.initSchema();
  const safeDays = Number.isFinite(Number(days)) ? Math.max(1, Math.floor(Number(days))) : 30;

  const rows = await db.query(`
    SELECT id, symbol, exchange, action, amount_usdt, status, block_reason, created_at
    FROM investment.signals
    WHERE created_at > now() - interval '${safeDays} days'
      AND status IN ('failed', 'rejected', 'expired')
      AND (block_reason IS NULL OR block_reason = '')
    ORDER BY created_at DESC
  `);

  const updates = rows.map(row => ({
    id: row.id,
    exchange: row.exchange,
    symbol: row.symbol,
    inferredReason: inferBlockReason(row),
  }));

  if (!dryRun) {
    for (const item of updates) {
      await db.run(
        `UPDATE investment.signals
         SET block_reason = $1
         WHERE id = $2`,
        [item.inferredReason, item.id],
      );
    }
  }

  return {
    days,
    dryRun,
    updated: updates.length,
    items: updates,
  };
}

async function main() {
  const dryRunArg = process.argv.includes('--dry-run');
  const daysArg = process.argv.find(arg => arg.startsWith('--days='));
  const days = daysArg ? parseInt(daysArg.split('=')[1], 10) : 30;
  const result = await backfillSignalBlockReasons({ dryRun: dryRunArg, days });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    const detail = err?.errors?.length
      ? ` | ${err.errors.map(inner => inner?.message || String(inner)).join(' | ')}`
      : '';
    console.error(`❌ signal block_reason 백필 실패: ${err?.message || String(err)}${detail}`);
    process.exit(1);
  });
}
