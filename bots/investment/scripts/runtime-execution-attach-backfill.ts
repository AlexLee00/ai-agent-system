#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  attachExecutionToPositionStrategy,
  attachExecutionToPositionStrategyTracked,
} from '../shared/execution-attach.ts';

function parseArgs(argv = []) {
  return {
    dryRun: !argv.includes('--write'),
    forceRefresh: argv.includes('--refresh'),
    days: Math.max(1, Number(argv.find((arg) => arg.startsWith('--days='))?.split('=')[1] || 14)),
    limit: Math.max(1, Number(argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1] || 100)),
    exchange: argv.find((arg) => arg.startsWith('--exchange='))?.split('=').slice(1).join('=') || null,
    requireOpenPosition: !argv.includes('--include-closed'),
    json: argv.includes('--json'),
  };
}

async function loadBuyTrades({ days = 14, limit = 100, exchange = null } = {}) {
  const conditions = [
    `LOWER(side) = 'buy'`,
    `executed_at >= now() - ($1::int * interval '1 day')`,
  ];
  const params = [Number(days || 14)];
  if (exchange) {
    params.push(exchange);
    conditions.push(`exchange = $${params.length}`);
  }
  params.push(Math.max(1, Number(limit || 100)));
  return db.query(
    `SELECT *
       FROM investment.trades
      WHERE ${conditions.join(' AND ')}
      ORDER BY executed_at DESC
      LIMIT $${params.length}`,
    params,
  );
}

async function loadSignals(trades = []) {
  const ids = [...new Set(trades.map((trade) => trade.signal_id).filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await db.query(
    `SELECT * FROM investment.signals WHERE id = ANY($1)`,
    [ids],
  ).catch(() => []);
  return new Map(rows.map((row) => [row.id, row]));
}

function summarize(rows = []) {
  const byStatus = {};
  for (const row of rows) byStatus[row.status] = (byStatus[row.status] || 0) + 1;
  return {
    total: rows.length,
    attached: rows.filter((row) => row.attached).length,
    wouldAttach: rows.filter((row) => String(row.status || '').startsWith('would_')).length,
    byStatus,
  };
}

export async function runExecutionAttachBackfill({
  days = 14,
  limit = 100,
  exchange = null,
  dryRun = true,
  forceRefresh = false,
  requireOpenPosition = true,
} = {}) {
  await db.initSchema();
  const trades = await loadBuyTrades({ days, limit, exchange });
  const signalById = await loadSignals(trades);
  const rows = [];

  for (const trade of trades) {
    const signal = trade.signal_id ? signalById.get(trade.signal_id) || null : null;
    const attachFn = dryRun
      ? attachExecutionToPositionStrategy
      : attachExecutionToPositionStrategyTracked;
    const result = await attachFn({
      trade,
      signal,
      dryRun,
      forceRefresh,
      requireOpenPosition,
      persistMeta: !dryRun,
    });
    rows.push({
      tradeId: trade.id || null,
      signalId: trade.signal_id || null,
      symbol: trade.symbol,
      exchange: trade.exchange,
      tradeMode: trade.trade_mode || 'normal',
      executedAt: trade.executed_at,
      metaPersisted: !dryRun && Boolean(trade.signal_id),
      ...result,
    });
  }

  return {
    ok: true,
    dryRun,
    days,
    limit,
    exchange,
    requireOpenPosition,
    metaPersistence: dryRun ? 'disabled_dry_run' : 'signals.block_meta.executionAttach',
    summary: summarize(rows),
    rows: rows.slice(0, 50),
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: async () => {},
    run: async () => runExecutionAttachBackfill(parseArgs(process.argv.slice(2))),
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: '❌ execution attach backfill 오류:',
  });
}
