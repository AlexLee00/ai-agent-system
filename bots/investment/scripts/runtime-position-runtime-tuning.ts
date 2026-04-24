#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runPositionRuntimeReport } from './runtime-position-runtime-report.ts';

function parseArgs(argv = []) {
  const args = {
    exchange: null,
    json: false,
  };
  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw.startsWith('--exchange=')) args.exchange = raw.split('=').slice(1).join('=') || null;
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

function buildSuggestions(summary = {}) {
  const suggestions = [];
  for (const [exchange, bucket] of Object.entries(summary)) {
    const avgCadenceMs = bucket.cadenceSamples.length > 0
      ? Math.round(bucket.cadenceSamples.reduce((acc, value) => acc + value, 0) / bucket.cadenceSamples.length)
      : null;
    if (bucket.exit > 0 || bucket.criticalValidation > 0) {
      suggestions.push({
        exchange,
        status: 'tighten_runtime_watch',
        recommendedCadenceMs: 10_000,
        reason: `exit ${bucket.exit} / critical validation ${bucket.criticalValidation}`,
        currentAverageCadenceMs: avgCadenceMs,
      });
      continue;
    }
    if (bucket.fastLane === bucket.total && bucket.adjust === 0 && bucket.total > 0) {
      suggestions.push({
        exchange,
        status: 'relax_runtime_watch',
        recommendedCadenceMs: exchange === 'binance' ? 15_000 : 20_000,
        reason: 'all positions already on fast lane without current adjust/exit pressure',
        currentAverageCadenceMs: avgCadenceMs,
      });
      continue;
    }
    suggestions.push({
      exchange,
      status: 'runtime_watch_balanced',
      recommendedCadenceMs: avgCadenceMs,
      reason: 'current runtime cadence is balanced',
      currentAverageCadenceMs: avgCadenceMs,
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
  const summary = summarizeRows(runtimeReport.rows || []);
  const suggestions = buildSuggestions(summary);
  return {
    ok: true,
    status: suggestions.some((item) => item.status !== 'runtime_watch_balanced')
      ? 'position_runtime_tuning_attention'
      : 'position_runtime_tuning_ok',
    runtimeDecision: runtimeReport.decision,
    summary,
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
