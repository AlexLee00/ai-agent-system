#!/usr/bin/env node
// @ts-nocheck
'use strict';

const env = require('../../../packages/core/lib/env');
const path = require('path');
const { buildMarketingDigest } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/marketing-digest.ts'));

const json = process.argv.includes('--json');

function formatText(digest = {}) {
  const lines = [
    '📣 블로그 마케팅 Digest',
    `상태: ${digest?.health?.status || 'unknown'}`,
    `사유: ${digest?.health?.reason || '없음'}`,
    '',
    '[Sense]',
    `- signals: ${digest?.senseSummary?.signalCount ?? 0}`,
    `- top signal: ${digest?.senseSummary?.topSignal?.message || '없음'}`,
    `- revenue trend: ${digest?.senseSummary?.revenueTrend || 'unknown'}`,
    '',
    '[Revenue Correlation]',
    `- impact pct: ${((Number(digest?.revenueCorrelation?.revenueImpactPct || 0)) * 100).toFixed(1)}%`,
    `- active avg revenue: ${Number(digest?.revenueCorrelation?.activeDay?.avgRevenue || 0).toLocaleString('ko-KR')}`,
    `- inactive avg revenue: ${Number(digest?.revenueCorrelation?.inactiveDay?.avgRevenue || 0).toLocaleString('ko-KR')}`,
    '',
    '[Content Diagnosis]',
    `- post count: ${digest?.diagnosis?.postCount ?? 0}`,
    `- weakness: ${digest?.diagnosis?.primaryWeakness?.message || '없음'}`,
    '',
    '[Snapshot Trend]',
    `- snapshots: ${digest?.snapshotTrend?.totalCount ?? 0}`,
    `- ok/watch: ${digest?.snapshotTrend?.okCount ?? 0}/${digest?.snapshotTrend?.watchCount ?? 0}`,
    `- avg signals: ${Number(digest?.snapshotTrend?.avgSignalCount || 0).toFixed(1)}`,
    `- avg impact: ${((Number(digest?.snapshotTrend?.avgRevenueImpactPct || 0)) * 100).toFixed(1)}%`,
    '',
    '[Autonomy]',
    `- decisions: ${digest?.autonomySummary?.totalCount ?? 0}`,
    `- auto publish: ${digest?.autonomySummary?.autoPublishCount ?? 0}`,
    `- latest: ${digest?.autonomySummary?.latestDecision?.decision || '없음'}`,
  ];

  const recommendations = Array.isArray(digest?.recommendations) ? digest.recommendations : [];
  if (recommendations.length) {
    lines.push('', '[Recommendations]');
    recommendations.slice(0, 3).forEach((item) => lines.push(`- ${item}`));
  }

  return lines.join('\n');
}

async function main() {
  const digest = await buildMarketingDigest();
  if (json) {
    console.log(JSON.stringify(digest, null, 2));
    return;
  }
  console.log(formatText(digest));
}

main().catch((error) => {
  console.error('[marketing-digest] 실패:', error.message);
  process.exit(1);
});
