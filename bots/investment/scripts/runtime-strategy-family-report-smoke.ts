#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildStrategyFamilyRowsFromJournalRows } from './runtime-strategy-family-report.ts';

export async function runSmoke() {
  const previousEnabled = process.env.LUNA_OPERATING_EPOCH_ENABLED;
  const previousStartedAt = process.env.LUNA_OPERATING_EPOCH_STARTED_AT;
  process.env.LUNA_OPERATING_EPOCH_ENABLED = 'true';
  process.env.LUNA_OPERATING_EPOCH_STARTED_AT = '2026-05-08T00:00:00.000Z';

  try {
    const rows = buildStrategyFamilyRowsFromJournalRows([
      {
        strategy_family: 'mean_reversion',
        strategy_quality: 'ready',
        market: 'crypto',
        exchange: 'binance',
        trade_mode: 'normal',
        status: 'closed',
        created_at: Date.parse('2026-05-07T23:00:00.000Z'),
        entry_time: Date.parse('2026-05-07T22:30:00.000Z'),
        exit_time: Date.parse('2026-05-07T23:10:00.000Z'),
        pnl_percent: 987654321,
        pnl_net: 999,
      },
      {
        strategy_family: 'mean_reversion',
        strategy_quality: 'ready',
        market: 'crypto',
        exchange: 'binance',
        trade_mode: 'normal',
        status: 'closed',
        created_at: Date.parse('2026-05-08T01:00:00.000Z'),
        entry_time: Date.parse('2026-05-08T00:30:00.000Z'),
        exit_time: Date.parse('2026-05-08T01:10:00.000Z'),
        pnl_percent: 123456789,
        entry_price: 100,
        exit_price: 102,
        pnl_net: 2,
        quality_flag: 'trusted',
      },
      {
        strategy_family: 'mean_reversion',
        strategy_quality: 'ready',
        market: 'crypto',
        exchange: 'binance',
        trade_mode: 'normal',
        status: 'closed',
        created_at: Date.parse('2026-05-08T02:00:00.000Z'),
        entry_time: Date.parse('2026-05-08T01:30:00.000Z'),
        exit_time: Date.parse('2026-05-08T02:10:00.000Z'),
        pnl_percent: 5,
        quality_flag: 'exclude_from_learning',
      },
    ]);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].strategyFamily, 'short_term_scalping');
    assert.equal(rows[0].total, 1);
    assert.equal(rows[0].closed, 1);
    assert.equal(rows[0].wins, 1);
    assert.equal(rows[0].avgPnlPercent, 2);
    assert.equal(rows[0].pnlNet, 2);
    return { ok: true, rows };
  } finally {
    if (previousEnabled == null) delete process.env.LUNA_OPERATING_EPOCH_ENABLED;
    else process.env.LUNA_OPERATING_EPOCH_ENABLED = previousEnabled;
    if (previousStartedAt == null) delete process.env.LUNA_OPERATING_EPOCH_STARTED_AT;
    else process.env.LUNA_OPERATING_EPOCH_STARTED_AT = previousStartedAt;
  }
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('runtime-strategy-family-report-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ runtime-strategy-family-report-smoke 실패:' });
}
