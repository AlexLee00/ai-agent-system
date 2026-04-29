#!/usr/bin/env node
// @ts-nocheck
/**
 * scripts/daily-trade-feedback.ts — 루나팀 일일 피드백 루프
 *
 * 기능:
 *   - 당일 종료 거래 조회
 *   - 간단한 LLM 일일 회고 생성
 *   - 분석팀 정확도 요약
 *   - RAG 저장 (best-effort)
 *   - 텔레그램 간략 리포트 (best-effort)
 *
 * 실행:
 *   node scripts/daily-trade-feedback.ts
 *   node scripts/daily-trade-feedback.ts --date=2026-04-11
 *   node scripts/daily-trade-feedback.ts --dry-run
 *   node scripts/daily-trade-feedback.ts --json
 */

import { createRequire } from 'module';
import fs from 'node:fs';
import { callLLM, parseJSON } from '../shared/llm-client.ts';
import { publishAlert } from '../shared/alert-publisher.ts';
import * as db from '../shared/db.ts';
import * as rag from '../shared/rag-client.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { getInvestmentRagRuntimeConfig } from '../shared/runtime-config.ts';
import { buildScreeningHistoryReport } from './screening-history-report.ts';
import { buildPositionReevaluationSummary } from './position-reevaluation-summary.ts';
import { buildRuntimeMinOrderPressureReport } from './runtime-min-order-pressure-report.ts';
import { buildRuntimeLearningLoopReport } from './runtime-learning-loop-report.ts';
import { buildRuntimePositionStrategyAudit } from './runtime-position-strategy-audit.ts';
import { runPositionRuntimeReport } from './runtime-position-runtime-report.ts';
import { runPositionRuntimeTuning } from './runtime-position-runtime-tuning.ts';
import { runPositionRuntimeDispatch } from './runtime-position-runtime-dispatch.ts';
import { buildPositionStrategyHygieneRemediationPlan, runPositionStrategyHygiene } from './runtime-position-strategy-hygiene.ts';
import {
  buildPositionStrategyRemediationRefreshState,
  runPositionStrategyRemediation,
} from './runtime-position-strategy-remediation.ts';
const require = createRequire(import.meta.url);
const LATEST_OPS_SNAPSHOT_FILE = '/Users/alexlee/projects/ai-agent-system/bots/investment/output/ops/parallel-ops-snapshot.json';
const RAG_RUNTIME = getInvestmentRagRuntimeConfig();
let dailyFeedbackMemory = {
  recallCountHint: async () => '',
  recallHint: async () => '',
  remember: async () => {},
  consolidate: async () => {},
};
try {
  const { createAgentMemory } = require('../../../packages/core/lib/agent-memory.js');
  dailyFeedbackMemory = createAgentMemory({ agentId: 'investment.daily-feedback', team: 'investment' });
} catch (error) {
  console.warn(`  ⚠️ [daily-feedback] agent-memory 로드 실패(무시): ${error?.message || error}`);
}

function parseArg(name, fallback = null) {
  return process.argv.slice(2).find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1] || fallback;
}

function loadLatestOpsSnapshot() {
  try {
    if (!fs.existsSync(LATEST_OPS_SNAPSHOT_FILE)) return null;
    return JSON.parse(fs.readFileSync(LATEST_OPS_SNAPSHOT_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function getWeakestRegimeSummary(runtimeLearningLoop) {
  const weakest = runtimeLearningLoop?.sections?.regimeLaneSummary?.weakestRegime
    || runtimeLearningLoop?.sections?.collect?.regimePerformance?.weakestRegime
    || null;
  const weakestMode = weakest?.tradeMode || weakest?.worstMode?.tradeMode || weakest?.bestMode?.tradeMode || 'n/a';
  return { weakest, weakestMode };
}

function buildDailyFeedbackRemediationView(positionStrategyRemediationSummary, positionStrategyRemediationHistorySummary) {
  const remediationFlat = positionStrategyRemediationSummary?.remediationFlat || null;
  const remediationSummary = positionStrategyRemediationSummary?.remediationSummary || null;
  const remediationCounts = positionStrategyRemediationSummary?.remediationCounts || remediationFlat?.counts || remediationSummary?.counts || {};
  const remediationCommandsBase = positionStrategyRemediationSummary?.remediationCommands || remediationFlat?.commands || remediationSummary?.commands || null;
  const remediationRefreshStateBase = {
    needed: positionStrategyRemediationSummary?.remediationRefreshNeeded,
    stale: positionStrategyRemediationSummary?.remediationRefreshStale,
    reason: positionStrategyRemediationSummary?.remediationRefreshReason,
    command: positionStrategyRemediationSummary?.remediationRefreshCommand,
  };
  const remediationRefreshState = remediationRefreshStateBase.reason !== undefined || remediationRefreshStateBase.command !== undefined
    ? remediationRefreshStateBase
    : remediationFlat?.refresh
    || remediationSummary?.refreshState
    || buildPositionStrategyRemediationRefreshState(
      positionStrategyRemediationSummary?.remediationPlan || null,
      positionStrategyRemediationHistorySummary,
    );
  const remediationTrend = positionStrategyRemediationSummary?.remediationTrend
    || remediationFlat?.trend
    || remediationSummary?.trend
    || null;
  const remediationActionReportCommand = positionStrategyRemediationSummary?.remediationActionReportCommand || remediationFlat?.actionReportCommand || remediationCommandsBase?.report || remediationSummary?.actions?.reportCommand || null;
  const remediationActionHistoryCommand = positionStrategyRemediationSummary?.remediationActionHistoryCommand || remediationFlat?.actionHistoryCommand || remediationCommandsBase?.history || remediationSummary?.actions?.historyCommand || null;
  const remediationActionRefreshCommand = positionStrategyRemediationSummary?.remediationActionRefreshCommand || remediationFlat?.actionRefreshCommand || remediationFlat?.refreshCommand || remediationCommandsBase?.refresh || remediationSummary?.actions?.refreshCommand || null;
  const remediationActionHygieneCommand = positionStrategyRemediationSummary?.remediationActionHygieneCommand || remediationFlat?.actionHygieneCommand || remediationCommandsBase?.hygiene || remediationSummary?.actions?.hygieneCommand || null;
  const remediationActionNormalizeDryRunCommand = positionStrategyRemediationSummary?.remediationActionNormalizeDryRunCommand || remediationFlat?.actionNormalizeDryRunCommand || remediationCommandsBase?.normalizeDryRun || remediationSummary?.actions?.normalizeDryRunCommand || null;
  const remediationActionNormalizeApplyCommand = positionStrategyRemediationSummary?.remediationActionNormalizeApplyCommand || remediationFlat?.actionNormalizeApplyCommand || remediationCommandsBase?.normalizeApply || remediationSummary?.actions?.normalizeApplyCommand || null;
  const remediationActionRetireDryRunCommand = positionStrategyRemediationSummary?.remediationActionRetireDryRunCommand || remediationFlat?.actionRetireDryRunCommand || remediationCommandsBase?.retireDryRun || remediationSummary?.actions?.retireDryRunCommand || null;
  const remediationActionRetireApplyCommand = positionStrategyRemediationSummary?.remediationActionRetireApplyCommand || remediationFlat?.actionRetireApplyCommand || remediationCommandsBase?.retireApply || remediationSummary?.actions?.retireApplyCommand || null;
  const remediationNextCommandTransition = positionStrategyRemediationSummary?.remediationNextCommandTransition
    || remediationFlat?.nextCommandTransition
    || remediationSummary?.nextCommandTransition
    || remediationTrend?.nextCommandTransition
    || positionStrategyRemediationHistorySummary?.nextCommandTransition
    || {};
  const remediationRefreshCommand = positionStrategyRemediationSummary?.remediationRefreshCommand || remediationFlat?.refreshCommand || remediationCommandsBase?.refresh || remediationRefreshState?.command || null;
  const remediationCommands = {
    report: remediationActionReportCommand || null,
    history: remediationActionHistoryCommand || null,
    refresh: remediationRefreshCommand || remediationActionRefreshCommand || null,
    hygiene: remediationActionHygieneCommand || null,
    normalizeDryRun: remediationActionNormalizeDryRunCommand || null,
    normalizeApply: remediationActionNormalizeApplyCommand || null,
    retireDryRun: remediationActionRetireDryRunCommand || null,
    retireApply: remediationActionRetireApplyCommand || null,
  };
  const remediationActions = {
    reportCommand: remediationActionReportCommand || null,
    historyCommand: remediationActionHistoryCommand || null,
    refreshCommand: remediationActionRefreshCommand || remediationRefreshCommand || null,
    hygieneCommand: remediationActionHygieneCommand || null,
    normalizeDryRunCommand: remediationActionNormalizeDryRunCommand || null,
    normalizeApplyCommand: remediationActionNormalizeApplyCommand || null,
    retireDryRunCommand: remediationActionRetireDryRunCommand || null,
    retireApplyCommand: remediationActionRetireApplyCommand || null,
  };
  return {
    remediationFlat,
    remediationSummary,
    remediationCounts,
    remediationTrend,
    remediationRefreshState,
    remediationStatus: positionStrategyRemediationSummary?.remediationStatus || remediationFlat?.status || remediationSummary?.status || null,
    remediationHeadline: positionStrategyRemediationSummary?.remediationHeadline || remediationFlat?.headline || remediationSummary?.headline || null,
    remediationRecommendedExchange: positionStrategyRemediationSummary?.remediationRecommendedExchange || remediationFlat?.recommendedExchange || remediationSummary?.recommendedExchange || null,
    remediationDuplicateManaged: positionStrategyRemediationSummary?.remediationDuplicateManaged ?? remediationFlat?.duplicateManaged ?? remediationCounts?.duplicateManaged ?? null,
    remediationOrphanProfiles: positionStrategyRemediationSummary?.remediationOrphanProfiles ?? remediationFlat?.orphanProfiles ?? remediationCounts?.orphanProfiles ?? null,
    remediationUnmatchedManaged: positionStrategyRemediationSummary?.remediationUnmatchedManaged ?? remediationFlat?.unmatchedManaged ?? remediationCounts?.unmatchedManaged ?? null,
    remediationNextCommand: positionStrategyRemediationSummary?.remediationNextCommand || remediationFlat?.nextCommand || null,
    remediationNextCommandTransition,
    remediationNextCommandChanged: positionStrategyRemediationSummary?.remediationNextCommandChanged ?? remediationFlat?.nextCommandChanged ?? remediationTrend?.nextCommandChanged ?? null,
    remediationNextCommandPrevious: positionStrategyRemediationSummary?.remediationNextCommandPrevious || remediationFlat?.nextCommandPrevious || remediationNextCommandTransition?.previous || null,
    remediationNextCommandCurrent: positionStrategyRemediationSummary?.remediationNextCommandCurrent || remediationFlat?.nextCommandCurrent || remediationNextCommandTransition?.current || null,
    remediationTrendHistoryCount: positionStrategyRemediationSummary?.remediationTrendHistoryCount ?? remediationFlat?.trendHistoryCount ?? remediationTrend?.historyCount ?? null,
    remediationTrendChanged: positionStrategyRemediationSummary?.remediationTrendChanged ?? remediationFlat?.trendChanged ?? remediationTrend?.statusChanged ?? null,
    remediationTrendNextChanged: positionStrategyRemediationSummary?.remediationTrendNextChanged ?? remediationFlat?.trendNextChanged ?? remediationFlat?.nextCommandChanged ?? remediationTrend?.nextCommandChanged ?? null,
    remediationTrendAgeMinutes: positionStrategyRemediationSummary?.remediationTrendAgeMinutes ?? remediationFlat?.trendAgeMinutes ?? remediationTrend?.ageMinutes ?? null,
    remediationTrendStale: positionStrategyRemediationSummary?.remediationTrendStale ?? remediationFlat?.trendStale ?? remediationTrend?.stale ?? null,
    remediationTrendDuplicateDelta: positionStrategyRemediationSummary?.remediationTrendDuplicateDelta ?? remediationFlat?.trendDuplicateDelta ?? remediationTrend?.duplicateDelta ?? null,
    remediationTrendOrphanDelta: positionStrategyRemediationSummary?.remediationTrendOrphanDelta ?? remediationFlat?.trendOrphanDelta ?? remediationTrend?.orphanDelta ?? null,
    remediationTrendUnmatchedDelta: positionStrategyRemediationSummary?.remediationTrendUnmatchedDelta ?? remediationFlat?.trendUnmatchedDelta ?? remediationTrend?.unmatchedDelta ?? null,
    remediationRefreshNeeded: positionStrategyRemediationSummary?.remediationRefreshNeeded ?? remediationFlat?.refreshNeeded ?? remediationRefreshState?.needed ?? null,
    remediationRefreshStale: positionStrategyRemediationSummary?.remediationRefreshStale ?? remediationFlat?.refreshStale ?? remediationRefreshState?.stale ?? null,
    remediationRefreshReason: positionStrategyRemediationSummary?.remediationRefreshReason || remediationFlat?.refreshReason || remediationRefreshState?.reason || null,
    remediationRefreshCommand,
    remediationCommands,
    remediationActions,
    remediationActionReportCommand,
    remediationActionHistoryCommand,
    remediationActionRefreshCommand,
    remediationActionHygieneCommand,
    remediationActionNormalizeDryRunCommand,
    remediationActionNormalizeApplyCommand,
    remediationActionRetireDryRunCommand,
    remediationActionRetireApplyCommand,
    remediationReportCommand: remediationCommands.report,
    remediationHistoryCommand: remediationCommands.history,
    remediationNormalizeDryRunCommand: remediationCommands.normalizeDryRun,
    remediationNormalizeApplyCommand: remediationCommands.normalizeApply,
    remediationRetireDryRunCommand: remediationCommands.retireDryRun,
    remediationRetireApplyCommand: remediationCommands.retireApply,
  };
}

function buildDailyFeedbackRemediationPayload(remediationView, positionStrategyRemediationSummary, positionStrategyRemediationHistorySummary) {
  return {
    positionStrategyRemediationSummary,
    positionStrategyRemediationHistorySummary,
    remediationFlat: remediationView.remediationFlat,
    remediationSummary: remediationView.remediationSummary,
    remediationStatus: remediationView.remediationStatus,
    remediationHeadline: remediationView.remediationHeadline,
    remediationCounts: remediationView.remediationCounts,
    remediationRecommendedExchange: remediationView.remediationRecommendedExchange,
    remediationDuplicateManaged: remediationView.remediationDuplicateManaged,
    remediationOrphanProfiles: remediationView.remediationOrphanProfiles,
    remediationUnmatchedManaged: remediationView.remediationUnmatchedManaged,
    remediationTrend: remediationView.remediationTrend,
    remediationTrendHistoryCount: remediationView.remediationTrendHistoryCount,
    remediationTrendChanged: remediationView.remediationTrendChanged,
    remediationTrendNextChanged: remediationView.remediationTrendNextChanged,
    remediationTrendAgeMinutes: remediationView.remediationTrendAgeMinutes,
    remediationTrendStale: remediationView.remediationTrendStale,
    remediationTrendDuplicateDelta: remediationView.remediationTrendDuplicateDelta,
    remediationTrendOrphanDelta: remediationView.remediationTrendOrphanDelta,
    remediationTrendUnmatchedDelta: remediationView.remediationTrendUnmatchedDelta,
    remediationRefreshState: remediationView.remediationRefreshState,
    remediationRefreshNeeded: remediationView.remediationRefreshNeeded,
    remediationRefreshStale: remediationView.remediationRefreshStale,
    remediationRefreshReason: remediationView.remediationRefreshReason,
    remediationRefreshCommand: remediationView.remediationRefreshCommand,
    remediationActions: remediationView.remediationActions,
    remediationCommands: remediationView.remediationCommands,
    remediationActionReportCommand: remediationView.remediationActionReportCommand,
    remediationActionHistoryCommand: remediationView.remediationActionHistoryCommand,
    remediationActionRefreshCommand: remediationView.remediationActionRefreshCommand,
    remediationActionHygieneCommand: remediationView.remediationActionHygieneCommand,
    remediationActionNormalizeDryRunCommand: remediationView.remediationActionNormalizeDryRunCommand,
    remediationActionNormalizeApplyCommand: remediationView.remediationActionNormalizeApplyCommand,
    remediationActionRetireDryRunCommand: remediationView.remediationActionRetireDryRunCommand,
    remediationActionRetireApplyCommand: remediationView.remediationActionRetireApplyCommand,
    remediationReportCommand: remediationView.remediationReportCommand,
    remediationHistoryCommand: remediationView.remediationHistoryCommand,
    remediationNormalizeDryRunCommand: remediationView.remediationNormalizeDryRunCommand,
    remediationNormalizeApplyCommand: remediationView.remediationNormalizeApplyCommand,
    remediationRetireDryRunCommand: remediationView.remediationRetireDryRunCommand,
    remediationRetireApplyCommand: remediationView.remediationRetireApplyCommand,
    remediationNextCommand: remediationView.remediationNextCommand,
    remediationNextCommandTransition: remediationView.remediationNextCommandTransition,
    remediationNextCommandChanged: remediationView.remediationNextCommandChanged,
    remediationNextCommandPrevious: remediationView.remediationNextCommandPrevious,
    remediationNextCommandCurrent: remediationView.remediationNextCommandCurrent,
  };
}

function buildDailyFeedbackRemediationMemoryMetadata(remediationView, resolvedRemediationRefreshState, hygieneRemediationPlan) {
  return {
    remediationRefreshNeeded: resolvedRemediationRefreshState.needed,
    remediationRefreshStale: resolvedRemediationRefreshState.stale,
    remediationRefreshCommand: resolvedRemediationRefreshState.command,
    remediationSummaryStatus: remediationView.remediationStatus,
    remediationSummaryHeadline: remediationView.remediationHeadline,
    remediationReportCommand: remediationView.remediationActionReportCommand || hygieneRemediationPlan?.remediationReportCommand || null,
    remediationHistoryCommand: remediationView.remediationActionHistoryCommand,
    remediationRefreshPlanCommand: remediationView.remediationActionRefreshCommand,
    remediationNormalizeDryRunCommand: remediationView.remediationActionNormalizeDryRunCommand,
    remediationNormalizeApplyCommand: remediationView.remediationActionNormalizeApplyCommand,
    remediationRetireDryRunCommand: remediationView.remediationActionRetireDryRunCommand,
    remediationRetireApplyCommand: remediationView.remediationActionRetireApplyCommand,
    remediationTrendHistoryCount: remediationView.remediationTrendHistoryCount,
    remediationTrendChanged: remediationView.remediationTrendChanged,
    remediationTrendNextChanged: remediationView.remediationTrendNextChanged,
    remediationNextCommand: remediationView.remediationNextCommand,
    remediationNextCommandPrevious: remediationView.remediationNextCommandPrevious,
    remediationNextCommandCurrent: remediationView.remediationNextCommandCurrent,
  };
}

const DAILY_REVIEW_SYSTEM = `
당신은 루나팀 일일 매매 피드백 분석가다.
반드시 JSON 하나만 반환한다.
형식:
{
  "summary": "한 줄 요약",
  "wins": ["잘한 점"],
  "losses": ["아쉬운 점"],
  "nextActions": ["다음 액션"]
}
`;

function resolveMarketFilterClause(market = 'all', exchangeColumn = 'exchange') {
  const normalized = String(market || 'all').trim().toLowerCase();
  if (normalized === 'crypto') return `AND ${exchangeColumn} = 'binance'`;
  if (normalized === 'domestic') return `AND ${exchangeColumn} = 'kis'`;
  if (normalized === 'overseas') return `AND ${exchangeColumn} = 'kis_overseas'`;
  return '';
}

async function fetchDailyTrades(dateKst, market = 'all') {
  try {
    const marketClause = resolveMarketFilterClause(market, 'exchange');
    return await db.query(`
      SELECT
        trade_id, symbol, exchange, direction, is_paper,
        COALESCE(trade_mode, 'normal') AS trade_mode,
        pnl_net, pnl_percent, exit_reason, exit_time
      FROM trade_journal
      WHERE CAST(to_timestamp(exit_time / 1000.0) AT TIME ZONE 'Asia/Seoul' AS DATE) = $1::date
        AND status IN ('closed', 'tp_hit', 'sl_hit', 'force_exit')
        ${marketClause}
      ORDER BY exit_time DESC
      LIMIT 200
    `, [dateKst]);
  } catch (error) {
    console.warn(`  ⚠️ [daily-feedback] 거래 조회 실패: ${error?.message || error}`);
    return [];
  }
}

async function fetchDailyAnalystAccuracy(dateKst) {
  try {
    const rows = await db.query(`
      SELECT
        COUNT(*) AS total,
        AVG(CASE WHEN COALESCE((analyst_accuracy->>'aria')::boolean, aria_accurate) = true THEN 1.0 ELSE 0.0 END) AS aria_accuracy,
        AVG(CASE WHEN COALESCE((analyst_accuracy->>'sentinel')::boolean, sophia_accurate) = true THEN 1.0 ELSE 0.0 END) AS sophia_accuracy,
        AVG(CASE WHEN COALESCE((analyst_accuracy->>'oracle')::boolean, oracle_accurate) = true THEN 1.0 ELSE 0.0 END) AS oracle_accuracy,
        AVG(CASE WHEN COALESCE((analyst_accuracy->>'sentinel')::boolean, hermes_accurate) = true THEN 1.0 ELSE 0.0 END) AS hermes_accuracy
      FROM trade_review
      WHERE CAST(to_timestamp(reviewed_at / 1000.0) AT TIME ZONE 'Asia/Seoul' AS DATE) = $1::date
    `, [dateKst]);
    return rows[0] || null;
  } catch (error) {
    console.warn(`  ⚠️ [daily-feedback] analyst_accuracy 조회 실패: ${error?.message || error}`);
    return null;
  }
}

function buildDailyStats(trades = []) {
  const total = trades.length;
  const wins = trades.filter((trade) => Number(trade.pnl_net || 0) > 0).length;
  const losses = total - wins;
  const totalPnl = trades.reduce((sum, trade) => sum + Number(trade.pnl_net || 0), 0);
  const winRate = total > 0 ? wins / total : 0;
  const byExchange = {};
  for (const trade of trades) {
    const key = String(trade.exchange || 'unknown');
    byExchange[key] = byExchange[key] || { total: 0, pnl: 0 };
    byExchange[key].total += 1;
    byExchange[key].pnl += Number(trade.pnl_net || 0);
  }
  return { total, wins, losses, totalPnl, winRate, byExchange };
}

function formatAccuracy(value) {
  if (value == null || Number.isNaN(Number(value))) return 'N/A';
  return `${(Number(value) * 100).toFixed(1)}%`;
}

async function fetchScreeningSummary() {
  const markets = ['crypto', 'domestic', 'overseas'];
  const result = {};
  for (const market of markets) {
    try {
      const report = await buildScreeningHistoryReport({ market, limit: 3, json: true });
      result[market] = report.summary;
    } catch (error) {
      result[market] = {
        error: String(error?.message || error),
      };
    }
  }
  return result;
}

async function fetchPositionReevaluationSummary() {
  try {
    const result = await buildPositionReevaluationSummary({
      json: true,
      paper: false,
      persist: true,
      minutesBack: 180,
    });
    return result?.decision ? result : null;
  } catch (error) {
    return {
      error: String(error?.message || error),
    };
  }
}

async function fetchMinOrderPressureSummary() {
  try {
    return await buildRuntimeMinOrderPressureReport({
      market: 'kis',
      days: 14,
      json: true,
    });
  } catch (error) {
    return {
      error: String(error?.message || error),
    };
  }
}

async function buildDailyFeedback(dateKst, trades, analystAccuracy) {
  const stats = buildDailyStats(trades);
  if (trades.length === 0) {
    return {
      summary: '당일 종료 거래가 없어 운영 관찰 중심으로 마감합니다.',
      wins: ['종료 거래 없음'],
      losses: [],
      nextActions: ['다음 거래일에 신호 품질과 체결 효율을 계속 관찰합니다.'],
      stats,
    };
  }

  const userPrompt = [
    `date=${dateKst}`,
    `totalTrades=${stats.total}`,
    `wins=${stats.wins}`,
    `losses=${stats.losses}`,
    `totalPnl=${stats.totalPnl.toFixed(2)}`,
    `winRate=${(stats.winRate * 100).toFixed(1)}%`,
    `analystAccuracy=${JSON.stringify(analystAccuracy || {})}`,
    `trades=${JSON.stringify(trades.slice(0, 30))}`,
  ].join('\n');

  try {
    const raw = await callLLM('hermes', DAILY_REVIEW_SYSTEM, userPrompt, 400);
    const parsed = parseJSON(raw);
    if (parsed?.summary) {
      return { ...parsed, stats };
    }
  } catch (error) {
    console.warn(`  ⚠️ [daily-feedback] LLM 요약 실패: ${error?.message || error}`);
  }

  return {
    summary: `총 ${stats.total}건, 승률 ${(stats.winRate * 100).toFixed(1)}%, 손익 $${stats.totalPnl.toFixed(2)}로 마감했습니다.`,
    wins: stats.wins > 0 ? [`수익 거래 ${stats.wins}건이 있었습니다.`] : [],
    losses: stats.losses > 0 ? [`손실 거래 ${stats.losses}건을 복기해야 합니다.`] : [],
    nextActions: ['종료 사유와 analyst_accuracy를 기준으로 다음 거래일 진입 기준을 점검합니다.'],
    stats,
  };
}

function buildScreeningLine(screeningSummary) {
  if (!screeningSummary) return null;
  const parts = [];
  for (const market of ['crypto', 'domestic', 'overseas']) {
    const summary = screeningSummary[market];
    if (!summary || summary.error || !summary.trend) continue;
    const delta = summary.trend.deltaDynamicCount;
    const signedDelta = `${delta >= 0 ? '+' : ''}${delta}`;
    parts.push(`${market} ${summary.trend.latestDynamicCount}개(${signedDelta})`);
  }
  return parts.length > 0 ? `🔎 screening: ${parts.join(' | ')}` : null;
}

function buildPositionReevaluationLine(reevaluationSummary) {
  if (!reevaluationSummary || reevaluationSummary.error || !reevaluationSummary.decision) return null;
  const metrics = reevaluationSummary.decision.metrics || {};
  return `🔁 reeval: ${reevaluationSummary.decision.status} | HOLD ${metrics.holds || 0} / ADJUST ${metrics.adjusts || 0} / EXIT ${metrics.exits || 0}`;
}

function buildPositionRuntimeView(runtimeReport, runtimeTuning, runtimeDispatch) {
  const decision = runtimeReport?.decision || {};
  const metrics = decision.metrics || {};
  const suggestions = Array.isArray(runtimeTuning?.suggestions) ? runtimeTuning.suggestions : [];
  const topSuggestion = suggestions[0] || null;
  const candidates = Array.isArray(runtimeDispatch?.candidates) ? runtimeDispatch.candidates : [];
  return {
    status: decision.status || 'position_runtime_unknown',
    headline: decision.headline || 'runtime state unavailable',
    metrics: {
      total: Number(metrics.total || 0),
      active: Number(metrics.active || 0),
      exitReady: Number(metrics.exitReady || 0),
      adjustReady: Number(metrics.adjustReady || 0),
      staleValidation: Number(metrics.staleValidation || 0),
      fastLane: Number(metrics.fastLane || 0),
    },
    tuningStatus: runtimeTuning?.status || 'position_runtime_tuning_unknown',
    tuningSuggestion: topSuggestion,
    dispatchStatus: runtimeDispatch?.status || 'position_runtime_dispatch_unknown',
    dispatchCandidates: candidates.length,
    dispatchTopCandidate: candidates[0] || null,
    reportCommand: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-runtime -- --json',
    tuningCommand: topSuggestion?.exchange
      ? `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-runtime-tuning -- --exchange=${topSuggestion.exchange} --json`
      : 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-runtime-tuning -- --json',
    dispatchCommand: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-runtime-dispatch -- --json',
    autotuneCommand: topSuggestion?.exchange
      ? `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-runtime-autotune -- --exchange=${topSuggestion.exchange} --apply --confirm=runtime-autotune --json`
      : 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-runtime-autotune -- --apply --confirm=runtime-autotune --json',
    autopilotCommand: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-runtime-autopilot -- --execute --apply-tuning --execute-dispatch --confirm=position-runtime-autopilot --json',
  };
}

function buildPositionRuntimeLine(runtimeView) {
  if (!runtimeView) return null;
  const suggestion = runtimeView.tuningSuggestion || null;
  return `⚙️ runtime: ${runtimeView.status} | active ${runtimeView.metrics?.active || 0} / fast ${runtimeView.metrics?.fastLane || 0} / adjust ${runtimeView.metrics?.adjustReady || 0} / exit ${runtimeView.metrics?.exitReady || 0}${suggestion ? ` | tune ${suggestion.exchange} ${suggestion.status}` : ''}`;
}

function buildPositionRuntimeCommandLine(runtimeView) {
  if (!runtimeView) return null;
  return `🚦 runtime dispatch: ${runtimeView.dispatchCommand}`;
}

function buildPositionRuntimeAutopilotLine(runtimeView) {
  if (!runtimeView) return null;
  return `🤖 runtime autopilot: ${runtimeView.autopilotCommand}`;
}

function buildMinOrderPressureLine(minOrderPressureSummary) {
  if (!minOrderPressureSummary || minOrderPressureSummary.error || !minOrderPressureSummary.decision) return null;
  const decision = minOrderPressureSummary.decision || {};
  if (decision.status === 'min_order_ok') return null;
  const gapLine = (decision.reasons || []).find((reason) => String(reason).startsWith('runtime gap '));
  return `💵 min-order: ${decision.status}${gapLine ? ` | ${gapLine.replace(/^runtime gap /, '')}` : ''}`;
}

function buildLearningLoopLine(learningLoopSummary) {
  if (!learningLoopSummary || learningLoopSummary.error || !learningLoopSummary.decision) return null;
  const decision = learningLoopSummary.decision || {};
  const weakest = learningLoopSummary.sections?.regimeLaneSummary?.weakestRegime;
  const topSuggestion = learningLoopSummary.sections?.strategy?.runtimeSuggestionTop;
  const latestOpsSnapshot = loadLatestOpsSnapshot();
  const { weakest: latestWeakest, weakestMode: latestSnapshotWeakestMode } = getWeakestRegimeSummary(
    latestOpsSnapshot?.health?.runtimeLearningLoop,
  );
  const weakestMode = weakest?.tradeMode || weakest?.worstMode?.tradeMode || weakest?.bestMode?.tradeMode;
  const weakestLabel = weakest?.regime && weakestMode
    ? `${weakest.regime}/${weakestMode}`
    : null;
  const suggestionValue = topSuggestion?.suggestedValue ?? topSuggestion?.suggested;
  const suggestionLabel = topSuggestion?.key && suggestionValue != null
    ? `${topSuggestion.key} -> ${suggestionValue}`
    : null;
  const parts = [
    decision.status,
    weakestLabel ? `weakest ${weakestLabel}` : null,
    suggestionLabel ? `top suggestion ${suggestionLabel}` : null,
    latestOpsSnapshot?.capturedAt ? `snapshot ${latestOpsSnapshot.capturedAt} ${latestWeakest?.regime || 'n/a'}/${latestSnapshotWeakestMode}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? `🧭 learning loop: ${parts.join(' | ')}` : null;
}

function buildPositionStrategyCoverageLine(positionStrategyAuditSummary) {
  if (!positionStrategyAuditSummary || positionStrategyAuditSummary.error || !positionStrategyAuditSummary.ok) return null;
  const managed = Number(positionStrategyAuditSummary.managedPositions || 0);
  const profiles = Number(positionStrategyAuditSummary.managedProfiles || 0);
  const dust = Number(positionStrategyAuditSummary.dustPositions || 0);
  const duplicates = Number(positionStrategyAuditSummary.duplicateManagedProfileScopes || positionStrategyAuditSummary.duplicateActiveProfileScopes || 0);
  const lifecycle = positionStrategyAuditSummary.lifecycleDistribution || {};
  const lifecycleLine = Object.entries(lifecycle)
    .slice(0, 3)
    .map(([key, value]) => `${key} ${value}`)
    .join(' / ');
  return `🧩 strategy coverage: managed ${managed} / profiles ${profiles} / dust ${dust} / duplicateScopes ${duplicates}${lifecycleLine ? ` | ${lifecycleLine}` : ''}`;
}

function buildPositionStrategyHygieneLine(positionStrategyHygieneSummary) {
  if (!positionStrategyHygieneSummary || positionStrategyHygieneSummary.error || !positionStrategyHygieneSummary.ok) return null;
  const decision = positionStrategyHygieneSummary.decision || {};
  const recommendedExchange = positionStrategyHygieneSummary.recommendedExchange?.exchange || null;
  return `🧼 strategy hygiene: ${decision.status || 'unknown'} | ${decision.headline || 'n/a'}${recommendedExchange ? ` | focus ${recommendedExchange}` : ''}`;
}

function buildPositionStrategyHygieneCommandLine(positionStrategyHygieneSummary) {
  const remediationPlan = positionStrategyHygieneSummary?.remediationPlan
    || buildPositionStrategyHygieneRemediationPlan(positionStrategyHygieneSummary);
  if (!remediationPlan || remediationPlan.status !== 'position_strategy_hygiene_attention') return null;
  return `🛠️ hygiene follow-up: normalize/retire ${remediationPlan.recommendedExchange || 'all'} | ${remediationPlan.normalizeDryRunCommand}`;
}

function buildPositionStrategyRemediationLine(positionStrategyRemediationSummary) {
  if (!positionStrategyRemediationSummary || positionStrategyRemediationSummary.error || !positionStrategyRemediationSummary.ok) return null;
  const remediationView = buildDailyFeedbackRemediationView(positionStrategyRemediationSummary, positionStrategyRemediationSummary?.remediationHistory || null);
  const decision = positionStrategyRemediationSummary.decision || {};
  return `🧯 remediation: ${remediationView.remediationStatus || decision.status || 'unknown'} | ${remediationView.remediationHeadline || decision.headline || 'n/a'}`;
}

function buildPositionStrategyRemediationCommandLine(positionStrategyRemediationSummary) {
  if (!positionStrategyRemediationSummary || positionStrategyRemediationSummary.error || !positionStrategyRemediationSummary.ok) return null;
  const remediationPlan = positionStrategyRemediationSummary.remediationPlan || null;
  const remediationView = buildDailyFeedbackRemediationView(positionStrategyRemediationSummary, positionStrategyRemediationSummary?.remediationHistory || null);
  if (!remediationPlan || remediationPlan.status !== 'position_strategy_hygiene_attention') return null;
  return `🛠️ remediation report: ${remediationView.remediationActionReportCommand || remediationView.remediationReportCommand || remediationPlan.remediationReportCommand || 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-strategy-remediation -- --json'}`;
}

function buildPositionStrategyRemediationRefreshCommandLine(positionStrategyRemediationSummary) {
  if (!positionStrategyRemediationSummary || positionStrategyRemediationSummary.error || !positionStrategyRemediationSummary.ok) return null;
  const remediationPlan = positionStrategyRemediationSummary.remediationPlan || null;
  const remediationView = buildDailyFeedbackRemediationView(positionStrategyRemediationSummary, positionStrategyRemediationSummary?.remediationHistory || null);
  const refreshCommand = remediationView.remediationActionRefreshCommand
    || remediationView.remediationRefreshCommand
    || remediationPlan?.remediationRefreshCommand
    || null;
  if (!refreshCommand) return null;
  return `♻️ remediation refresh: ${refreshCommand}`;
}

function buildPositionStrategyRemediationNextCommandLine(positionStrategyRemediationSummary) {
  if (!positionStrategyRemediationSummary || positionStrategyRemediationSummary.error || !positionStrategyRemediationSummary.ok) return null;
  const remediationView = buildDailyFeedbackRemediationView(positionStrategyRemediationSummary, positionStrategyRemediationSummary?.remediationHistory || null);
  const nextCommand = remediationView.remediationNextCommand;
  if (!nextCommand) return null;
  return `🧭 remediation next: ${nextCommand}`;
}

function buildPositionStrategyRemediationRefreshLine(positionStrategyRemediationSummary) {
  if (!positionStrategyRemediationSummary || positionStrategyRemediationSummary.error || !positionStrategyRemediationSummary.ok) return null;
  const remediationView = buildDailyFeedbackRemediationView(positionStrategyRemediationSummary, positionStrategyRemediationSummary?.remediationHistory || null);
  return remediationView.remediationRefreshReason ? `♻️ ${remediationView.remediationRefreshReason}` : null;
}

function buildPositionStrategyRemediationRefreshStateLine(positionStrategyRemediationSummary) {
  if (!positionStrategyRemediationSummary || positionStrategyRemediationSummary.error || !positionStrategyRemediationSummary.ok) return null;
  const remediationView = buildDailyFeedbackRemediationView(positionStrategyRemediationSummary, positionStrategyRemediationSummary?.remediationHistory || null);
  return `♻️ refresh state: needed ${remediationView.remediationRefreshNeeded ? 'yes' : 'no'} | stale ${remediationView.remediationRefreshStale ? 'yes' : 'no'} | command ${remediationView.remediationRefreshCommand || 'n/a'}`;
}

function buildPositionStrategyRemediationHistoryLine(positionStrategyRemediationSummary, positionStrategyRemediationHistorySummary) {
  const remediationView = buildDailyFeedbackRemediationView(positionStrategyRemediationSummary, positionStrategyRemediationHistorySummary);
  if (remediationView.remediationTrendHistoryCount !== null && remediationView.remediationTrendHistoryCount !== undefined) {
    return `🗂️ remediation history: count ${remediationView.remediationTrendHistoryCount || 0} | changed ${remediationView.remediationTrendChanged ? 'yes' : 'no'} | next changed ${remediationView.remediationTrendNextChanged ? 'yes' : 'no'}${remediationView.remediationTrendNextChanged ? ` (${remediationView.remediationNextCommandPrevious || 'none'} -> ${remediationView.remediationNextCommandCurrent || 'none'})` : ''} | age ${remediationView.remediationTrendAgeMinutes ?? 'n/a'}m | stale ${remediationView.remediationTrendStale ? 'yes' : 'no'} | duplicate ${(remediationView.remediationTrendDuplicateDelta ?? 0) >= 0 ? '+' : ''}${remediationView.remediationTrendDuplicateDelta || 0} | orphan ${(remediationView.remediationTrendOrphanDelta ?? 0) >= 0 ? '+' : ''}${remediationView.remediationTrendOrphanDelta || 0}`;
  }
  if (!positionStrategyRemediationHistorySummary || positionStrategyRemediationHistorySummary.error || !positionStrategyRemediationHistorySummary.ok) return null;
  return `🗂️ remediation history: count ${positionStrategyRemediationHistorySummary.historyCount || 0} | changed ${positionStrategyRemediationHistorySummary.statusChanged ? 'yes' : 'no'} | next changed ${positionStrategyRemediationHistorySummary.nextCommandChanged ? 'yes' : 'no'}${positionStrategyRemediationHistorySummary.nextCommandChanged ? ` (${positionStrategyRemediationHistorySummary.nextCommandTransition?.previous || 'none'} -> ${positionStrategyRemediationHistorySummary.nextCommandTransition?.current || 'none'})` : ''} | age ${positionStrategyRemediationHistorySummary.ageMinutes ?? 'n/a'}m | stale ${positionStrategyRemediationHistorySummary.stale ? 'yes' : 'no'} | duplicate ${positionStrategyRemediationHistorySummary.delta?.duplicateManaged >= 0 ? '+' : ''}${positionStrategyRemediationHistorySummary.delta?.duplicateManaged || 0} | orphan ${positionStrategyRemediationHistorySummary.delta?.orphanProfiles >= 0 ? '+' : ''}${positionStrategyRemediationHistorySummary.delta?.orphanProfiles || 0}`;
}

function buildDailyFeedbackRemediationLines(positionStrategyRemediationSummary, positionStrategyRemediationHistorySummary) {
  return {
    remediationLine: buildPositionStrategyRemediationLine(positionStrategyRemediationSummary),
    remediationHistoryLine: buildPositionStrategyRemediationHistoryLine(positionStrategyRemediationSummary, positionStrategyRemediationHistorySummary),
    remediationRefreshStateLine: buildPositionStrategyRemediationRefreshStateLine(positionStrategyRemediationSummary),
    remediationRefreshLine: buildPositionStrategyRemediationRefreshLine(positionStrategyRemediationSummary),
    remediationRefreshCommandLine: buildPositionStrategyRemediationRefreshCommandLine(positionStrategyRemediationSummary),
    remediationNextCommandLine: buildPositionStrategyRemediationNextCommandLine(positionStrategyRemediationSummary),
    remediationCommandLine: buildPositionStrategyRemediationCommandLine(positionStrategyRemediationSummary),
  };
}

function getLearningLoopNextCommand(learningLoopSummary) {
  const nextActions = learningLoopSummary?.decision?.nextActions;
  if (!Array.isArray(nextActions)) return null;
  return nextActions.find((item) => typeof item === 'string' && item.startsWith('npm --prefix'))
    || null;
}

function buildDailyFeedbackMemoryQuery(dateKst, feedback, screeningSummary, reevaluationSummary, minOrderPressureSummary) {
  return [
    'investment daily trade feedback',
    dateKst,
    feedback?.stats?.wins > feedback?.stats?.losses ? 'win-day' : 'loss-day',
    screeningSummary?.crypto?.trend ? 'screening-active' : 'screening-light',
    reevaluationSummary?.decision?.status || null,
    minOrderPressureSummary?.decision?.status || null,
  ].filter(Boolean).join(' ');
}

function buildTelegramMessage(dateKst, feedback, analystAccuracy, screeningSummary, reevaluationSummary, minOrderPressureSummary, learningLoopSummary, positionStrategyAuditSummary, positionStrategyHygieneSummary, positionStrategyRemediationSummary, positionStrategyRemediationHistorySummary, positionRuntimeView) {
  const remediationLines = buildDailyFeedbackRemediationLines(
    positionStrategyRemediationSummary,
    positionStrategyRemediationHistorySummary,
  );
  const lines = [
    `🌓 루나 일일 피드백 (${dateKst})`,
    `📌 ${feedback.summary}`,
    `📊 거래 ${feedback.stats.total}건 | 승률 ${(feedback.stats.winRate * 100).toFixed(1)}% | 손익 $${feedback.stats.totalPnl.toFixed(2)}`,
    `🧠 분석팀 정확도: aria ${formatAccuracy(analystAccuracy?.aria_accuracy)}, sophia ${formatAccuracy(analystAccuracy?.sophia_accuracy)}, oracle ${formatAccuracy(analystAccuracy?.oracle_accuracy)}, hermes ${formatAccuracy(analystAccuracy?.hermes_accuracy)}`,
  ];
  const screeningLine = buildScreeningLine(screeningSummary);
  if (screeningLine) lines.push(screeningLine);
  const reevaluationLine = buildPositionReevaluationLine(reevaluationSummary);
  if (reevaluationLine) lines.push(reevaluationLine);
  const runtimeLine = buildPositionRuntimeLine(positionRuntimeView);
  if (runtimeLine) lines.push(runtimeLine);
  const minOrderPressureLine = buildMinOrderPressureLine(minOrderPressureSummary);
  if (minOrderPressureLine) lines.push(minOrderPressureLine);
  const learningLoopLine = buildLearningLoopLine(learningLoopSummary);
  if (learningLoopLine) lines.push(learningLoopLine);
  const positionStrategyCoverageLine = buildPositionStrategyCoverageLine(positionStrategyAuditSummary);
  if (positionStrategyCoverageLine) lines.push(positionStrategyCoverageLine);
  const positionStrategyHygieneLine = buildPositionStrategyHygieneLine(positionStrategyHygieneSummary);
  if (positionStrategyHygieneLine) lines.push(positionStrategyHygieneLine);
  if (remediationLines.remediationLine) lines.push(remediationLines.remediationLine);
  if (remediationLines.remediationHistoryLine) lines.push(remediationLines.remediationHistoryLine);
  if (remediationLines.remediationRefreshStateLine) lines.push(remediationLines.remediationRefreshStateLine);
  if (remediationLines.remediationRefreshLine) lines.push(remediationLines.remediationRefreshLine);
  if (remediationLines.remediationRefreshCommandLine) lines.push(remediationLines.remediationRefreshCommandLine);
  if (remediationLines.remediationNextCommandLine) lines.push(remediationLines.remediationNextCommandLine);
  if (remediationLines.remediationCommandLine) lines.push(remediationLines.remediationCommandLine);
  const runtimeCommandLine = buildPositionRuntimeCommandLine(positionRuntimeView);
  if (runtimeCommandLine) lines.push(runtimeCommandLine);
  const runtimeAutopilotLine = buildPositionRuntimeAutopilotLine(positionRuntimeView);
  if (runtimeAutopilotLine) lines.push(runtimeAutopilotLine);
  const positionStrategyHygieneCommandLine = buildPositionStrategyHygieneCommandLine(positionStrategyHygieneSummary);
  if (positionStrategyHygieneCommandLine) lines.push(positionStrategyHygieneCommandLine);
  if (Array.isArray(feedback.nextActions) && feedback.nextActions.length > 0) {
    lines.push(`➡️ 다음 액션: ${feedback.nextActions.join(' / ')}`);
  }
  const learningLoopNextCommand = getLearningLoopNextCommand(learningLoopSummary);
  if (learningLoopNextCommand) {
    lines.push(`🛠️ next command: ${learningLoopNextCommand}`);
  }
  return lines.join('\n');
}

async function storeDailyFeedbackRag(dateKst, feedback, analystAccuracy, screeningSummary, reevaluationSummary, minOrderPressureSummary, learningLoopSummary, positionStrategyAuditSummary, positionStrategyHygieneSummary, positionStrategyRemediationSummary, positionStrategyRemediationHistorySummary, positionRuntimeView) {
  const hygieneRemediationPlan = positionStrategyHygieneSummary?.remediationPlan
    || buildPositionStrategyHygieneRemediationPlan(positionStrategyHygieneSummary);
  const remediationView = buildDailyFeedbackRemediationView(positionStrategyRemediationSummary, positionStrategyRemediationHistorySummary);
  const remediationSummary = remediationView.remediationSummary;
  const remediationFlat = remediationView.remediationFlat;
  const resolvedRemediationRefreshState = remediationView.remediationRefreshState;
  const remediationLines = buildDailyFeedbackRemediationLines(
    positionStrategyRemediationSummary,
    positionStrategyRemediationHistorySummary,
  );
  const content = [
    `[일일 피드백 ${dateKst}] ${feedback.summary}`,
    `거래 ${feedback.stats.total}건 / 승률 ${(feedback.stats.winRate * 100).toFixed(1)}% / 손익 $${feedback.stats.totalPnl.toFixed(2)}`,
    buildScreeningLine(screeningSummary),
    buildPositionReevaluationLine(reevaluationSummary),
    buildPositionRuntimeLine(positionRuntimeView),
    buildMinOrderPressureLine(minOrderPressureSummary),
    buildLearningLoopLine(learningLoopSummary),
    buildPositionStrategyCoverageLine(positionStrategyAuditSummary),
    buildPositionStrategyHygieneLine(positionStrategyHygieneSummary),
    remediationLines.remediationLine,
    remediationLines.remediationHistoryLine,
    remediationLines.remediationRefreshStateLine,
    remediationLines.remediationRefreshLine,
    remediationLines.remediationRefreshCommandLine,
    remediationLines.remediationNextCommandLine,
    remediationLines.remediationCommandLine,
    buildPositionRuntimeCommandLine(positionRuntimeView),
    buildPositionRuntimeAutopilotLine(positionRuntimeView),
    buildPositionStrategyHygieneCommandLine(positionStrategyHygieneSummary),
    `다음 액션: ${(feedback.nextActions || []).join(' / ') || '없음'}`,
  ].filter(Boolean).join('\n');
  await rag.store('trades', content, {
    type: 'daily_trade_feedback',
    date: dateKst,
    total_trades: feedback.stats.total,
    win_rate: feedback.stats.winRate,
    total_pnl: feedback.stats.totalPnl,
    analyst_accuracy: analystAccuracy || {},
    screening_summary: screeningSummary || {},
    reevaluation_summary: reevaluationSummary?.decision || {},
    position_runtime: positionRuntimeView || {},
    min_order_pressure_summary: minOrderPressureSummary?.decision || {},
    learning_loop_summary: learningLoopSummary?.decision || {},
    position_strategy_audit: positionStrategyAuditSummary || {},
    position_strategy_hygiene: positionStrategyHygieneSummary || {},
    position_strategy_remediation: positionStrategyRemediationSummary || {},
    position_strategy_remediation_flat: remediationFlat || {},
    position_strategy_remediation_summary: remediationSummary || {},
    position_strategy_remediation_history: positionStrategyRemediationHistorySummary || {},
    position_strategy_remediation_refresh: resolvedRemediationRefreshState,
    position_strategy_remediation_status: remediationView.remediationStatus,
    position_strategy_remediation_headline: remediationView.remediationHeadline,
    position_strategy_remediation_counts: remediationView.remediationCounts,
    position_strategy_remediation_recommended_exchange: remediationView.remediationRecommendedExchange,
    position_strategy_remediation_next_command: remediationView.remediationNextCommand,
    position_strategy_remediation_next_command_transition: remediationView.remediationNextCommandTransition,
    position_strategy_remediation_action_report_command: remediationView.remediationActionReportCommand,
    position_strategy_remediation_action_history_command: remediationView.remediationActionHistoryCommand,
    position_strategy_remediation_action_refresh_command: remediationView.remediationActionRefreshCommand,
    position_strategy_remediation_action_hygiene_command: remediationView.remediationActionHygieneCommand,
    position_strategy_remediation_action_normalize_dry_run_command: remediationView.remediationActionNormalizeDryRunCommand,
    position_strategy_remediation_action_normalize_apply_command: remediationView.remediationActionNormalizeApplyCommand,
    position_strategy_remediation_action_retire_dry_run_command: remediationView.remediationActionRetireDryRunCommand,
    position_strategy_remediation_action_retire_apply_command: remediationView.remediationActionRetireApplyCommand,
    position_strategy_hygiene_remediation: hygieneRemediationPlan || {},
    position_strategy_hygiene_recommended_exchange: positionStrategyHygieneSummary?.recommendedExchange?.exchange || null,
    position_strategy_hygiene_recommended_count: Number(positionStrategyHygieneSummary?.recommendedExchange?.count || 0),
    position_runtime_autotune_command: positionRuntimeView?.autotuneCommand || null,
    position_runtime_autopilot_command: positionRuntimeView?.autopilotCommand || null,
  }, 'luna');
}

async function runDailyTradeFeedback({ dateKst, dryRun = false, market = 'all' }) {
  const trades = await fetchDailyTrades(dateKst, market);
  const analystAccuracy = await fetchDailyAnalystAccuracy(dateKst);
  const screeningSummary = await fetchScreeningSummary();
  const reevaluationSummary = await fetchPositionReevaluationSummary();
  const positionRuntimeReport = await runPositionRuntimeReport({ json: true, limit: 200 }).catch((error) => ({
    error: String(error?.message || error),
  }));
  const positionRuntimeTuning = await runPositionRuntimeTuning({ json: true }).catch((error) => ({
    error: String(error?.message || error),
  }));
  const positionRuntimeDispatch = await runPositionRuntimeDispatch({ json: true, limit: 20 }).catch((error) => ({
    error: String(error?.message || error),
  }));
  const positionRuntimeView = buildPositionRuntimeView(positionRuntimeReport, positionRuntimeTuning, positionRuntimeDispatch);
  const minOrderPressureSummary = await fetchMinOrderPressureSummary();
  const learningLoopSummary = await buildRuntimeLearningLoopReport({ days: 14, json: true }).catch((error) => ({
    error: String(error?.message || error),
  }));
  const positionStrategyAuditSummary = await buildRuntimePositionStrategyAudit({ json: true }).catch((error) => ({
    error: String(error?.message || error),
  }));
  const positionStrategyHygieneSummary = await runPositionStrategyHygiene({ json: true }).catch((error) => ({
    error: String(error?.message || error),
  }));
  const positionStrategyRemediationSummary = await runPositionStrategyRemediation({ json: true }).catch((error) => ({
    error: String(error?.message || error),
  }));
  const positionStrategyRemediationHistorySummary = positionStrategyRemediationSummary?.remediationHistory || null;
  const remediationView = buildDailyFeedbackRemediationView(positionStrategyRemediationSummary, positionStrategyRemediationHistorySummary);
  const remediationFlat = remediationView.remediationFlat;
  const remediationSummary = remediationView.remediationSummary;
  const remediationPayload = buildDailyFeedbackRemediationPayload(
    remediationView,
    positionStrategyRemediationSummary,
    positionStrategyRemediationHistorySummary,
  );
  const feedback = await buildDailyFeedback(dateKst, trades, analystAccuracy);
  const hygieneRemediationPlan = positionStrategyHygieneSummary?.remediationPlan
    || buildPositionStrategyHygieneRemediationPlan(positionStrategyHygieneSummary);
  const resolvedRemediationRefreshState = remediationView.remediationRefreshState;
  const message = buildTelegramMessage(dateKst, feedback, analystAccuracy, screeningSummary, reevaluationSummary, minOrderPressureSummary, learningLoopSummary, positionStrategyAuditSummary, positionStrategyHygieneSummary, positionStrategyRemediationSummary, positionStrategyRemediationHistorySummary, positionRuntimeView);

  try {
    await storeDailyFeedbackRag(dateKst, feedback, analystAccuracy, screeningSummary, reevaluationSummary, minOrderPressureSummary, learningLoopSummary, positionStrategyAuditSummary, positionStrategyHygieneSummary, positionStrategyRemediationSummary, positionStrategyRemediationHistorySummary, positionRuntimeView);
  } catch (error) {
    console.warn(`  ⚠️ [daily-feedback] RAG 저장 실패(무시): ${error?.message || error}`);
  }

  if (!dryRun) {
    try {
      const memoryQuery = buildDailyFeedbackMemoryQuery(dateKst, feedback, screeningSummary, reevaluationSummary, minOrderPressureSummary);
      const episodicHint = await dailyFeedbackMemory.recallCountHint(memoryQuery, {
        type: 'episodic',
        limit: 2,
        threshold: Number(RAG_RUNTIME.dailyFeedbackMemory?.episodicThreshold ?? 0.33),
        title: '최근 유사 피드백',
        separator: 'pipe',
        metadataKey: 'kind',
        labels: {
          feedback: '피드백',
        },
        order: ['feedback'],
      }).catch(() => '');
      const semanticHint = await dailyFeedbackMemory.recallHint(`${memoryQuery} consolidated trading pattern`, {
        type: 'semantic',
        limit: 2,
        threshold: Number(RAG_RUNTIME.dailyFeedbackMemory?.semanticThreshold ?? 0.28),
        title: '최근 통합 패턴',
        separator: 'newline',
      }).catch(() => '');
      const finalMessage = `${message}${episodicHint}${semanticHint}`;
      await publishAlert({
        from_bot: 'luna',
        event_type: 'daily_feedback',
        alert_level: 1,
        message: finalMessage,
        payload: { dateKst, feedback, analystAccuracy, screeningSummary, reevaluationSummary, positionRuntimeReport, positionRuntimeTuning, positionRuntimeDispatch, positionRuntimeView, minOrderPressureSummary, learningLoopSummary, positionStrategyAuditSummary, positionStrategyHygieneSummary, remediationFlat, remediationSummary, hygieneRemediationPlan, ...remediationPayload },
      });
      await dailyFeedbackMemory.remember(finalMessage, 'episodic', {
        importance: 0.7,
        expiresIn: 1000 * 60 * 60 * 24 * 30,
        metadata: {
          kind: 'feedback',
          dateKst,
          tradeCount: feedback.stats.total,
          totalPnl: feedback.stats.totalPnl,
          winRate: feedback.stats.winRate,
          positionRuntimeStatus: positionRuntimeView?.status || null,
          positionRuntimeHeadline: positionRuntimeView?.headline || null,
          positionRuntimeActive: positionRuntimeView?.metrics?.active || 0,
          positionRuntimeExitReady: positionRuntimeView?.metrics?.exitReady || 0,
          positionRuntimeAdjustReady: positionRuntimeView?.metrics?.adjustReady || 0,
          positionRuntimeDispatchCommand: positionRuntimeView?.dispatchCommand || null,
          positionRuntimeAutotuneCommand: positionRuntimeView?.autotuneCommand || null,
          positionRuntimeAutopilotCommand: positionRuntimeView?.autopilotCommand || null,
          hygieneStatus: hygieneRemediationPlan?.status || null,
          hygieneExchange: hygieneRemediationPlan?.recommendedExchange || null,
          ...buildDailyFeedbackRemediationMemoryMetadata(
            remediationView,
            resolvedRemediationRefreshState,
            hygieneRemediationPlan,
          ),
        },
      }).catch(() => {});
      await dailyFeedbackMemory.consolidate({
        olderThanDays: 14,
        limit: 10,
      }).catch(() => {});
    } catch (error) {
      console.warn(`  ⚠️ [daily-feedback] 메인봇 발행 실패(무시): ${error?.message || error}`);
    }
  }

  return {
    status: 'ok',
    date: dateKst,
    dryRun,
    tradeCount: trades.length,
    analystAccuracy,
    screeningSummary,
    reevaluationSummary,
    positionRuntimeReport,
    positionRuntimeTuning,
    positionRuntimeDispatch,
    positionRuntimeView,
    positionRuntimeStatus: positionRuntimeView.status,
    positionRuntimeHeadline: positionRuntimeView.headline,
    positionRuntimeMetrics: positionRuntimeView.metrics,
    positionRuntimeTuningStatus: positionRuntimeView.tuningStatus,
    positionRuntimeTuningSuggestion: positionRuntimeView.tuningSuggestion,
    positionRuntimeDispatchStatus: positionRuntimeView.dispatchStatus,
    positionRuntimeDispatchCandidates: positionRuntimeView.dispatchCandidates,
    positionRuntimeDispatchTopCandidate: positionRuntimeView.dispatchTopCandidate,
    positionRuntimeReportCommand: positionRuntimeView.reportCommand,
    positionRuntimeTuningCommand: positionRuntimeView.tuningCommand,
    positionRuntimeDispatchCommand: positionRuntimeView.dispatchCommand,
    positionRuntimeAutotuneCommand: positionRuntimeView.autotuneCommand,
    positionRuntimeAutopilotCommand: positionRuntimeView.autopilotCommand,
    minOrderPressureSummary,
    learningLoopSummary,
    positionStrategyAuditSummary,
    positionStrategyHygieneSummary,
    positionStrategyRemediationSummary,
    positionStrategyRemediationHistorySummary,
    remediationFlat,
    remediationSummary,
    remediationStatus: remediationView.remediationStatus,
    remediationHeadline: remediationView.remediationHeadline,
    remediationCounts: remediationView.remediationCounts,
    remediationRecommendedExchange: remediationView.remediationRecommendedExchange,
    remediationDuplicateManaged: remediationView.remediationDuplicateManaged,
    remediationOrphanProfiles: remediationView.remediationOrphanProfiles,
    remediationUnmatchedManaged: remediationView.remediationUnmatchedManaged,
    remediationTrend: remediationView.remediationTrend,
    remediationTrendHistoryCount: remediationView.remediationTrendHistoryCount,
    remediationTrendChanged: remediationView.remediationTrendChanged,
    remediationTrendNextChanged: remediationView.remediationTrendNextChanged,
    remediationTrendAgeMinutes: remediationView.remediationTrendAgeMinutes,
    remediationTrendStale: remediationView.remediationTrendStale,
    remediationTrendDuplicateDelta: remediationView.remediationTrendDuplicateDelta,
    remediationTrendOrphanDelta: remediationView.remediationTrendOrphanDelta,
    remediationTrendUnmatchedDelta: remediationView.remediationTrendUnmatchedDelta,
    remediationRefreshState: remediationView.remediationRefreshState,
    remediationRefreshNeeded: remediationView.remediationRefreshNeeded,
    remediationRefreshStale: remediationView.remediationRefreshStale,
    remediationRefreshReason: remediationView.remediationRefreshReason,
    remediationRefreshCommand: remediationView.remediationRefreshCommand,
    remediationCommands: remediationView.remediationCommands,
    remediationActionReportCommand: remediationView.remediationActionReportCommand,
    remediationActionHistoryCommand: remediationView.remediationActionHistoryCommand,
    remediationActionRefreshCommand: remediationView.remediationActionRefreshCommand,
    remediationActionHygieneCommand: remediationView.remediationActionHygieneCommand,
    remediationActionNormalizeDryRunCommand: remediationView.remediationActionNormalizeDryRunCommand,
    remediationActionNormalizeApplyCommand: remediationView.remediationActionNormalizeApplyCommand,
    remediationActionRetireDryRunCommand: remediationView.remediationActionRetireDryRunCommand,
    remediationActionRetireApplyCommand: remediationView.remediationActionRetireApplyCommand,
    remediationReportCommand: remediationView.remediationReportCommand,
    remediationHistoryCommand: remediationView.remediationHistoryCommand,
    remediationNormalizeDryRunCommand: remediationView.remediationNormalizeDryRunCommand,
    remediationNormalizeApplyCommand: remediationView.remediationNormalizeApplyCommand,
    remediationRetireDryRunCommand: remediationView.remediationRetireDryRunCommand,
    remediationRetireApplyCommand: remediationView.remediationRetireApplyCommand,
    remediationNextCommand: remediationView.remediationNextCommand,
    remediationNextCommandTransition: remediationView.remediationNextCommandTransition,
    remediationNextCommandChanged: remediationView.remediationNextCommandChanged,
    remediationNextCommandPrevious: remediationView.remediationNextCommandPrevious,
    remediationNextCommandCurrent: remediationView.remediationNextCommandCurrent,
    hygieneRemediationPlan,
    feedback,
    message,
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => {
      const dateKst = parseArg('date', new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }));
      const dryRun = process.argv.includes('--dry-run');
      const market = parseArg('market', 'all');
      return runDailyTradeFeedback({ dateKst, dryRun, market });
    },
    onSuccess: async (result) => {
      if (process.argv.includes('--json')) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(result.message);
      }
    },
    errorPrefix: '❌ 일일 피드백 오류:',
  });
}

export {
  buildDailyFeedback,
  buildDailyStats,
  buildTelegramMessage,
  fetchDailyAnalystAccuracy,
  fetchDailyTrades,
  runDailyTradeFeedback,
  buildPositionStrategyHygieneRemediationPlan,
};
