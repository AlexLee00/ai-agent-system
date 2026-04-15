#!/usr/bin/env node
// @ts-nocheck

import { runMarketCollectPipeline } from '../shared/pipeline-market-runner.ts';
import { runDecisionExecutionPipeline } from '../shared/pipeline-decision-runner.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { getPipelineRun } from '../shared/pipeline-db.ts';

function parseArgs(argv = []) {
  const args = { market: 'binance', json: false };
  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw.startsWith('--market=')) args.market = String(raw.split('=').slice(1).join('=') || 'binance');
  }
  return args;
}

function exchangeForMarket(market = 'binance') {
  if (market === 'kis' || market === 'kis_overseas' || market === 'binance') return market;
  if (market === 'crypto') return 'binance';
  if (market === 'domestic') return 'kis';
  if (market === 'overseas') return 'kis_overseas';
  return 'binance';
}

function renderText(result = {}) {
  return [
    `Runtime planner attach smoke: ${result.ok ? 'ok' : 'failed'}`,
    `sessionId: ${result.sessionId}`,
    `market: ${result.market}`,
    `bridgeStatus: ${result.bridgeStatus}`,
    `plannerMode: ${result.plannerMode || 'none'}`,
    `plannerTimeMode: ${result.plannerTimeMode || 'none'}`,
    `plannerTradeMode: ${result.plannerTradeMode || 'none'}`,
    `plannerAttached: ${result.plannerAttached ? 'yes' : 'no'}`,
  ].join('\n');
}

export async function runRuntimePlannerAttachSmoke({ market = 'binance', json = false } = {}) {
  const resolvedMarket = exchangeForMarket(market);
  const collect = await runMarketCollectPipeline({
    market: resolvedMarket,
    symbols: [],
    triggerType: 'smoke',
    meta: {
      market_script: 'runtime_planner_attach_smoke',
      smoke: true,
    },
  });
  await runDecisionExecutionPipeline({
    sessionId: collect.sessionId,
    symbols: [],
    exchange: resolvedMarket,
  });
  const row = await getPipelineRun(collect.sessionId);
  const result = {
    ok: true,
    sessionId: collect.sessionId,
    market: resolvedMarket,
    bridgeStatus: row?.meta?.bridge_status || null,
    plannerMode: row?.meta?.planner_mode || null,
    plannerTimeMode: row?.meta?.planner_time_mode || null,
    plannerTradeMode: row?.meta?.planner_trade_mode || null,
    plannerAttached: Boolean(row?.meta?.planner_mode),
  };
  if (json) return result;
  return renderText(result);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runRuntimePlannerAttachSmoke(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-planner-attach-smoke 오류:',
  });
}
