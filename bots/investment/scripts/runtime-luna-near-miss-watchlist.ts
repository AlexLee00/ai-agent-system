#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs';
import path from 'node:path';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { investmentOpsRuntimeFile } from '../shared/runtime-ops-path.ts';
import { buildLunaDecisionFilterReport } from './runtime-luna-decision-filter-report.ts';

const CONFIRM = 'luna-near-miss-watchlist';
const DEFAULT_OUTPUT_PATH = investmentOpsRuntimeFile('luna-near-miss-watchlist.json');

function hasArg(name, argv = process.argv.slice(2)) {
  return argv.includes(`--${name}`);
}

function argValue(name, fallback = null, argv = process.argv.slice(2)) {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function summarizeWatchlist(watchlist = []) {
  const byReason = {};
  const byMissingConfirmation = {};
  for (const item of watchlist || []) {
    const reason = item?.watchReason || 'unknown';
    byReason[reason] = (byReason[reason] || 0) + 1;
    for (const missing of item?.missingConfirmations || []) {
      byMissingConfirmation[missing] = (byMissingConfirmation[missing] || 0) + 1;
    }
  }
  return {
    count: watchlist.length,
    byReason,
    byMissingConfirmation,
    symbols: watchlist.map((item) => item.symbol).filter(Boolean),
  };
}

export async function buildLunaNearMissWatchlist({
  market = 'crypto',
  exchange = null,
  hours = 24,
  limit = 20,
  reportBuilder = buildLunaDecisionFilterReport,
} = {}) {
  const resolvedExchange = exchange || (market === 'domestic' ? 'kis' : market === 'overseas' ? 'kis_overseas' : 'binance');
  const report = await reportBuilder({
    market,
    exchange: resolvedExchange,
    activeCandidates: true,
    hours,
    limit,
  });
  const watchlist = Array.isArray(report?.nearMissWatchlist) ? report.nearMissWatchlist : [];
  return {
    ok: true,
    status: watchlist.length > 0 ? 'near_miss_watchlist_attention' : 'near_miss_watchlist_clear',
    generatedAt: new Date().toISOString(),
    market,
    exchange: resolvedExchange,
    hours,
    limit,
    dryRun: true,
    applied: false,
    summary: summarizeWatchlist(watchlist),
    watchlist,
    evidence: {
      decisionFilterStatus: report?.status || null,
      activeCandidateCoverage: report?.activeCandidateCoverage || null,
      likelyActionableCount: Number(report?.likelyActionableCount || 0),
      filteredCount: Number(report?.filteredCount || 0),
      reasonCounts: report?.reasonCounts || {},
      bottlenecks: report?.bottlenecks || [],
    },
    nextAction: watchlist.length > 0
      ? 'monitor_near_miss_candidates_until_missing_confirmations_clear'
      : 'continue_regular_candidate_discovery',
  };
}

export async function runLunaNearMissWatchlist({
  apply = false,
  confirm = null,
  outputPath = DEFAULT_OUTPUT_PATH,
  ...options
} = {}) {
  const payload = await buildLunaNearMissWatchlist(options);
  if (!apply) {
    return {
      ...payload,
      outputPath,
      applyCommand: `node scripts/runtime-luna-near-miss-watchlist.ts --apply --confirm=${CONFIRM} --json`,
    };
  }
  if (confirm !== CONFIRM) {
    return {
      ...payload,
      ok: false,
      status: 'near_miss_watchlist_confirm_required',
      dryRun: false,
      applied: false,
      outputPath,
      confirmRequired: CONFIRM,
    };
  }
  writeJson(outputPath, {
    ...payload,
    dryRun: false,
    applied: true,
    outputPath,
  });
  return {
    ...payload,
    dryRun: false,
    applied: true,
    outputPath,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const result = await runLunaNearMissWatchlist({
    apply: hasArg('apply', argv),
    confirm: argValue('confirm', null, argv),
    market: argValue('market', 'crypto', argv),
    exchange: argValue('exchange', null, argv),
    hours: Math.max(1, Number(argValue('hours', 24, argv)) || 24),
    limit: Math.max(1, Number(argValue('limit', 20, argv)) || 20),
    outputPath: argValue('output', DEFAULT_OUTPUT_PATH, argv),
  });
  if (hasArg('json', argv)) console.log(JSON.stringify(result, null, 2));
  else console.log(`runtime-luna-near-miss-watchlist ${result.status}`);
  if (!result.ok) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-luna-near-miss-watchlist 실패:',
  });
}
