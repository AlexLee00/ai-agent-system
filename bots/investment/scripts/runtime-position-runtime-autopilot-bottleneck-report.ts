#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  DEFAULT_POSITION_RUNTIME_AUTOPILOT_HISTORY_FILE,
  readPositionRuntimeAutopilotHistoryLines,
} from './runtime-position-runtime-autopilot-history-store.ts';
import { publishAlert } from '../shared/alert-publisher.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    json: false,
    telegram: false,
    hours: 24,
    file: DEFAULT_POSITION_RUNTIME_AUTOPILOT_HISTORY_FILE,
  };
  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw === '--telegram') args.telegram = true;
    else if (raw.startsWith('--hours=')) args.hours = Math.max(1, Number(raw.split('=').slice(1).join('=') || 24));
    else if (raw.startsWith('--file=')) args.file = raw.split('=').slice(1).join('=') || args.file;
  }
  return args;
}

function increment(map, key, amount = 1) {
  const normalized = String(key || 'unknown');
  map[normalized] = (map[normalized] || 0) + amount;
}

function isStaleCandidateStatus(status = null) {
  return String(status || '').trim() === 'candidate_not_found';
}

function rowHardFailureCount(row = {}) {
  if (Array.isArray(row?.dispatchFailures)) {
    return row.dispatchFailures
      .filter((failure) => !isStaleCandidateStatus(failure?.status))
      .length;
  }
  return Math.max(0, Number(row?.dispatchFailureCount || 0));
}

function buildRecentCleanWindow(rows = [], minCleanSamples = 3) {
  const required = Math.max(1, Number(minCleanSamples || 3));
  let cleanStreak = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rowHardFailureCount(rows[i]) > 0) break;
    cleanStreak++;
  }
  const recentRows = rows.slice(-required);
  const recentHardFailures = recentRows.reduce((sum, row) => sum + rowHardFailureCount(row), 0);
  return {
    requiredCleanSamples: required,
    cleanStreakSamples: cleanStreak,
    recentSampleCount: recentRows.length,
    recentHardFailureCount: recentHardFailures,
    recovered: rows.length > 0 && cleanStreak >= Math.min(required, rows.length) && recentHardFailures === 0,
  };
}

function recentHistory(file, hours) {
  const cutoff = Date.now() - (Math.max(1, Number(hours || 24)) * 3600 * 1000);
  return readPositionRuntimeAutopilotHistoryLines(file)
    .filter((row) => {
      const ts = new Date(row?.recordedAt || 0).getTime();
      return Number.isFinite(ts) && ts >= cutoff;
    });
}

export function buildAutopilotBottleneckReport({
  file = DEFAULT_POSITION_RUNTIME_AUTOPILOT_HISTORY_FILE,
  hours = 24,
  minCleanSamples = Number(process.env.LUNA_MAPEK_CLEAN_STREAK_SAMPLES || 3),
} = {}) {
  const rows = recentHistory(file, hours);
  const statusCounts = {};
  const failureStatusCounts = {};
  const staleCandidateSymbols = {};
  const hardFailureSymbols = {};
  const queueWaitingCounts = {};
  let dispatchCandidateCount = 0;
  let dispatchExecutedCount = 0;
  let dispatchQueuedCount = 0;
  let dispatchRetryingCount = 0;
  let dispatchSkippedCount = 0;
  let dispatchFailureCount = 0;
  let staleCandidateCount = 0;
  let hardFailureCount = 0;
  let latest = rows[rows.length - 1] || null;

  for (const row of rows) {
    increment(statusCounts, row?.status || 'unknown');
    dispatchCandidateCount += Number(row?.dispatchCandidateCount || 0);
    dispatchExecutedCount += Number(row?.dispatchExecutedCount || 0);
    dispatchQueuedCount += Number(row?.dispatchQueuedCount || 0);
    dispatchRetryingCount += Number(row?.dispatchRetryingCount || 0);
    dispatchSkippedCount += Number(row?.dispatchSkippedCount || 0);
    dispatchFailureCount += Number(row?.dispatchFailureCount || 0);
    const marketQueue = row?.dispatchMarketQueue || {};
    if (marketQueue.waitingMarketOpen > 0) {
      increment(queueWaitingCounts, 'waiting_market_open', Number(marketQueue.waitingMarketOpen || 0));
    }
    for (const skipped of row?.dispatchSkipped || []) {
      if (skipped?.status === 'candidate_not_found') {
        staleCandidateCount += 1;
        increment(staleCandidateSymbols, `${skipped.exchange || 'unknown'}:${skipped.symbol || 'unknown'}`);
      }
    }
    for (const failure of row?.dispatchFailures || []) {
      const status = String(failure?.status || 'failed');
      increment(failureStatusCounts, status);
      if (status === 'candidate_not_found') {
        staleCandidateCount += 1;
        increment(staleCandidateSymbols, `${failure.exchange || 'unknown'}:${failure.symbol || 'unknown'}`);
      } else {
        hardFailureCount += 1;
        increment(hardFailureSymbols, `${failure.exchange || 'unknown'}:${failure.symbol || 'unknown'}`);
      }
    }
  }

  const cleanWindow = buildRecentCleanWindow(rows, minCleanSamples);
  const historicalHardFailureCount = hardFailureCount;
  hardFailureCount = cleanWindow.recentHardFailureCount;

  const recommendations = [];
  if (staleCandidateCount > 0) {
    recommendations.push('candidate_not_found는 stale candidate no-op으로 관찰하되, canary 차단 조건에서는 제외한다.');
  }
  if (hardFailureCount > 0) {
    recommendations.push('hard dispatch failure가 남아 있으므로 child runner stdout/stderr를 우선 점검한다.');
  } else if (historicalHardFailureCount > 0 && cleanWindow.recovered) {
    recommendations.push(`최근 ${cleanWindow.cleanStreakSamples}개 autopilot 샘플은 hard failure 없이 회복됐습니다.`);
  }
  if ((queueWaitingCounts.waiting_market_open || 0) > 0) {
    recommendations.push('KIS 장외 대기 queue는 오류가 아니라 market-open queue로 관찰한다.');
  }
  if (rows.length === 0) {
    recommendations.push('최근 autopilot history가 없어 launchd/runtime-autopilot 가동 상태를 확인한다.');
  }

  return {
    ok: hardFailureCount === 0 && (rows.length === 0 || cleanWindow.recovered || historicalHardFailureCount === 0),
    checkedAt: new Date().toISOString(),
    file,
    hours,
    sampleCount: rows.length,
    latestRecordedAt: latest?.recordedAt || null,
    latestStatus: latest?.status || null,
    statusCounts,
    dispatch: {
      candidateCount: dispatchCandidateCount,
      executedCount: dispatchExecutedCount,
      queuedCount: dispatchQueuedCount,
      retryingCount: dispatchRetryingCount,
      skippedCount: dispatchSkippedCount,
      failureCount: dispatchFailureCount,
      staleCandidateCount,
      hardFailureCount,
      historicalHardFailureCount,
      cleanStreakSamples: cleanWindow.cleanStreakSamples,
      requiredCleanSamples: cleanWindow.requiredCleanSamples,
      recentHardFailureCount: cleanWindow.recentHardFailureCount,
      failureStatusCounts,
      staleCandidateSymbols,
      hardFailureSymbols,
      queueWaitingCounts,
    },
    recommendations,
  };
}

export function renderAutopilotBottleneckReport(report = {}) {
  const dispatch = report.dispatch || {};
  return [
    '🚦 루나 runtime-autopilot 병목 리포트',
    `checkedAt: ${report.checkedAt || 'n/a'}`,
    `window: ${report.hours || 24}h / samples=${report.sampleCount || 0}`,
    `latest: ${report.latestRecordedAt || 'n/a'} / ${report.latestStatus || 'n/a'}`,
    `dispatch: candidates=${dispatch.candidateCount || 0} executed=${dispatch.executedCount || 0} queued=${dispatch.queuedCount || 0} retrying=${dispatch.retryingCount || 0} skipped=${dispatch.skippedCount || 0} hardFailures=${dispatch.hardFailureCount || 0} historicalHardFailures=${dispatch.historicalHardFailureCount || 0} cleanStreak=${dispatch.cleanStreakSamples || 0}/${dispatch.requiredCleanSamples || 0}`,
    `staleCandidate: ${dispatch.staleCandidateCount || 0}`,
    `recommendations: ${(report.recommendations || []).length ? report.recommendations.join(' / ') : 'none'}`,
  ].join('\n');
}

export async function publishAutopilotBottleneckReport(report = {}) {
  return publishAlert({
    from_bot: 'luna',
    event_type: 'report',
    alert_level: report.ok ? 1 : 2,
    message: renderAutopilotBottleneckReport(report),
    payload: {
      checkedAt: report.checkedAt,
      hours: report.hours,
      sampleCount: report.sampleCount,
      dispatch: report.dispatch,
      recommendations: report.recommendations || [],
    },
  });
}

async function main() {
  const args = parseArgs();
  const report = buildAutopilotBottleneckReport(args);
  if (args.telegram) await publishAutopilotBottleneckReport(report);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else if (!args.telegram) console.log(renderAutopilotBottleneckReport(report));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-position-runtime-autopilot-bottleneck 실패:',
  });
}
