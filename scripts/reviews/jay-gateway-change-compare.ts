// @ts-nocheck
'use strict';

const os = require('os');
const path = require('path');

const { safeReadSnapshots } = require('./jay-gateway-experiment-review.js');

const DEFAULT_WINDOW_HOURS = 24;

function getAiAgentHome() {
  return process.env.AI_AGENT_HOME || process.env.JAY_HOME || path.join(os.homedir(), '.ai-agent-system');
}

function getAiAgentWorkspace() {
  return process.env.AI_AGENT_WORKSPACE || process.env.JAY_WORKSPACE || path.join(getAiAgentHome(), 'workspace');
}

function parseArgs(argv = process.argv.slice(2)) {
  const pivotArg = argv.find((arg) => arg.startsWith('--pivot='));
  const beforeArg = argv.find((arg) => arg.startsWith('--before-hours='));
  const afterArg = argv.find((arg) => arg.startsWith('--after-hours='));
  const inputArg = argv.find((arg) => arg.startsWith('--input='));

  const pivotRaw = pivotArg?.split('=').slice(1).join('=') || '';
  const pivotTs = new Date(pivotRaw).getTime();
  if (!Number.isFinite(pivotTs)) {
    throw new Error('--pivot=ISO_TIMESTAMP is required');
  }

  return {
    pivotAt: new Date(pivotTs).toISOString(),
    pivotTs,
    beforeHours: Math.max(1, Number(beforeArg?.split('=')[1] || DEFAULT_WINDOW_HOURS)),
    afterHours: Math.max(1, Number(afterArg?.split('=')[1] || DEFAULT_WINDOW_HOURS)),
    inputPath: inputArg?.split('=').slice(1).join('=') || path.join(getAiAgentWorkspace(), 'jay-gateway-experiments.jsonl'),
    json: argv.includes('--json'),
  };
}

function average(values) {
  if (!values.length) return null;
  return Number((values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length).toFixed(2));
}

function countByStage(rows) {
  return rows.reduce((acc, row) => {
    const key = row.experimentStage || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function summarizeWindow(rows) {
  const rateLimitCounts = rows.map((row) => Number(row.gatewayMetrics?.rateLimitCount || 0));
  const activeRateLimitCounts = rows.map((row) => Number(row.gatewayMetrics?.activeRateLimitCount || 0));
  const failoverCounts = rows.map((row) => Number(row.gatewayMetrics?.failoverErrorCount || 0));
  const alignedCount = rows.filter((row) => row.primaryCheck?.aligned === true).length;
  const latest = rows[rows.length - 1] || null;

  return {
    snapshotCount: rows.length,
    stageCounts: countByStage(rows),
    avgRateLimitCount: average(rateLimitCounts),
    avgActiveRateLimitCount: average(activeRateLimitCounts),
    avgFailoverErrorCount: average(failoverCounts),
    alignedRate: rows.length ? Number(((alignedCount / rows.length) * 100).toFixed(1)) : null,
    latest: latest
      ? {
          capturedAt: latest.capturedAt,
          experimentStage: latest.experimentStage,
          runtimePrimary: latest.primaryCheck?.runtimePrimary || null,
          selectorPrimary: latest.primaryCheck?.selectorPrimary || null,
          aligned: latest.primaryCheck?.aligned ?? null,
          rateLimitCount: Number(latest.gatewayMetrics?.rateLimitCount || 0),
          activeRateLimitCount: Number(latest.gatewayMetrics?.activeRateLimitCount || 0),
          failoverErrorCount: Number(latest.gatewayMetrics?.failoverErrorCount || 0),
        }
      : null,
  };
}

function diffMetric(before, after) {
  if (before == null || after == null) return null;
  return Number((Number(after) - Number(before)).toFixed(2));
}

function buildComparison(rows, options) {
  const sorted = rows
    .filter((row) => Number.isFinite(new Date(row.capturedAt || 0).getTime()))
    .sort((a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime());

  const beforeMin = options.pivotTs - (options.beforeHours * 60 * 60 * 1000);
  const afterMax = options.pivotTs + (options.afterHours * 60 * 60 * 1000);

  const beforeRows = sorted.filter((row) => {
    const ts = new Date(row.capturedAt).getTime();
    return ts >= beforeMin && ts < options.pivotTs;
  });
  const afterRows = sorted.filter((row) => {
    const ts = new Date(row.capturedAt).getTime();
    return ts >= options.pivotTs && ts <= afterMax;
  });

  const beforeSummary = summarizeWindow(beforeRows);
  const afterSummary = summarizeWindow(afterRows);

  const deltas = {
    rateLimitDelta: diffMetric(beforeSummary.avgRateLimitCount, afterSummary.avgRateLimitCount),
    activeRateLimitDelta: diffMetric(beforeSummary.avgActiveRateLimitCount, afterSummary.avgActiveRateLimitCount),
    failoverErrorDelta: diffMetric(beforeSummary.avgFailoverErrorCount, afterSummary.avgFailoverErrorCount),
    alignedRateDelta: diffMetric(beforeSummary.alignedRate, afterSummary.alignedRate),
  };

  let verdict = 'neutral';
  let reason = '전환 전후 차이가 뚜렷하지 않습니다.';
  const improvedRateLimit = deltas.rateLimitDelta != null && deltas.rateLimitDelta < 0;
  const improvedActive = deltas.activeRateLimitDelta != null && deltas.activeRateLimitDelta <= 0;
  const improvedFailover = deltas.failoverErrorDelta != null && deltas.failoverErrorDelta < 0;
  const regressedRateLimit = deltas.rateLimitDelta != null && deltas.rateLimitDelta > 0;
  const regressedActive = deltas.activeRateLimitDelta != null && deltas.activeRateLimitDelta > 0;
  const regressedFailover = deltas.failoverErrorDelta != null && deltas.failoverErrorDelta > 0;

  if (improvedRateLimit && improvedActive && improvedFailover) {
    verdict = 'improved';
    reason = '전환 후 rate limit, 활성 rate limit, failover error가 모두 감소했습니다.';
  } else if (regressedRateLimit || regressedActive || regressedFailover) {
    verdict = 'regressed';
    reason = '전환 후 rate limit 또는 failover error가 증가했습니다.';
  }

  return {
    inputPath: options.inputPath,
    pivotAt: options.pivotAt,
    beforeHours: options.beforeHours,
    afterHours: options.afterHours,
    before: beforeSummary,
    after: afterSummary,
    deltas,
    verdict,
    reason,
  };
}

function printHuman(report) {
  const lines = [];
  lines.push('📘 제이 gateway 전환 전후 비교');
  lines.push('');
  lines.push(`기준 시각: ${report.pivotAt}`);
  lines.push(`입력 파일: ${report.inputPath}`);
  lines.push(`비교 창: 전 ${report.beforeHours}시간 / 후 ${report.afterHours}시간`);
  lines.push('');
  lines.push(`판정: ${report.verdict}`);
  lines.push(`- ${report.reason}`);
  lines.push('');
  lines.push('전(before):');
  lines.push(`- 스냅샷 수: ${report.before.snapshotCount}`);
  lines.push(`- 평균 rate limit: ${report.before.avgRateLimitCount ?? 0}`);
  lines.push(`- 평균 활성 rate limit: ${report.before.avgActiveRateLimitCount ?? 0}`);
  lines.push(`- 평균 failover error: ${report.before.avgFailoverErrorCount ?? 0}`);
  lines.push(`- 정합성 비율: ${report.before.alignedRate ?? 0}%`);
  lines.push('');
  lines.push('후(after):');
  lines.push(`- 스냅샷 수: ${report.after.snapshotCount}`);
  lines.push(`- 평균 rate limit: ${report.after.avgRateLimitCount ?? 0}`);
  lines.push(`- 평균 활성 rate limit: ${report.after.avgActiveRateLimitCount ?? 0}`);
  lines.push(`- 평균 failover error: ${report.after.avgFailoverErrorCount ?? 0}`);
  lines.push(`- 정합성 비율: ${report.after.alignedRate ?? 0}%`);
  lines.push('');
  lines.push('변화량(delta):');
  lines.push(`- rate limit: ${report.deltas.rateLimitDelta ?? 0}`);
  lines.push(`- 활성 rate limit: ${report.deltas.activeRateLimitDelta ?? 0}`);
  lines.push(`- failover error: ${report.deltas.failoverErrorDelta ?? 0}`);
  lines.push(`- 정합성 비율: ${report.deltas.alignedRateDelta ?? 0}%p`);
  return lines.join('\n');
}

function main() {
  const options = parseArgs();
  const rows = safeReadSnapshots(options.inputPath);
  const report = buildComparison(rows, options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${printHuman(report)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`❌ jay-gateway-change-compare 실패: ${error?.stack || error?.message || String(error)}\n`);
    process.exit(1);
  }
}

module.exports = {
  parseArgs,
  summarizeWindow,
  buildComparison,
  printHuman,
};
