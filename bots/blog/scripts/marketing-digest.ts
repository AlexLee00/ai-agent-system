#!/usr/bin/env node
// @ts-nocheck
'use strict';

const env = require('../../../packages/core/lib/env');
const path = require('path');
const { buildMarketingDigest } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/marketing-digest.ts'));
const { buildBlogCliInsight } = require('../lib/cli-insight.ts');

const json = process.argv.includes('--json');

function formatText(digest = {}) {
  const lines = [
    '📣 블로그 마케팅 Digest',
    digest?.aiSummary ? `🔍 AI: ${digest.aiSummary}` : null,
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
    '[Channel Performance]',
    `- latest date: ${digest?.channelPerformance?.latestDate || '없음'}`,
    `- channels: ${digest?.channelPerformance?.totalChannels ?? 0}`,
    `- active/watch: ${digest?.channelPerformance?.activeChannels ?? 0}/${digest?.channelPerformance?.watchChannels ?? 0}`,
    '',
    '[Autonomy]',
    `- decisions: ${digest?.autonomySummary?.totalCount ?? 0}`,
    `- auto publish: ${digest?.autonomySummary?.autoPublishCount ?? 0}`,
    `- latest: ${digest?.autonomySummary?.latestDecision?.decision || '없음'}`,
    '',
    '[Next General Preview]',
    `- category: ${digest?.nextGeneralPreview?.category || 'none'}`,
    `- pattern: ${digest?.nextGeneralPreview?.pattern || 'none'}`,
    `- predicted: ${digest?.nextGeneralPreview?.predictedAdoption || 'warming_up'}`,
    `- title: ${digest?.nextGeneralPreview?.title || 'none'}`,
  ];

  const channels = Array.isArray(digest?.channelPerformance?.rows) ? digest.channelPerformance.rows : [];
  channels.slice(0, 3).forEach((row) => {
  lines.push(`- ${row.channel}: ${row.status}, published ${row.publishedCount}, engagement ${Number(row.engagementRate || 0).toFixed(1)}`);
  });

  if (digest?.channelPerformance?.primaryWatchHint) {
    lines.push(`- primary watch: ${digest.channelPerformance.primaryWatchHint}`);
  }

  const recommendations = Array.isArray(digest?.recommendations) ? digest.recommendations : [];
  if (recommendations.length) {
    lines.push('', '[Recommendations]');
    recommendations.slice(0, 3).forEach((item) => lines.push(`- ${item}`));
  }

  return lines.filter(Boolean).join('\n');
}

function buildMarketingDigestFallback(digest = {}) {
  const status = digest?.health?.status || 'unknown';
  const topSignal = digest?.senseSummary?.topSignal?.message || '';
  const watchChannels = Number(digest?.channelPerformance?.watchChannels || 0);
  if (status === 'watch') {
    return `마케팅 상태가 watch라서 ${topSignal || '상위 신호'}와 watch 채널 ${watchChannels}개를 먼저 점검하는 편이 좋습니다.`;
  }
  return `마케팅 상태는 ${status}이며 상위 신호와 채널 추세를 기준으로 현재 운영 흐름은 비교적 안정적입니다.`;
}

async function main() {
  const digest = await buildMarketingDigest();
  digest.aiSummary = await buildBlogCliInsight({
    bot: 'marketing-digest',
    requestType: 'marketing-digest',
    title: '블로그 마케팅 digest 요약',
    data: {
      health: digest?.health,
      senseSummary: digest?.senseSummary,
      revenueCorrelation: digest?.revenueCorrelation,
      diagnosis: digest?.diagnosis,
      channelPerformance: digest?.channelPerformance,
      autonomySummary: digest?.autonomySummary,
      nextGeneralPreview: digest?.nextGeneralPreview,
    },
    fallback: buildMarketingDigestFallback(digest),
  });
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
