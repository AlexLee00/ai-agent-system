#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs';
import path from 'node:path';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { investmentOpsRuntimeFile } from '../shared/runtime-ops-path.ts';
import * as db from '../shared/db.ts';
import {
  buildLunaDecisionFilterReport,
  buildNearMissWatchCandidate,
} from './runtime-luna-decision-filter-report.ts';

const CONFIRM = 'luna-near-miss-watchlist';
const DEFAULT_MARKET = 'crypto';

export function defaultNearMissWatchlistOutputPath(market = DEFAULT_MARKET) {
  const normalized = String(market || DEFAULT_MARKET).toLowerCase();
  return investmentOpsRuntimeFile(`luna-near-miss-watchlist-${normalized}.json`);
}

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

function normalizeSymbol(symbol = '') {
  const raw = String(symbol || '').trim().toUpperCase();
  if (!raw) return raw;
  if (!raw.includes('/') && raw.endsWith('USDT')) return `${raw.slice(0, -4)}/USDT`;
  return raw;
}

async function loadOpenPositionSymbols(exchange = 'binance', injected = null) {
  if (Array.isArray(injected)) return new Set(injected.map(normalizeSymbol).filter(Boolean));
  try {
    const positions = await db.getAllPositions(exchange, false);
    return new Set((positions || []).map((row) => normalizeSymbol(row?.symbol)).filter(Boolean));
  } catch {
    return new Set();
  }
}

async function attachCryptoDailyTechnical(report = {}, { market, exchange, dailyTechnicalCoverageBuilder = null } = {}) {
  if (market !== 'crypto' || exchange !== 'binance' || !Array.isArray(report?.top) || report.top.length === 0) {
    return report;
  }
  try {
    const buildDailyTechnicalCoverage = dailyTechnicalCoverageBuilder
      || (await import('./runtime-luna-discovery-funnel-report.ts')).buildDailyTechnicalCoverage;
    const symbols = report.top.map((item) => item.symbol).filter(Boolean);
    const coverage = await buildDailyTechnicalCoverage({
      market,
      exchange,
      symbols,
      marketOpen: true,
    });
    const bySymbol = new Map((coverage?.rows || []).map((row) => [normalizeSymbol(row?.symbol), row]));
    return {
      ...report,
      dailyTechnicalCoverage: coverage,
      top: report.top.map((item) => {
        const row = bySymbol.get(normalizeSymbol(item?.symbol));
        return row ? { ...item, dailyTechnical: row } : item;
      }),
    };
  } catch (error) {
    return {
      ...report,
      dailyTechnicalCoverage: {
        enabled: true,
        sourcePolicy: 'tradingview',
        checkedCount: 0,
        availableCount: 0,
        bullishCount: 0,
        rows: [],
        error: error?.message || String(error),
      },
    };
  }
}

export async function buildLunaNearMissWatchlist({
  market = 'crypto',
  exchange = null,
  hours = 24,
  limit = 20,
  reportBuilder = buildLunaDecisionFilterReport,
  dailyTechnicalCoverageBuilder = null,
  openPositionSymbols = null,
} = {}) {
  const resolvedExchange = exchange || (market === 'domestic' ? 'kis' : market === 'overseas' ? 'kis_overseas' : 'binance');
  const report = await reportBuilder({
    market,
    exchange: resolvedExchange,
    activeCandidates: true,
    hours,
    limit,
  });
  const enrichedReport = await attachCryptoDailyTechnical(report, {
    market,
    exchange: resolvedExchange,
    dailyTechnicalCoverageBuilder,
  });
  const watchlist = Array.isArray(enrichedReport?.nearMissWatchlist) && enrichedReport.nearMissWatchlist.length > 0
    ? enrichedReport.nearMissWatchlist
    : (enrichedReport?.top || []).map(buildNearMissWatchCandidate).filter(Boolean);
  const openSymbols = await loadOpenPositionSymbols(resolvedExchange, openPositionSymbols);
  const entryWatchlist = watchlist.filter((item) => !openSymbols.has(normalizeSymbol(item?.symbol)));
  const excludedOpenPositionSymbols = watchlist
    .filter((item) => openSymbols.has(normalizeSymbol(item?.symbol)))
    .map((item) => normalizeSymbol(item?.symbol));
  return {
    ok: true,
    status: entryWatchlist.length > 0 ? 'near_miss_watchlist_attention' : 'near_miss_watchlist_clear',
    generatedAt: new Date().toISOString(),
    market,
    exchange: resolvedExchange,
    hours,
    limit,
    dryRun: true,
    applied: false,
    summary: summarizeWatchlist(entryWatchlist),
    watchlist: entryWatchlist,
    evidence: {
      decisionFilterStatus: report?.status || null,
      activeCandidateCoverage: report?.activeCandidateCoverage || null,
      excludedOpenPositionSymbols,
      dailyTechnicalCoverage: enrichedReport?.dailyTechnicalCoverage
        ? {
            checkedCount: enrichedReport.dailyTechnicalCoverage.checkedCount,
            availableCount: enrichedReport.dailyTechnicalCoverage.availableCount,
            bullishCount: enrichedReport.dailyTechnicalCoverage.bullishCount,
            error: enrichedReport.dailyTechnicalCoverage.error || null,
          }
        : null,
      likelyActionableCount: Number(report?.likelyActionableCount || 0),
      filteredCount: Number(report?.filteredCount || 0),
      reasonCounts: report?.reasonCounts || {},
      bottlenecks: report?.bottlenecks || [],
    },
    nextAction: entryWatchlist.length > 0
      ? 'monitor_near_miss_candidates_until_missing_confirmations_clear'
      : 'continue_regular_candidate_discovery',
  };
}

export async function runLunaNearMissWatchlist({
  apply = false,
  confirm = null,
  outputPath = null,
  ...options
} = {}) {
  const resolvedOutputPath = outputPath || defaultNearMissWatchlistOutputPath(options.market || DEFAULT_MARKET);
  const payload = await buildLunaNearMissWatchlist(options);
  if (!apply) {
    return {
      ...payload,
      outputPath: resolvedOutputPath,
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
      outputPath: resolvedOutputPath,
      confirmRequired: CONFIRM,
    };
  }
  writeJson(resolvedOutputPath, {
    ...payload,
    dryRun: false,
    applied: true,
    outputPath: resolvedOutputPath,
  });
  return {
    ...payload,
    dryRun: false,
    applied: true,
    outputPath: resolvedOutputPath,
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
    outputPath: argValue('output', null, argv),
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
