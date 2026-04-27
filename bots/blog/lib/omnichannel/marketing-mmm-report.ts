// @ts-nocheck
'use strict';

/**
 * Lightweight MMM-style weekly report.
 *
 * This is not a full Robyn/causal model. It turns existing channel snapshots,
 * revenue correlation, and publish-source coverage into a conservative weekly
 * contribution view so L5 ops can act before enough data exists for real MMM.
 */

const { computeLowConfidenceDecay } = require('./revenue-attribution.ts');

function clamp(value, min = 0, max = 1) {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return min;
  return Math.max(min, Math.min(max, num));
}

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeMmmChannelRow(row = {}) {
  const channel = String(row.channel || row.platform || 'unknown').trim() || 'unknown';
  const source = String(row.source || row.sourceMode || '').trim() || null;
  const publishedCount = toNumber(row.publishedCount ?? row.published_count);
  const views = toNumber(row.views);
  const comments = toNumber(row.comments);
  const likes = toNumber(row.likes);
  const engagementRate = toNumber(row.engagementRate ?? row.engagement_rate);
  const revenueSignal = toNumber(row.revenueSignal ?? row.revenue_signal);
  const interactions = comments * 2 + likes;

  return {
    channel,
    source,
    status: String(row.status || 'unknown'),
    publishedCount,
    views,
    comments,
    likes,
    engagementRate,
    revenueSignal,
    interactions,
    metadata: row.metadata || {},
  };
}

function isAttentionChannelStatus(status = '') {
  const normalized = String(status || '').trim().toLowerCase();
  if (!normalized) return false;
  return !['ok', 'active', 'warming_up', 'unknown'].includes(normalized);
}

function computeMmmTotals(rows = []) {
  return rows.reduce((acc, row) => {
    acc.publishedCount += row.publishedCount;
    acc.views += row.views;
    acc.interactions += row.interactions;
    acc.revenueSignal += Math.max(0, row.revenueSignal);
    acc.watchCount += row.status === 'watch' ? 1 : 0;
    acc.attentionCount += isAttentionChannelStatus(row.status) ? 1 : 0;
    return acc;
  }, {
    publishedCount: 0,
    views: 0,
    interactions: 0,
    revenueSignal: 0,
    watchCount: 0,
    attentionCount: 0,
  });
}

function share(value, total) {
  const denom = toNumber(total);
  if (denom <= 0) return 0;
  return clamp(toNumber(value) / denom);
}

function scoreMmmChannel(row, totals) {
  const exposureShare = share(row.views, totals.views);
  const engagementShare = share(row.interactions, totals.interactions);
  const publishShare = share(row.publishedCount, totals.publishedCount);
  const revenueShare = share(Math.max(0, row.revenueSignal), totals.revenueSignal);
  const rawScore = exposureShare * 0.35
    + engagementShare * 0.35
    + publishShare * 0.15
    + revenueShare * 0.15;
  const attentionPenalty = isAttentionChannelStatus(row.status) ? 0.35 : 0;
  const contributionScore = clamp(rawScore - attentionPenalty);

  return {
    ...row,
    exposureShare: Number(exposureShare.toFixed(4)),
    engagementShare: Number(engagementShare.toFixed(4)),
    publishShare: Number(publishShare.toFixed(4)),
    revenueShare: Number(revenueShare.toFixed(4)),
    contributionScore: Number(contributionScore.toFixed(4)),
  };
}

function estimateMmmConfidence({ rows, digest }) {
  const channelRows = Array.isArray(rows) ? rows : [];
  const exposureRows = channelRows.filter((row) => row.views > 0 || row.interactions > 0);
  const publishedRows = channelRows.filter((row) => row.publishedCount > 0);
  const snapshotCount = toNumber(digest?.snapshotTrend?.totalCount);
  const autonomyCount = toNumber(digest?.autonomySummary?.totalCount);
  const revenueCorrelation = digest?.revenueCorrelation || {};
  const activeDayCount = toNumber(revenueCorrelation?.activeDay?.dayCount);
  const inactiveDayCount = toNumber(revenueCorrelation?.inactiveDay?.dayCount);

  const score = clamp(
    (exposureRows.length >= 2 ? 0.3 : exposureRows.length * 0.15)
      + clamp(publishedRows.length / 2) * 0.1
      + clamp(snapshotCount / 7) * 0.15
      + clamp(autonomyCount / 14) * 0.1
      + clamp(Math.min(activeDayCount, inactiveDayCount) / 5) * 0.25
      + (channelRows.some((row) => row.revenueSignal !== 0) ? 0.1 : 0),
  );

  return Number(score.toFixed(4));
}

function labelMmmConfidence(confidence) {
  if (confidence >= 0.75) return 'high';
  if (confidence >= 0.45) return 'medium';
  if (confidence > 0) return 'low';
  return 'warming_up';
}

function buildMmmRecommendations({ channels, confidence, digest, decayMultiplier }) {
  const recommendations = [];
  const topChannel = channels[0] || null;
  const attentionChannels = channels.filter((row) => isAttentionChannelStatus(row.status));
  const socialSources = digest?.socialPublishSources || {};

  if (confidence < 0.45) {
    recommendations.push('MMM 신뢰도가 낮아 예산/전략을 급격히 바꾸지 말고, 채널별 views/comments/revenue_signal 수집 커버리지를 먼저 올려야 합니다.');
  }

  if (attentionChannels.length > 0) {
    const names = attentionChannels.map((row) => `${row.channel}:${row.status}`).join(', ');
    recommendations.push(`${names} 채널은 권한/수집/발행 상태가 불안정해 기여 판단보다 복구가 우선입니다.`);
  }

  if (topChannel && topChannel.contributionScore > 0 && !isAttentionChannelStatus(topChannel.status)) {
    recommendations.push(`${topChannel.channel} 채널이 이번 주 추정 기여 1순위입니다. 같은 CTA와 훅을 유지하되 다음 발행에서 UTM/예약 전환 추적을 분리하세요.`);
  }

  if (toNumber(socialSources.strategyNativeCount) === 0 && toNumber(socialSources.naverPostCount) > 0) {
    recommendations.push('소셜 성과가 네이버 파생 중심입니다. strategy_native 인스타/페이스북을 소량이라도 분리 실행해 채널 독립 기여도를 쌓으세요.');
  }

  if (decayMultiplier < 1) {
    recommendations.push(`저신뢰 보정 multiplier ${decayMultiplier}가 적용됩니다. 자동 전략 변경 폭을 보수적으로 제한하세요.`);
  }

  if (!recommendations.length) {
    recommendations.push('채널 기여와 신뢰도가 안정적입니다. 현재 발행 믹스를 유지하면서 다음 주 표본을 계속 누적하세요.');
  }

  return recommendations;
}

function buildWeeklyMmmReport(digest = {}, options = {}) {
  const rows = (digest?.channelPerformance?.rows || []).map(normalizeMmmChannelRow);
  const totals = computeMmmTotals(rows);
  const channels = rows
    .map((row) => scoreMmmChannel(row, totals))
    .sort((a, b) => b.contributionScore - a.contributionScore || b.views - a.views);
  const confidence = estimateMmmConfidence({ rows, digest });
  const confidenceLabel = labelMmmConfidence(confidence);
  const decayMultiplier = computeLowConfidenceDecay(confidence, totals.watchCount + totals.attentionCount);
  const revenueImpactPct = toNumber(digest?.revenueCorrelation?.revenueImpactPct);

  return {
    generatedAt: options.generatedAt || new Date().toISOString(),
    windowDays: toNumber(options.windowDays, 7),
    model: 'mmm-lite-weekly-v1',
    confidence,
    confidenceLabel,
    decayMultiplier,
    revenueImpactPct,
    totals,
    channels,
    recommendations: buildMmmRecommendations({
      channels,
      confidence,
      digest,
      decayMultiplier,
    }),
    notes: [
      'This is a conservative MMM-lite heuristic, not a causal Robyn model.',
      'Use it for weekly routing and data-quality decisions until paid media and conversion samples are large enough.',
    ],
  };
}

function formatWeeklyMmmMarkdown(report = {}) {
  const lines = [
    '# Blog Weekly MMM-Lite Report',
    '',
    `- generatedAt: ${report.generatedAt || ''}`,
    `- model: ${report.model || 'mmm-lite-weekly-v1'}`,
    `- confidence: ${report.confidenceLabel || 'unknown'} (${report.confidence ?? 0})`,
    `- decayMultiplier: ${report.decayMultiplier ?? 1}`,
    `- revenueImpactPct: ${report.revenueImpactPct ?? 0}`,
    '',
    '## Channel Contribution',
  ];

  const channels = Array.isArray(report.channels) ? report.channels : [];
  if (!channels.length) {
    lines.push('- No channel snapshot rows yet.');
  } else {
    for (const row of channels) {
      lines.push(`- ${row.channel}: score=${row.contributionScore}, views=${row.views}, interactions=${row.interactions}, status=${row.status}`);
    }
  }

  lines.push('', '## Recommendations');
  for (const item of report.recommendations || []) {
    lines.push(`- ${item}`);
  }

  return `${lines.join('\n')}\n`;
}

module.exports = {
  normalizeMmmChannelRow,
  computeMmmTotals,
  isAttentionChannelStatus,
  scoreMmmChannel,
  estimateMmmConfidence,
  labelMmmConfidence,
  buildWeeklyMmmReport,
  formatWeeklyMmmMarkdown,
};
