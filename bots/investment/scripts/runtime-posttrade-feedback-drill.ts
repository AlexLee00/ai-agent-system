#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { fetchPendingPosttradeCandidates } from '../shared/trade-quality-evaluator.ts';
import { runPosttradeFeedback } from './runtime-posttrade-feedback.ts';
import { buildPosttradeFeedbackDashboard } from './runtime-posttrade-feedback-dashboard.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const limitRaw = argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1];
  const market = argv.find((arg) => arg.startsWith('--market='))?.split('=')[1] || 'all';
  return {
    json: argv.includes('--json'),
    executeLlmDryRun: argv.includes('--execute-llm-dry-run'),
    limit: Math.max(1, Number(limitRaw || 3) || 3),
    market: String(market).trim().toLowerCase() || 'all',
  };
}

async function fetchRecentClosedTrades({ limit = 3, market = 'all' } = {}) {
  const normalized = String(market || 'all').trim().toLowerCase();
  const params: unknown[] = [Math.max(1, Number(limit || 3))];
  let marketClause = '';
  if (normalized !== 'all') {
    params.push(normalized);
    marketClause = `
      AND COALESCE(th.market, CASE WHEN th.exchange = 'binance' THEN 'crypto' WHEN th.exchange = 'kis' THEN 'domestic' ELSE 'overseas' END) = $2
    `;
  }
  return db.query(
    `SELECT th.id, th.symbol, th.exchange, th.market, th.exit_at
       FROM investment.trade_history th
      WHERE th.exit_at IS NOT NULL
        ${marketClause}
      ORDER BY th.exit_at DESC
      LIMIT $1`,
    params,
  ).catch(() => []);
}

export async function runPosttradeFeedbackDrill(input = {}) {
  const args = { ...parseArgs([]), ...(input || {}) };
  await db.initSchema();
  const candidates = await fetchPendingPosttradeCandidates({
    limit: args.limit,
    market: args.market,
  });
  const recentClosedTrades = await fetchRecentClosedTrades({
    limit: args.limit,
    market: args.market,
  });
  const dashboard = await buildPosttradeFeedbackDashboard({
    days: 7,
    market: args.market,
  });

  let dryRunExecution = null;
  if (args.executeLlmDryRun) {
    const oldA = process.env.LUNA_TRADE_QUALITY_EVALUATOR_ENABLED;
    const oldB = process.env.LUNA_STAGE_ATTRIBUTION_ENABLED;
    const oldC = process.env.LUNA_REFLEXION_ENGINE_ENABLED;
    process.env.LUNA_TRADE_QUALITY_EVALUATOR_ENABLED = 'true';
    process.env.LUNA_STAGE_ATTRIBUTION_ENABLED = 'true';
    process.env.LUNA_REFLEXION_ENGINE_ENABLED = 'true';
    try {
      dryRunExecution = await runPosttradeFeedback({
        limit: args.limit,
        market: args.market,
        dryRun: true,
        json: false,
        tradeId: null,
      });
    } finally {
      if (oldA === undefined) delete process.env.LUNA_TRADE_QUALITY_EVALUATOR_ENABLED;
      else process.env.LUNA_TRADE_QUALITY_EVALUATOR_ENABLED = oldA;
      if (oldB === undefined) delete process.env.LUNA_STAGE_ATTRIBUTION_ENABLED;
      else process.env.LUNA_STAGE_ATTRIBUTION_ENABLED = oldB;
      if (oldC === undefined) delete process.env.LUNA_REFLEXION_ENGINE_ENABLED;
      else process.env.LUNA_REFLEXION_ENGINE_ENABLED = oldC;
    }
  }

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    market: args.market,
    limit: args.limit,
    pendingCandidates: candidates,
    recentClosedTrades,
    dashboard,
    dryRunExecution,
    note: args.executeLlmDryRun
      ? 'A/B/C enabled only in-process for non-mutating dry-run; LLM may have been called.'
      : 'No LLM execution performed. Pass --execute-llm-dry-run for non-mutating live-data evaluation.',
  };
}

async function main() {
  const args = parseArgs();
  const result = await runPosttradeFeedbackDrill(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`posttrade drill ok — pending=${result.pendingCandidates.length} recentClosed=${result.recentClosedTrades.length}`);
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-posttrade-feedback-drill 실패:',
  });
}

