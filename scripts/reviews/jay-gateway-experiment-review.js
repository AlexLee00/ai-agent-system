#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  const inputArg = argv.find((arg) => arg.startsWith('--input='));
  const days = Math.max(1, Number(daysArg?.split('=')[1] || 7));
  return {
    days,
    json: argv.includes('--json'),
    inputPath: inputArg?.split('=').slice(1).join('=') || path.join(os.homedir(), '.openclaw', 'workspace', 'jay-gateway-experiments.jsonl'),
  };
}

function safeReadSnapshots(inputPath) {
  if (!fs.existsSync(inputPath)) return [];
  return fs.readFileSync(inputPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function filterByDays(rows, days) {
  const minTs = Date.now() - (days * 24 * 60 * 60 * 1000);
  return rows.filter((row) => {
    const ts = new Date(row.capturedAt || 0).getTime();
    return Number.isFinite(ts) && ts >= minTs;
  });
}

function average(values) {
  if (!values.length) return null;
  return Number((values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length).toFixed(2));
}

function buildReview(rows, days, inputPath) {
  const filtered = filterByDays(rows, days).sort((a, b) => {
    return new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime();
  });
  const latest = filtered[filtered.length - 1] || null;
  const stageCounts = filtered.reduce((acc, row) => {
    const key = row.experimentStage || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const rateLimitCounts = filtered.map((row) => Number(row.gatewayMetrics?.rateLimitCount || 0));
  const activeRateLimitCounts = filtered.map((row) => Number(row.gatewayMetrics?.activeRateLimitCount || 0));
  const failoverCounts = filtered.map((row) => Number(row.gatewayMetrics?.failoverErrorCount || 0));
  const healthLevels = filtered.map((row) => row.orchestratorHealth?.decision?.level).filter(Boolean);
  const activeSnapshots = filtered.filter((row) => Number(row.gatewayMetrics?.activeRateLimitCount || 0) > 0).length;

  let recommendation = 'hold';
  let reason = '최근 스냅샷 기준 정합성과 활성 오류가 안정 구간입니다.';
  if (latest && latest.primaryCheck && latest.primaryCheck.aligned === false) {
    recommendation = 'sync_first';
    reason = '최신 스냅샷에서 runtime_config와 openclaw.json primary가 불일치합니다.';
  } else if (activeSnapshots > 0 || stageCounts.compare > 0) {
    recommendation = 'compare';
    reason = '최근 스냅샷에서 활성 rate limit 또는 compare 단계가 관찰되어 후보 비교가 필요합니다.';
  }

  return {
    inputPath,
    periodDays: days,
    snapshotCount: filtered.length,
    latestSnapshot: latest
      ? {
          capturedAt: latest.capturedAt,
          experimentStage: latest.experimentStage,
          runtimePrimary: latest.primaryCheck?.runtimePrimary || null,
          openclawPrimary: latest.primaryCheck?.openclawPrimary || null,
          aligned: latest.primaryCheck?.aligned ?? null,
          rateLimitCount: Number(latest.gatewayMetrics?.rateLimitCount || 0),
          activeRateLimitCount: Number(latest.gatewayMetrics?.activeRateLimitCount || 0),
          lastRateLimitAt: latest.gatewayMetrics?.lastRateLimitAt || null,
          orchestratorHealthLevel: latest.orchestratorHealth?.decision?.level || null,
        }
      : null,
    stageCounts,
    summary: {
      avgRateLimitCount: average(rateLimitCounts),
      avgActiveRateLimitCount: average(activeRateLimitCounts),
      avgFailoverErrorCount: average(failoverCounts),
      activeSnapshotCount: activeSnapshots,
      latestHealthLevel: healthLevels[healthLevels.length - 1] || null,
    },
    recommendation: {
      action: recommendation,
      reason,
    },
  };
}

function printHuman(review) {
  const lines = [];
  lines.push(`📘 제이 gateway 실험 리뷰 (${review.periodDays}일)`);
  lines.push('');
  lines.push(`스냅샷 수: ${review.snapshotCount}`);
  lines.push(`입력 파일: ${review.inputPath}`);
  lines.push('');
  lines.push('권장 판단:');
  lines.push(`- ${review.recommendation.action}: ${review.recommendation.reason}`);
  lines.push('');

  if (review.latestSnapshot) {
    lines.push('최신 스냅샷:');
    lines.push(`- 시각: ${review.latestSnapshot.capturedAt}`);
    lines.push(`- 단계: ${review.latestSnapshot.experimentStage}`);
    lines.push(`- primary: ${review.latestSnapshot.runtimePrimary} / ${review.latestSnapshot.openclawPrimary}`);
    lines.push(`- 정합성: ${review.latestSnapshot.aligned ? '일치' : '불일치'}`);
    lines.push(`- rate limit: ${review.latestSnapshot.rateLimitCount}건 (활성 ${review.latestSnapshot.activeRateLimitCount}건)`);
    lines.push(`- 마지막 rate limit: ${review.latestSnapshot.lastRateLimitAt || '없음'}`);
    lines.push(`- health: ${review.latestSnapshot.orchestratorHealthLevel || '확인 불가'}`);
    lines.push('');
  }

  lines.push('요약:');
  lines.push(`- 단계 분포: ${Object.entries(review.stageCounts).map(([key, value]) => `${key} ${value}`).join(', ') || '없음'}`);
  lines.push(`- 평균 rate limit: ${review.summary.avgRateLimitCount ?? 0}건`);
  lines.push(`- 평균 활성 rate limit: ${review.summary.avgActiveRateLimitCount ?? 0}건`);
  lines.push(`- 평균 failover error: ${review.summary.avgFailoverErrorCount ?? 0}건`);
  lines.push(`- 활성 스냅샷 수: ${review.summary.activeSnapshotCount}`);

  return lines.join('\n');
}

function main() {
  const { days, json, inputPath } = parseArgs();
  const review = buildReview(safeReadSnapshots(inputPath), days, inputPath);
  if (json) {
    process.stdout.write(`${JSON.stringify(review, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${printHuman(review)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`❌ jay-gateway-experiment-review 실패: ${error?.stack || error?.message || String(error)}\n`);
    process.exit(1);
  }
}

module.exports = {
  parseArgs,
  safeReadSnapshots,
  buildReview,
  printHuman,
};
