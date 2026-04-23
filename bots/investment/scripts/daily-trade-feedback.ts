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
  const { createAgentMemory } = require('../../../packages/core/lib/agent-memory.ts');
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

async function fetchDailyTrades(dateKst) {
  try {
    return await db.query(`
      SELECT
        trade_id, symbol, exchange, direction, is_paper,
        COALESCE(trade_mode, 'normal') AS trade_mode,
        pnl_net, pnl_percent, exit_reason, exit_time
      FROM trade_journal
      WHERE CAST(to_timestamp(exit_time / 1000.0) AT TIME ZONE 'Asia/Seoul' AS DATE) = $1::date
        AND status IN ('closed', 'tp_hit', 'sl_hit', 'force_exit')
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
  const decision = positionStrategyRemediationSummary.decision || {};
  return `🧯 remediation: ${decision.status || 'unknown'} | ${decision.headline || 'n/a'}`;
}

function buildPositionStrategyRemediationCommandLine(positionStrategyRemediationSummary) {
  if (!positionStrategyRemediationSummary || positionStrategyRemediationSummary.error || !positionStrategyRemediationSummary.ok) return null;
  const remediationPlan = positionStrategyRemediationSummary.remediationPlan || null;
  const remediationActions = positionStrategyRemediationSummary.remediationActions || null;
  if (!remediationPlan || remediationPlan.status !== 'position_strategy_hygiene_attention') return null;
  return `🛠️ remediation report: ${remediationActions?.reportCommand || remediationPlan.remediationReportCommand || 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-strategy-remediation -- --json'}`;
}

function buildPositionStrategyRemediationRefreshCommandLine(positionStrategyRemediationSummary) {
  if (!positionStrategyRemediationSummary || positionStrategyRemediationSummary.error || !positionStrategyRemediationSummary.ok) return null;
  const remediationPlan = positionStrategyRemediationSummary.remediationPlan || null;
  const remediationActions = positionStrategyRemediationSummary.remediationActions || null;
  const refreshCommand = remediationActions?.refreshCommand
    || positionStrategyRemediationSummary?.remediationRefreshState?.command
    || remediationPlan?.remediationRefreshCommand
    || null;
  if (!refreshCommand) return null;
  return `♻️ remediation refresh: ${refreshCommand}`;
}

function buildPositionStrategyRemediationNextCommandLine(positionStrategyRemediationSummary) {
  if (!positionStrategyRemediationSummary || positionStrategyRemediationSummary.error || !positionStrategyRemediationSummary.ok) return null;
  const nextCommand = positionStrategyRemediationSummary?.remediationActions?.nextCommand || null;
  if (!nextCommand) return null;
  return `🧭 remediation next: ${nextCommand}`;
}

function buildPositionStrategyRemediationRefreshLine(positionStrategyRemediationSummary) {
  if (!positionStrategyRemediationSummary || positionStrategyRemediationSummary.error || !positionStrategyRemediationSummary.ok) return null;
  const refreshState = positionStrategyRemediationSummary?.remediationRefreshState
    || buildPositionStrategyRemediationRefreshState(
      positionStrategyRemediationSummary?.remediationPlan || null,
      positionStrategyRemediationSummary?.remediationHistory || null,
    );
  return refreshState?.reason ? `♻️ ${refreshState.reason}` : null;
}

function buildPositionStrategyRemediationRefreshStateLine(positionStrategyRemediationSummary) {
  if (!positionStrategyRemediationSummary || positionStrategyRemediationSummary.error || !positionStrategyRemediationSummary.ok) return null;
  const refreshState = positionStrategyRemediationSummary?.remediationRefreshState
    || buildPositionStrategyRemediationRefreshState(
      positionStrategyRemediationSummary?.remediationPlan || null,
      positionStrategyRemediationSummary?.remediationHistory || null,
    );
  return `♻️ refresh state: needed ${refreshState?.needed ? 'yes' : 'no'} | stale ${refreshState?.stale ? 'yes' : 'no'} | command ${refreshState?.command || 'n/a'}`;
}

function buildPositionStrategyRemediationHistoryLine(positionStrategyRemediationHistorySummary) {
  if (!positionStrategyRemediationHistorySummary || positionStrategyRemediationHistorySummary.error || !positionStrategyRemediationHistorySummary.ok) return null;
  return `🗂️ remediation history: count ${positionStrategyRemediationHistorySummary.historyCount || 0} | changed ${positionStrategyRemediationHistorySummary.statusChanged ? 'yes' : 'no'} | next changed ${positionStrategyRemediationHistorySummary.nextCommandChanged ? 'yes' : 'no'} | age ${positionStrategyRemediationHistorySummary.ageMinutes ?? 'n/a'}m | stale ${positionStrategyRemediationHistorySummary.stale ? 'yes' : 'no'} | duplicate ${positionStrategyRemediationHistorySummary.delta?.duplicateManaged >= 0 ? '+' : ''}${positionStrategyRemediationHistorySummary.delta?.duplicateManaged || 0} | orphan ${positionStrategyRemediationHistorySummary.delta?.orphanProfiles >= 0 ? '+' : ''}${positionStrategyRemediationHistorySummary.delta?.orphanProfiles || 0}`;
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

function buildTelegramMessage(dateKst, feedback, analystAccuracy, screeningSummary, reevaluationSummary, minOrderPressureSummary, learningLoopSummary, positionStrategyAuditSummary, positionStrategyHygieneSummary, positionStrategyRemediationSummary, positionStrategyRemediationHistorySummary) {
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
  const minOrderPressureLine = buildMinOrderPressureLine(minOrderPressureSummary);
  if (minOrderPressureLine) lines.push(minOrderPressureLine);
  const learningLoopLine = buildLearningLoopLine(learningLoopSummary);
  if (learningLoopLine) lines.push(learningLoopLine);
  const positionStrategyCoverageLine = buildPositionStrategyCoverageLine(positionStrategyAuditSummary);
  if (positionStrategyCoverageLine) lines.push(positionStrategyCoverageLine);
  const positionStrategyHygieneLine = buildPositionStrategyHygieneLine(positionStrategyHygieneSummary);
  if (positionStrategyHygieneLine) lines.push(positionStrategyHygieneLine);
  const positionStrategyRemediationLine = buildPositionStrategyRemediationLine(positionStrategyRemediationSummary);
  if (positionStrategyRemediationLine) lines.push(positionStrategyRemediationLine);
  const positionStrategyRemediationHistoryLine = buildPositionStrategyRemediationHistoryLine(positionStrategyRemediationHistorySummary);
  if (positionStrategyRemediationHistoryLine) lines.push(positionStrategyRemediationHistoryLine);
  const positionStrategyRemediationRefreshStateLine = buildPositionStrategyRemediationRefreshStateLine(positionStrategyRemediationSummary);
  if (positionStrategyRemediationRefreshStateLine) lines.push(positionStrategyRemediationRefreshStateLine);
  const positionStrategyRemediationRefreshLine = buildPositionStrategyRemediationRefreshLine(positionStrategyRemediationSummary);
  if (positionStrategyRemediationRefreshLine) lines.push(positionStrategyRemediationRefreshLine);
  const positionStrategyRemediationRefreshCommandLine = buildPositionStrategyRemediationRefreshCommandLine(positionStrategyRemediationSummary);
  if (positionStrategyRemediationRefreshCommandLine) lines.push(positionStrategyRemediationRefreshCommandLine);
  const positionStrategyRemediationNextCommandLine = buildPositionStrategyRemediationNextCommandLine(positionStrategyRemediationSummary);
  if (positionStrategyRemediationNextCommandLine) lines.push(positionStrategyRemediationNextCommandLine);
  const positionStrategyRemediationCommandLine = buildPositionStrategyRemediationCommandLine(positionStrategyRemediationSummary);
  if (positionStrategyRemediationCommandLine) lines.push(positionStrategyRemediationCommandLine);
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

async function storeDailyFeedbackRag(dateKst, feedback, analystAccuracy, screeningSummary, reevaluationSummary, minOrderPressureSummary, learningLoopSummary, positionStrategyAuditSummary, positionStrategyHygieneSummary, positionStrategyRemediationSummary, positionStrategyRemediationHistorySummary) {
  const hygieneRemediationPlan = positionStrategyHygieneSummary?.remediationPlan
    || buildPositionStrategyHygieneRemediationPlan(positionStrategyHygieneSummary);
  const remediationRefreshState = buildPositionStrategyRemediationRefreshState(
    positionStrategyRemediationSummary?.remediationPlan || null,
    positionStrategyRemediationHistorySummary,
  );
  const content = [
    `[일일 피드백 ${dateKst}] ${feedback.summary}`,
    `거래 ${feedback.stats.total}건 / 승률 ${(feedback.stats.winRate * 100).toFixed(1)}% / 손익 $${feedback.stats.totalPnl.toFixed(2)}`,
    buildScreeningLine(screeningSummary),
    buildPositionReevaluationLine(reevaluationSummary),
    buildMinOrderPressureLine(minOrderPressureSummary),
    buildLearningLoopLine(learningLoopSummary),
    buildPositionStrategyCoverageLine(positionStrategyAuditSummary),
    buildPositionStrategyHygieneLine(positionStrategyHygieneSummary),
    buildPositionStrategyRemediationLine(positionStrategyRemediationSummary),
    buildPositionStrategyRemediationHistoryLine(positionStrategyRemediationHistorySummary),
    buildPositionStrategyRemediationRefreshStateLine(positionStrategyRemediationSummary),
    buildPositionStrategyRemediationRefreshLine(positionStrategyRemediationSummary),
    buildPositionStrategyRemediationRefreshCommandLine(positionStrategyRemediationSummary),
    buildPositionStrategyRemediationNextCommandLine(positionStrategyRemediationSummary),
    buildPositionStrategyRemediationCommandLine(positionStrategyRemediationSummary),
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
    min_order_pressure_summary: minOrderPressureSummary?.decision || {},
    learning_loop_summary: learningLoopSummary?.decision || {},
    position_strategy_audit: positionStrategyAuditSummary || {},
    position_strategy_hygiene: positionStrategyHygieneSummary || {},
    position_strategy_remediation: positionStrategyRemediationSummary || {},
    position_strategy_remediation_history: positionStrategyRemediationHistorySummary || {},
    position_strategy_remediation_refresh: remediationRefreshState,
    position_strategy_hygiene_remediation: hygieneRemediationPlan || {},
    position_strategy_hygiene_recommended_exchange: positionStrategyHygieneSummary?.recommendedExchange?.exchange || null,
    position_strategy_hygiene_recommended_count: Number(positionStrategyHygieneSummary?.recommendedExchange?.count || 0),
  }, 'luna');
}

async function runDailyTradeFeedback({ dateKst, dryRun = false }) {
  const trades = await fetchDailyTrades(dateKst);
  const analystAccuracy = await fetchDailyAnalystAccuracy(dateKst);
  const screeningSummary = await fetchScreeningSummary();
  const reevaluationSummary = await fetchPositionReevaluationSummary();
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
  const feedback = await buildDailyFeedback(dateKst, trades, analystAccuracy);
  const hygieneRemediationPlan = positionStrategyHygieneSummary?.remediationPlan
    || buildPositionStrategyHygieneRemediationPlan(positionStrategyHygieneSummary);
  const remediationRefreshState = buildPositionStrategyRemediationRefreshState(
    positionStrategyRemediationSummary?.remediationPlan || null,
    positionStrategyRemediationHistorySummary,
  );
  const message = buildTelegramMessage(dateKst, feedback, analystAccuracy, screeningSummary, reevaluationSummary, minOrderPressureSummary, learningLoopSummary, positionStrategyAuditSummary, positionStrategyHygieneSummary, positionStrategyRemediationSummary, positionStrategyRemediationHistorySummary);

  try {
    await storeDailyFeedbackRag(dateKst, feedback, analystAccuracy, screeningSummary, reevaluationSummary, minOrderPressureSummary, learningLoopSummary, positionStrategyAuditSummary, positionStrategyHygieneSummary, positionStrategyRemediationSummary, positionStrategyRemediationHistorySummary);
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
        payload: { dateKst, feedback, analystAccuracy, screeningSummary, reevaluationSummary, minOrderPressureSummary, learningLoopSummary, positionStrategyAuditSummary, positionStrategyHygieneSummary, positionStrategyRemediationSummary, positionStrategyRemediationHistorySummary, remediationRefreshState, remediationActions: positionStrategyRemediationSummary?.remediationActions || null, hygieneRemediationPlan },
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
          hygieneStatus: hygieneRemediationPlan?.status || null,
          hygieneExchange: hygieneRemediationPlan?.recommendedExchange || null,
          remediationRefreshNeeded: remediationRefreshState.needed,
          remediationRefreshStale: remediationRefreshState.stale,
          remediationRefreshCommand: remediationRefreshState.command,
          remediationReportCommand: hygieneRemediationPlan?.remediationReportCommand || null,
          remediationNextCommand: positionStrategyRemediationSummary?.remediationActions?.nextCommand || null,
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
    minOrderPressureSummary,
    learningLoopSummary,
    positionStrategyAuditSummary,
    positionStrategyHygieneSummary,
    positionStrategyRemediationSummary,
    positionStrategyRemediationHistorySummary,
    remediationRefreshState,
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
      return runDailyTradeFeedback({ dateKst, dryRun });
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
