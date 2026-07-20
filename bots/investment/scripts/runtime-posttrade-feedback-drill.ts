#!/usr/bin/env node
// @ts-nocheck

import { fetchPendingPosttradeCandidates } from '../shared/trade-quality-evaluator.ts';
import {
  countPendingTradeJournalPosttradeCandidates,
  fetchRecentClosedTradeJournalPosttradeTrades,
} from '../shared/posttrade-trade-journal-adapter.ts';
import { runPosttradeFeedback } from './runtime-posttrade-feedback.ts';
import { buildPosttradeFeedbackDashboard } from './runtime-posttrade-feedback-dashboard.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const limitRaw = argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1];
  const market = argv.find((arg) => arg.startsWith('--market='))?.split('=')[1] || 'all';
  return {
    json: argv.includes('--json'),
    executeLlmDryRun: argv.includes('--execute-llm-dry-run'),
    limit: Math.max(1, Number(limitRaw || 20) || 20),
    market: String(market).trim().toLowerCase() || 'all',
  };
}

export async function runPosttradeFeedbackDrill(input = {}, dependencies = {}) {
  const args = { ...parseArgs([]), ...(input || {}) };
  const fetchPendingCandidates = dependencies.fetchPendingCandidates || fetchPendingPosttradeCandidates;
  const fetchRecentClosedTrades = dependencies.fetchRecentClosedTrades || fetchRecentClosedTradeJournalPosttradeTrades;
  const countPendingCandidates = dependencies.countPendingCandidates || countPendingTradeJournalPosttradeCandidates;
  const buildDashboard = dependencies.buildDashboard || buildPosttradeFeedbackDashboard;
  const runFeedback = dependencies.runFeedback || runPosttradeFeedback;
  const candidates = await fetchPendingCandidates({
    limit: args.limit,
    market: args.market,
  });
  const recentClosedTrades = await fetchRecentClosedTrades({
    limit: args.limit,
    market: args.market,
  });
  const pendingTotal = await countPendingCandidates({ market: args.market });
  const dashboard = await buildDashboard({
    days: 7,
    market: args.market,
    initSchema: false,
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
      dryRunExecution = await runFeedback({
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
    pendingTotal,
    recentClosedTrades,
    dashboard,
    dryRunExecution,
    note: args.executeLlmDryRun
      ? 'A/B/C enabled only in-process for non-mutating dry-run; LLM may have been called.'
      : 'No LLM execution performed. Pass --execute-llm-dry-run for non-mutating live-data evaluation.',
    liveMutation: false,
  };
}

async function main() {
  const args = parseArgs();
  const result = await runPosttradeFeedbackDrill(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`posttrade drill ok — pending=${result.pendingCandidates.length}/${result.pendingTotal} recentClosed=${result.recentClosedTrades.length}`);
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-posttrade-feedback-drill 실패:',
  });
}
