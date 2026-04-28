#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import * as db from '../shared/db.ts';
import { reevaluateOpenPositions } from '../shared/position-reevaluator.ts';

function parseArgs(argv = []) {
  const args = {
    symbol: null,
    exchange: null,
    tradeMode: null,
    minutesBack: 180,
    eventSource: 'position_watch',
    attentionType: null,
    attentionReason: null,
    timeframe: null,
    persist: true,
    json: false,
  };
  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw === '--no-persist') args.persist = false;
    else if (raw.startsWith('--symbol=')) args.symbol = raw.split('=').slice(1).join('=') || null;
    else if (raw.startsWith('--exchange=')) args.exchange = raw.split('=').slice(1).join('=') || null;
    else if (raw.startsWith('--trade-mode=')) args.tradeMode = raw.split('=').slice(1).join('=') || 'normal';
    else if (raw.startsWith('--minutes=')) args.minutesBack = Math.max(10, Number(raw.split('=').slice(1).join('=') || 180));
    else if (raw.startsWith('--event-source=')) args.eventSource = raw.split('=').slice(1).join('=') || 'position_watch';
    else if (raw.startsWith('--attention-type=')) args.attentionType = raw.split('=').slice(1).join('=') || null;
    else if (raw.startsWith('--attention-reason=')) args.attentionReason = raw.split('=').slice(1).join('=') || null;
    else if (raw.startsWith('--timeframe=')) args.timeframe = raw.split('=').slice(1).join('=') || null;
  }
  return args;
}

function renderText(result = {}) {
  if (!result.ok) return `status: ${result.status || 'error'}`;
  const row = result.row || {};
  const runtimeState = row.runtimeState || {};
  const executionIntent = row.executionIntent || runtimeState.executionIntent || {};
  const validity = row.strategyValidity || {};
  return [
    '⚡ Position Reevaluation Event',
    `symbol: ${row.symbol || result.args?.symbol || 'n/a'}`,
    `exchange: ${row.exchange || result.args?.exchange || 'n/a'}`,
    `status: ${result.status}`,
    `recommendation: ${row.recommendation || 'n/a'}`,
    `reason: ${row.reasonCode || 'n/a'} | ${row.reason || 'n/a'}`,
    `runtime: ${runtimeState.regime?.regime || 'n/a'} | cadence ${runtimeState.monitoringPolicy?.cadenceMs || 'n/a'}ms`,
    `validity: posterior ${Number(validity.score || 0).toFixed(3)} | actionScore ${Number(validity.actionScore ?? validity.score ?? 0).toFixed(3)} | action ${validity.action || 'n/a'}${validity.shadowMode ? ' [shadow]' : ''}`,
    `intent: ${executionIntent.action || 'HOLD'} | ${executionIntent.runner || 'n/a'}`,
  ].join('\n');
}

export async function runPositionReevaluationEvent(args = {}) {
  if (!args.symbol || !args.exchange) {
    return {
      ok: false,
      status: 'position_reeval_event_invalid_args',
      reason: 'symbol and exchange are required',
      args,
    };
  }

  const report = await reevaluateOpenPositions({
    symbol: args.symbol,
    exchange: args.exchange,
    tradeMode: args.tradeMode,
    paper: false,
    persist: args.persist !== false,
    minutesBack: args.minutesBack,
    eventSource: args.eventSource || 'position_watch',
    attentionType: args.attentionType || null,
    attentionReason: args.attentionReason || null,
    eventPayload: {
      requestedAt: new Date().toISOString(),
      timeframe: args.timeframe || null,
    },
  });

  const row = (report.rows || [])[0] || null;
  if (!row) {
    return {
      ok: false,
      status: 'position_reeval_event_not_found',
      args,
      reportSummary: report.summary || null,
    };
  }

  return {
    ok: true,
    status: row.recommendation === 'EXIT'
      ? 'position_reeval_event_exit_ready'
      : row.recommendation === 'ADJUST'
        ? 'position_reeval_event_adjust_ready'
        : 'position_reeval_event_hold',
    args,
    row,
    validityCard: row.strategyValidity || null,
    mutationCard: row.strategyMutation || null,
    reportSummary: report.summary || null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runPositionReevaluationEvent(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderText(result));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: () => db.initSchema(),
    run: main,
    errorPrefix: '❌ runtime-position-reeval-event 오류:',
  });
}
