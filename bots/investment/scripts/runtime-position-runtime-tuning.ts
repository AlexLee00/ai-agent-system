#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runPositionRuntimeReport } from './runtime-position-runtime-report.ts';
import {
  DEFAULT_POSITION_RUNTIME_AUTOPILOT_HISTORY_FILE,
  readPositionRuntimeAutopilotHistoryLines,
} from './runtime-position-runtime-autopilot-history-store.ts';

function parseArgs(argv = []) {
  const args = {
    exchange: null,
    json: false,
    historyFile: DEFAULT_POSITION_RUNTIME_AUTOPILOT_HISTORY_FILE,
  };
  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw.startsWith('--exchange=')) args.exchange = raw.split('=').slice(1).join('=') || null;
    else if (raw.startsWith('--history-file=')) args.historyFile = raw.split('=').slice(1).join('=') || DEFAULT_POSITION_RUNTIME_AUTOPILOT_HISTORY_FILE;
  }
  return args;
}

function summarizeRows(rows = []) {
  const active = rows.filter((row) => row.runtimeState);
  const byExchange = {};
  for (const row of active) {
    const exchange = row.exchange;
    if (!byExchange[exchange]) {
      byExchange[exchange] = {
        total: 0,
        fastLane: 0,
        adjust: 0,
        exit: 0,
        criticalValidation: 0,
        cadenceSamples: [],
      };
    }
    const bucket = byExchange[exchange];
    bucket.total += 1;
    const cadence = Number(row.runtimeState?.monitoringPolicy?.cadenceMs || 0);
    if (cadence > 0) bucket.cadenceSamples.push(cadence);
    if (cadence > 0 && cadence <= 15_000) bucket.fastLane += 1;
    if (row.runtimeState?.executionIntent?.action === 'ADJUST') bucket.adjust += 1;
    if (row.runtimeState?.executionIntent?.action === 'EXIT') bucket.exit += 1;
    if (row.runtimeState?.validationState?.severity === 'critical') bucket.criticalValidation += 1;
  }
  return byExchange;
}

function buildHistoryPressure(history = [], exchange = null) {
  const relevant = history
    .filter((item) => !exchange || item.exchange === exchange || item.exchange === 'all')
    .slice(-24);
  if (relevant.length === 0) {
    return {
      samples: 0,
      avgActive: 0,
      avgAdjustReady: 0,
      avgExitReady: 0,
      avgFastLane: 0,
      avgStaleValidation: 0,
      avgDispatchExecuted: 0,
      avgSuggestedCadenceMs: null,
    };
  }
  const totals = relevant.reduce((acc, item) => {
    const exchangeSummary = item.exchange === exchange
      ? item.metrics
      : item.exchangeSummary?.[exchange] || null;
    acc.active += Number(exchangeSummary?.active || 0);
    acc.adjustReady += Number(exchangeSummary?.adjustReady || 0);
    acc.exitReady += Number(exchangeSummary?.exitReady || 0);
    acc.fastLane += Number(exchangeSummary?.fastLane || 0);
    acc.staleValidation += Number(exchangeSummary?.staleValidation || 0);
    const dispatchByExchange = item.exchange === exchange
      ? Number(item.dispatchExecutedCount || 0)
      : Number(item.dispatchByExchange?.[exchange]?.executed || 0);
    acc.dispatchExecuted += dispatchByExchange;
    const suggestion = (item.tuningSuggestions || []).find((entry) => entry?.exchange === exchange);
    if (Number.isFinite(Number(suggestion?.recommendedCadenceMs))) {
      acc.suggestedCadenceTotal += Number(suggestion.recommendedCadenceMs);
      acc.suggestedCadenceCount += 1;
    }
    return acc;
  }, {
    active: 0,
    adjustReady: 0,
    exitReady: 0,
    fastLane: 0,
    staleValidation: 0,
    dispatchExecuted: 0,
    suggestedCadenceTotal: 0,
    suggestedCadenceCount: 0,
  });
  return {
    samples: relevant.length,
    avgActive: totals.active / relevant.length,
    avgAdjustReady: totals.adjustReady / relevant.length,
    avgExitReady: totals.exitReady / relevant.length,
    avgFastLane: totals.fastLane / relevant.length,
    avgStaleValidation: totals.staleValidation / relevant.length,
    avgDispatchExecuted: totals.dispatchExecuted / relevant.length,
    avgSuggestedCadenceMs: totals.suggestedCadenceCount > 0
      ? Math.round(totals.suggestedCadenceTotal / totals.suggestedCadenceCount)
      : null,
  };
}

function buildSuggestions(summary = {}, history = []) {
  const suggestions = [];
  for (const [exchange, bucket] of Object.entries(summary)) {
    const historyPressure = buildHistoryPressure(history, exchange);
    const avgCadenceMs = bucket.cadenceSamples.length > 0
      ? Math.round(bucket.cadenceSamples.reduce((acc, value) => acc + value, 0) / bucket.cadenceSamples.length)
      : null;
    const activeBase = Math.max(bucket.total || 0, 1);
    const instantPressure = ((bucket.exit * 2) + bucket.adjust + bucket.criticalValidation) / activeBase;
    const historicalPressure = historyPressure.avgActive > 0
      ? (((historyPressure.avgExitReady * 2) + historyPressure.avgAdjustReady + historyPressure.avgStaleValidation) / Math.max(historyPressure.avgActive, 1))
      : 0;
    const pressureScore = Number((instantPressure * 0.6 + historicalPressure * 0.4).toFixed(3));
    const baseTightCadence = exchange === 'binance' ? 10_000 : 15_000;
    const baseBalancedCadence = exchange === 'binance' ? 12_000 : 20_000;
    const baseRelaxedCadence = exchange === 'binance' ? 15_000 : 25_000;
    if (bucket.exit > 0 || bucket.criticalValidation > 0 || pressureScore >= 0.55) {
      suggestions.push({
        exchange,
        status: 'tighten_runtime_watch',
        recommendedCadenceMs: baseTightCadence,
        pressureScore,
        reason: `exit ${bucket.exit} / critical validation ${bucket.criticalValidation} / pressure ${pressureScore}`,
        currentAverageCadenceMs: avgCadenceMs,
        historyPressure,
      });
      continue;
    }
    if (pressureScore >= 0.25 || historyPressure.avgDispatchExecuted > 0.2) {
      suggestions.push({
        exchange,
        status: 'tighten_runtime_watch',
        recommendedCadenceMs: baseBalancedCadence,
        pressureScore,
        reason: `adjust ${bucket.adjust} / recent dispatch ${historyPressure.avgDispatchExecuted.toFixed(2)} / pressure ${pressureScore}`,
        currentAverageCadenceMs: avgCadenceMs,
        historyPressure,
      });
      continue;
    }
    if (bucket.fastLane === bucket.total && bucket.adjust === 0 && bucket.total > 0 && pressureScore < 0.1) {
      suggestions.push({
        exchange,
        status: 'relax_runtime_watch',
        recommendedCadenceMs: historyPressure.avgSuggestedCadenceMs || baseRelaxedCadence,
        pressureScore,
        reason: `all positions already on fast lane without current adjust/exit pressure / pressure ${pressureScore}`,
        currentAverageCadenceMs: avgCadenceMs,
        historyPressure,
      });
      continue;
    }
    suggestions.push({
      exchange,
      status: 'runtime_watch_balanced',
      recommendedCadenceMs: historyPressure.avgSuggestedCadenceMs || avgCadenceMs,
      pressureScore,
      reason: `current runtime cadence is balanced / pressure ${pressureScore}`,
      currentAverageCadenceMs: avgCadenceMs,
      historyPressure,
    });
  }
  return suggestions;
}

function renderText(result = {}) {
  const lines = [
    '🎛️ Position Runtime Tuning',
    `status: ${result.status || 'unknown'}`,
  ];
  for (const item of result.suggestions || []) {
    lines.push(`- ${item.exchange} | ${item.status} | cadence ${item.currentAverageCadenceMs || 'n/a'} -> ${item.recommendedCadenceMs || 'n/a'} | ${item.reason}`);
  }
  return lines.join('\n');
}

export async function runPositionRuntimeTuning(args = {}) {
  const runtimeReport = await runPositionRuntimeReport({
    exchange: args.exchange || null,
    limit: 200,
    json: true,
  });
  const history = readPositionRuntimeAutopilotHistoryLines(args.historyFile || DEFAULT_POSITION_RUNTIME_AUTOPILOT_HISTORY_FILE);
  const summary = summarizeRows(runtimeReport.rows || []);
  const suggestions = buildSuggestions(summary, history);
  return {
    ok: true,
    status: suggestions.some((item) => item.status !== 'runtime_watch_balanced')
      ? 'position_runtime_tuning_attention'
      : 'position_runtime_tuning_ok',
    runtimeDecision: runtimeReport.decision,
    summary,
    historyFile: args.historyFile || DEFAULT_POSITION_RUNTIME_AUTOPILOT_HISTORY_FILE,
    historySamples: history.length,
    suggestions,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runPositionRuntimeTuning(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderText(result));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: () => db.initSchema(),
    run: main,
    errorPrefix: '❌ runtime-position-runtime-tuning 오류:',
  });
}
