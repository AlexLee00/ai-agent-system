#!/usr/bin/env node
// @ts-nocheck
import * as db from '../shared/db.ts';
import { classifyStrategyFamily } from '../shared/strategy-family-classifier.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function parseArgs(argv = process.argv.slice(2)) {
  return {
    json: argv.includes('--json'),
    smoke: argv.includes('--smoke'),
    apply: argv.includes('--apply'),
    confirm: argv.find((arg) => arg.startsWith('--confirm='))?.split('=')[1] || null,
    limit: Number(argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1] || '1000'),
  };
}

function parseMaybeJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function buildStrategyFamilyBackfillPlan(rows = []) {
  const updates = rows.map((row) => {
    const strategyRoute = parseMaybeJson(row.strategy_route);
    const strategyConfig = parseMaybeJson(row.strategy_config);
    const result = classifyStrategyFamily({
      reasoning: row.reasoning || strategyConfig?.reasoning || strategyConfig?.summary || null,
      market: row.market,
      exchange: row.exchange,
      regime: row.market_regime,
      strategyRoute,
      strategyName: strategyConfig?.strategyName || strategyConfig?.strategy_name || null,
      strategySummary: strategyConfig?.strategySummary || strategyConfig?.strategy_summary || null,
      timeframe: strategyConfig?.timeframe || strategyConfig?.time_frame || null,
      confidence: row.confidence ?? null,
    });
    return {
      id: row.id,
      tradeId: row.trade_id,
      symbol: row.symbol,
      family: result.family,
      source: result.source,
      confidence: result.confidence,
    };
  });
  const byFamily = {};
  for (const update of updates) byFamily[update.family] = (byFamily[update.family] || 0) + 1;
  return { total: rows.length, updates, byFamily };
}

function buildSmokeRows() {
  return [
    {
      id: 1,
      trade_id: 'smoke-scalp',
      market: 'crypto',
      exchange: 'binance',
      symbol: 'BTC/USDT',
      market_regime: 'trending_bull',
      strategy_config: JSON.stringify({ strategySummary: '15m scalp breakout', timeframe: '15m' }),
    },
    {
      id: 2,
      trade_id: 'smoke-defensive',
      market: 'domestic',
      exchange: 'kis',
      symbol: '005930',
      market_regime: 'trending_bear',
      reasoning: 'defensive bear rotation',
    },
  ];
}

async function loadRows({ limit }) {
  return db.query(
    `SELECT
       j.id, j.trade_id, j.market, j.exchange, j.symbol, j.market_regime,
       j.strategy_route
     FROM investment.trade_journal j
     WHERE j.strategy_family IS NULL OR j.strategy_family = ''
     ORDER BY j.id DESC
     LIMIT $1`,
    [limit],
  );
}

export async function runStrategyFamilyBackfill(args = parseArgs()) {
  const rows = args.smoke ? buildSmokeRows() : await loadRows({ limit: args.limit });
  const plan = buildStrategyFamilyBackfillPlan(rows);
  const canApply = args.apply && args.confirm === 'backfill-trade-strategy-family';
  if (args.apply && !canApply) {
    throw new Error('apply requires --confirm=backfill-trade-strategy-family');
  }
  let applied = 0;
  if (canApply) {
    for (const update of plan.updates) {
      await db.run(`UPDATE investment.trade_journal SET strategy_family = $1 WHERE id = $2`, [update.family, update.id]);
      applied += 1;
    }
  }
  return {
    ok: true,
    dryRun: !canApply,
    applied,
    total: plan.total,
    byFamily: plan.byFamily,
    sample: plan.updates.slice(0, 10),
  };
}

async function main() {
  const args = parseArgs();
  const result = await runStrategyFamilyBackfill(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`backfill-trade-strategy-family total=${result.total} dryRun=${result.dryRun}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ backfill-trade-strategy-family 실패:' });
}
