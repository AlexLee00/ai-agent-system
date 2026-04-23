#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { createOrUpdatePositionStrategyProfile } from '../shared/strategy-profile.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const values = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [rawKey, ...rest] = arg.slice(2).split('=');
    values[rawKey] = rest.length > 0 ? rest.join('=') : true;
  }

  return {
    json: Boolean(values.json),
    exchange: values.exchange ? String(values.exchange) : null,
    tradeMode: values['trade-mode'] ? String(values['trade-mode']) : null,
    refresh: Boolean(values.refresh),
  };
}

async function inferDecisionFromPosition(position) {
  const amountUsdt = Number(position.amount || 0) * Number(position.avg_price || 0);
  return {
    action: 'BUY',
    amount_usdt: amountUsdt,
    confidence: 0.5,
    reasoning: 'open_position_backfill',
    trade_mode: position.trade_mode || 'normal',
  };
}

async function findBestSeedSignal(position) {
  const rows = await db.query(
    `SELECT *
       FROM signals
      WHERE symbol = $1
        AND exchange = $2
        AND action = 'BUY'
        AND COALESCE(trade_mode, 'normal') = $3
      ORDER BY
        CASE
          WHEN status = 'executed' THEN 0
          WHEN approved_at IS NOT NULL THEN 1
          WHEN status = 'approved' THEN 2
          ELSE 3
        END,
        created_at DESC
      LIMIT 10`,
    [position.symbol, position.exchange, position.trade_mode || 'normal'],
  ).catch(() => []);

  return rows[0] || null;
}

function needsRefresh(existing = null) {
  if (!existing) return true;
  const ratios = existing?.exit_plan?.partialExitRatios || existing?.exitPlan?.partialExitRatios;
  return !ratios || typeof ratios !== 'object' || Object.keys(ratios).length === 0;
}

export async function runBackfill({ exchange = null, tradeMode = null, json = false, refresh = false } = {}) {
  await db.initSchema();
  const positions = await db.getOpenPositions(exchange, false, tradeMode);
  const processed = [];

  for (const position of positions) {
    const existing = await db.getPositionStrategyProfile(position.symbol, {
      exchange: position.exchange,
      tradeMode: position.trade_mode || 'normal',
    }).catch(() => null);
    if (existing && !(refresh || needsRefresh(existing))) {
      processed.push({
        symbol: position.symbol,
        exchange: position.exchange,
        tradeMode: position.trade_mode || 'normal',
        status: 'existing',
        strategyName: existing.strategy_name || null,
      });
      continue;
    }

    const latestSignal = await findBestSeedSignal(position);

    const profile = await createOrUpdatePositionStrategyProfile({
      signalId: existing?.signal_id || latestSignal?.id || null,
      symbol: position.symbol,
      exchange: position.exchange,
      tradeMode: position.trade_mode || 'normal',
      decision: await inferDecisionFromPosition(position),
      seedSignal: latestSignal,
    });

    processed.push({
      symbol: position.symbol,
      exchange: position.exchange,
      tradeMode: position.trade_mode || 'normal',
      status: profile ? (existing ? 'refreshed' : 'created') : 'skipped',
      strategyName: profile?.strategy_name || null,
      signalId: existing?.signal_id || latestSignal?.id || null,
    });
  }

  const payload = {
    ok: true,
    total: processed.length,
    created: processed.filter((item) => item.status === 'created').length,
    refreshed: processed.filter((item) => item.status === 'refreshed').length,
    existing: processed.filter((item) => item.status === 'existing').length,
    rows: processed,
  };

  if (json) return payload;
  return JSON.stringify(payload, null, 2);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: () => db.initSchema(),
    run: async () => {
      const args = parseArgs();
      return runBackfill(args);
    },
    onSuccess: async (result) => {
      if (typeof result === 'string') console.log(result);
      else console.log(JSON.stringify(result, null, 2));
    },
    errorPrefix: '❌ backfill-position-strategy-profiles 오류:',
  });
}
