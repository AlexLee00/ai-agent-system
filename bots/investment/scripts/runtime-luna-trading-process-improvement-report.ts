#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { close } from '../shared/db/core.ts';
import { buildTradeDataAnalysisReport } from '../shared/trade-data-analysis-report.ts';
import { buildLunaTradingProcessImprovementReport } from '../shared/luna-trading-process-improvement.ts';
import { runOptimalExitAnalysis } from './runtime-luna-optimal-exit-analysis.ts';
import { runReport as runSymbolExitTimingStrategyReport } from './runtime-luna-symbol-exit-timing-strategy-report.ts';
import { buildStrategyFeedbackOutcomes } from './runtime-strategy-feedback-outcomes.ts';
import { buildPosttradeFeedbackActionStaging } from './runtime-posttrade-feedback-action-staging.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INVESTMENT_DIR = path.resolve(__dirname, '..');
const DEFAULT_OUTPUT = path.join(INVESTMENT_DIR, 'output', 'reports', 'luna-trading-process-improvement-report.json');
const DEFAULT_OPTIMAL_EXIT_REPORT = 'output/reports/luna-optimal-exit-analysis-report.json';
const DEFAULT_SYMBOL_EXIT_REPORT = 'output/reports/luna-symbol-exit-timing-strategy-report.json';

function parseArgs(argv = process.argv.slice(2)) {
  const limit = Number(argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1] || '5000');
  const optimalLimit = Number(argv.find((arg) => arg.startsWith('--optimal-limit='))?.split('=')[1] || '5000');
  const concurrency = Number(argv.find((arg) => arg.startsWith('--concurrency='))?.split('=')[1] || '5');
  const feedbackDays = Number(argv.find((arg) => arg.startsWith('--feedback-days='))?.split('=')[1] || '90');
  return {
    json: argv.includes('--json'),
    smoke: argv.includes('--smoke'),
    noWrite: argv.includes('--no-write'),
    refreshOptimalExit: argv.includes('--refresh-optimal-exit'),
    skipOptimalExit: argv.includes('--skip-optimal-exit'),
    refreshSymbolExit: argv.includes('--refresh-symbol-exit'),
    skipSymbolExit: argv.includes('--skip-symbol-exit'),
    skipFeedback: argv.includes('--skip-feedback'),
    output: argv.find((arg) => arg.startsWith('--output='))?.split('=').slice(1).join('=') || DEFAULT_OUTPUT,
    optimalExitReport: argv.find((arg) => arg.startsWith('--optimal-exit-report='))?.split('=').slice(1).join('=') || DEFAULT_OPTIMAL_EXIT_REPORT,
    symbolExitReport: argv.find((arg) => arg.startsWith('--symbol-exit-report='))?.split('=').slice(1).join('=') || DEFAULT_SYMBOL_EXIT_REPORT,
    limit: Number.isFinite(limit) && limit > 0 ? limit : 5000,
    optimalLimit: Number.isFinite(optimalLimit) && optimalLimit > 0 ? optimalLimit : 5000,
    concurrency: Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 5,
    feedbackDays: Number.isFinite(feedbackDays) && feedbackDays > 0 ? feedbackDays : 90,
  };
}

function readJsonIfExists(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return null;
  return { ...JSON.parse(fs.readFileSync(resolved, 'utf8')), source: `existing_report:${resolved}` };
}

async function withoutChildStdout(fn) {
  const originalLog = console.log;
  console.log = (...args) => {
    if (process.env.LUNA_TRADING_PROCESS_IMPROVEMENT_VERBOSE === 'true') {
      originalLog(...args);
    }
  };
  try {
    return await fn();
  } finally {
    console.log = originalLog;
  }
}

function loadExistingOptimalExitReport(candidate = DEFAULT_OPTIMAL_EXIT_REPORT) {
  return readJsonIfExists(candidate)
    || readJsonIfExists(path.resolve('bots/investment', candidate))
    || { ok: false, status: 'optimal_exit_report_missing', source: 'missing_existing_report' };
}

function loadExistingSymbolExitReport(candidate = DEFAULT_SYMBOL_EXIT_REPORT) {
  return readJsonIfExists(candidate)
    || readJsonIfExists(path.resolve('bots/investment', candidate))
    || { ok: false, status: 'symbol_exit_report_missing', source: 'missing_existing_report' };
}

function buildSmokeInputs() {
  const tradeData = {
    ok: true,
    status: 'ready',
    source: 'smoke_fixture',
    signals: {
      total: 100,
      executionRate: 0.58,
      policyAdjustedExecutionRate: 0.94,
      policyBlockedSignals: 38,
      executionCandidateSignals: 62,
      blockedReasons: [
        { reason: 'capital_guard_rejected', count: 12 },
        { reason: 'sec015_overseas_stale_approval', count: 10 },
        { reason: 'live_position_reentry_blocked', count: 4 },
      ],
    },
    trades: {
      realizedPnlCoverage: { sellCount: 12, realizedCount: 12, coverage: 1 },
    },
    posttrade: {
      qualityCoverage: { closedJournalTrades: 27, evaluatedClosedJournalTrades: 27, coverage: 1 },
    },
    hygiene: {
      status: 'ready',
      findings: [],
      openJournal: { status: 'ready', summary: { totalOpenEntries: 2, staleNoPositionScopes: 0, duplicateScopes: 0 } },
      realizedPnlCoverage: { sellCount: 12, realizedCount: 12, coverage: 1 },
      qualityCoverage: { closedJournalTrades: 27, evaluatedClosedJournalTrades: 27, coverage: 1 },
    },
    journal: {
      summary: { total: 29, closed: 27, open: 2 },
      tpSl: { set: { avgPnlPercent: -1.4341, winRate: 0.2963 } },
      strategyFamily: {
        coverage: 1,
        buckets: [
          { name: 'promotion_ready_shadow', closed: 3, avgPnlPercent: -5.1238, winRate: 0 },
          { name: 'mean_reversion', closed: 5, avgPnlPercent: -2.6532, winRate: 0.2 },
          { name: 'short_term_scalping', closed: 11, avgPnlPercent: -0.5665, winRate: 0.4545 },
        ],
      },
      earlyExit: {
        underOneHour: true,
        total: 13,
        losses: 7,
        samples: [
          { symbol: 'KITE/USDT', holdMinutes: 0.01, pnlPercent: -5.3712, strategyFamily: 'short_term_scalping' },
        ],
      },
    },
  };
  const optimalExit = {
    ok: true,
    status: 'ready',
    source: 'smoke_fixture',
    scope: { analyzedTrades: 704, learningEligibleTrades: 320 },
    learningEligibleSummary: {
      total: 320,
      actualAvgPnlPct: -1.4743,
      winRate: 0.2381,
      missedDuringHoldAvgPct: 4.6877,
      missedToNowAvgPct: 32.3552,
      timingCategories: {
        late_exit_after_peak: 68,
        early_loss_exit_recovered_later: 79,
        near_optimal_within_hold: 83,
      },
      optimalReasonTags: {
        next5d_drawdown_over_5pct: 297,
        sma20_extension_6pct: 276,
        local_7d_peak: 264,
        upper_bollinger_band: 250,
        rsi_overbought: 176,
        volume_spike: 121,
        macd_cooling: 48,
      },
    },
  };
  const symbolExit = {
    ok: true,
    status: 'sell_timing_strategy_required',
    source: 'smoke_fixture',
    scope: {
      analyzedTrades: 320,
      symbols: 3,
      p0Symbols: 1,
      p1Symbols: 1,
    },
    symbolList: [
      {
        symbolKey: 'crypto:PEAK/USDT',
        priority: 'P0',
        recommendedExitPolicy: 'peak_reversal_partial_trailing',
        policyMissedDuringHoldAvgPct: 12.3,
      },
      {
        symbolKey: 'crypto:RECOVER/USDT',
        priority: 'P1',
        recommendedExitPolicy: 'loss_exit_recheck_before_sell',
        policyCurrentFromExitAvgPct: 9.4,
      },
    ],
    topLateExitAfterPeak: [
      {
        symbolKey: 'crypto:PEAK/USDT',
        priority: 'P0',
        recommendedExitPolicy: 'peak_reversal_partial_trailing',
        policyMissedDuringHoldAvgPct: 12.3,
      },
    ],
    topSoldTooEarlyVsCurrentClose: [
      {
        symbolKey: 'crypto:RECOVER/USDT',
        policyCurrentFromExitAvgPct: 9.4,
      },
    ],
    strategyActions: [
      {
        id: 'symbol_exit_policy_matrix',
        priority: 'P0',
        evidence: {
          byPolicy: {
            peak_reversal_partial_trailing: 1,
            loss_exit_recheck_before_sell: 1,
          },
          p0Symbols: ['crypto:PEAK/USDT'],
        },
        action: 'Feed recommendedExitPolicy into exit patience, partial-profit, trailing-stop, and recheck gates by symbol.',
      },
      {
        id: 'current_close_post_exit_label',
        priority: 'P1',
        evidence: {
          soldTooEarlySymbols: [{ symbolKey: 'crypto:RECOVER/USDT', currentFromExitAvgPct: 9.4 }],
        },
        action: 'Train post-exit drift labels.',
      },
      {
        id: 'peak_tag_exit_trigger',
        priority: 'P1',
        evidence: {
          commonTags: [{ key: 'rsi_overbought', count: 2 }],
        },
        action: 'Use peak tags as partial-exit triggers.',
      },
    ],
  };
  const strategyFeedback = {
    source: 'smoke_fixture',
    decision: {
      status: 'strategy_feedback_outcome_attention',
      metrics: {
        total: 8,
        closed: 5,
        weak: { familyBias: 'downweight', family: 'promotion_ready_shadow', avgPnlPercent: -5.1 },
      },
    },
  };
  const posttrade = {
    source: 'smoke_fixture',
    status: 'posttrade_feedback_action_staged',
    actionStaging: {
      requiresApproval: true,
      patchCount: 1,
      rejectedCount: 0,
    },
  };
  return { tradeData, optimalExit, symbolExit, strategyFeedback, posttrade };
}

async function loadOptimalExit(args) {
  if (args.skipOptimalExit) return { ok: false, status: 'optimal_exit_skipped', source: 'skipped_by_arg' };
  if (!args.refreshOptimalExit) return loadExistingOptimalExitReport(args.optimalExitReport);
  return withoutChildStdout(() => runOptimalExitAnalysis({
    json: true,
    smoke: false,
    noWrite: true,
    output: null,
    limit: args.optimalLimit,
    concurrency: args.concurrency,
  }));
}

async function loadSymbolExit(args) {
  if (args.skipSymbolExit) return { ok: false, status: 'symbol_exit_skipped', source: 'skipped_by_arg' };
  if (!args.refreshSymbolExit) return loadExistingSymbolExitReport(args.symbolExitReport);
  return withoutChildStdout(() => runSymbolExitTimingStrategyReport({
    json: true,
    smoke: false,
    noWrite: true,
    limit: args.optimalLimit,
    concurrency: args.concurrency,
  }));
}

async function loadStrategyFeedback(args) {
  if (args.skipFeedback) return { ok: false, status: 'strategy_feedback_skipped', source: 'skipped_by_arg' };
  try {
    const report = await withoutChildStdout(() => buildStrategyFeedbackOutcomes({ days: args.feedbackDays, json: true }));
    return { ...report, source: 'db' };
  } catch (error) {
    return { ok: false, status: 'strategy_feedback_load_failed', source: 'db_error', error: error?.message || String(error) };
  }
}

async function loadPosttradeActionStaging(args) {
  if (args.skipFeedback) return { ok: false, status: 'posttrade_action_staging_skipped', source: 'skipped_by_arg' };
  try {
    const actionStaging = await withoutChildStdout(() => buildPosttradeFeedbackActionStaging({ days: args.feedbackDays, limit: 50, write: false }));
    return {
      ok: true,
      status: actionStaging.status,
      source: 'db',
      actionStaging,
    };
  } catch (error) {
    return { ok: false, status: 'posttrade_action_staging_load_failed', source: 'db_error', error: error?.message || String(error) };
  }
}

export async function runTradingProcessImprovementReport(args = parseArgs()) {
  const inputs = args.smoke
    ? buildSmokeInputs()
    : {
      tradeData: { ...(await buildTradeDataAnalysisReport({ limit: args.limit })), source: 'db' },
      optimalExit: await loadOptimalExit(args),
      symbolExit: await loadSymbolExit(args),
      strategyFeedback: await loadStrategyFeedback(args),
      posttrade: await loadPosttradeActionStaging(args),
    };
  const report = buildLunaTradingProcessImprovementReport({
    ...inputs,
    generatedAt: new Date().toISOString(),
  });
  if (!args.noWrite) {
    fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
    fs.writeFileSync(path.resolve(args.output), JSON.stringify(report, null, 2));
  }
  return { ...report, output: args.noWrite ? null : path.resolve(args.output) };
}

async function main() {
  const args = parseArgs();
  try {
    const report = await runTradingProcessImprovementReport(args);
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else console.log(`runtime-luna-trading-process-improvement-report status=${report.status} roadmap=${report.roadmap.length}`);
  } finally {
    await Promise.resolve(close()).catch(() => {});
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'runtime-luna-trading-process-improvement-report error:' });
}
