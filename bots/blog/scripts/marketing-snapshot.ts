#!/usr/bin/env node
// @ts-nocheck
'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');
const { buildMarketingDigest } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/marketing-digest.ts'));
const eventLake = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/event-lake.js'));
const { buildBlogCliInsight } = require('../lib/cli-insight.ts');

const json = process.argv.includes('--json');
const dryRun = process.argv.includes('--dry-run');

function buildPayload(digest = {}) {
  return {
    generatedAt: new Date().toISOString(),
    health: digest?.health || {},
    senseSummary: digest?.senseSummary || {},
    revenueCorrelation: digest?.revenueCorrelation || null,
    diagnosis: {
      periodDays: digest?.diagnosis?.periodDays || 0,
      postCount: digest?.diagnosis?.postCount || 0,
      primaryWeakness: digest?.diagnosis?.primaryWeakness || null,
      recommendations: Array.isArray(digest?.diagnosis?.recommendations) ? digest.diagnosis.recommendations : [],
      topCategories: Array.isArray(digest?.diagnosis?.byCategory) ? digest.diagnosis.byCategory.slice(0, 5) : [],
      topPatterns: Array.isArray(digest?.diagnosis?.byTitlePattern) ? digest.diagnosis.byTitlePattern.slice(0, 5) : [],
    },
    autonomySummary: digest?.autonomySummary || {},
    channelPerformance: digest?.channelPerformance || {},
    strategy: digest?.strategy || {},
    strategyAdoption: digest?.strategyAdoption || {},
    nextGeneralPreview: digest?.nextGeneralPreview || {},
    recommendations: Array.isArray(digest?.recommendations) ? digest.recommendations : [],
  };
}

function buildBrief(digest = {}) {
  const status = digest?.health?.status || 'unknown';
  const signals = Number(digest?.senseSummary?.signalCount || 0);
  const impactPct = ((Number(digest?.revenueCorrelation?.revenueImpactPct || 0)) * 100).toFixed(1);
  const autonomyCount = Number(digest?.autonomySummary?.totalCount || 0);
  const weakness = digest?.diagnosis?.primaryWeakness?.code || 'stable';
  const channelWatch = Number(digest?.channelPerformance?.watchChannels || 0);
  const adoptionStatus = digest?.strategyAdoption?.status || 'warming_up';
  const adoptionMatched = Number(digest?.strategyAdoption?.preferredCategoryPatternCount || 0);
  const adoptionBase = Number(digest?.strategyAdoption?.preferredCategoryCount || 0);
  const nextCategory = digest?.nextGeneralPreview?.category || 'none';
  const nextPattern = digest?.nextGeneralPreview?.pattern || 'none';
  const channelHint = digest?.channelPerformance?.primaryWatchChannel
    ? ` channel=${digest.channelPerformance.primaryWatchChannel}`
    : '';
  return `marketing=${status} signals=${signals} impact=${impactPct}% autonomy=${autonomyCount} channels_watch=${channelWatch} weakness=${weakness} adopt=${adoptionStatus}:${adoptionMatched}/${adoptionBase} next=${nextCategory}/${nextPattern}${channelHint}`;
}

function buildSnapshotFallback(digest = {}) {
  const status = digest?.health?.status || 'unknown';
  const watchChannels = Number(digest?.channelPerformance?.watchChannels || 0);
  const weakness = digest?.diagnosis?.primaryWeakness?.code || 'stable';
  if (status === 'watch') {
    return `마케팅 스냅샷은 watch 상태라 weakness ${weakness}와 watch 채널 ${watchChannels}개를 먼저 보는 편이 좋습니다.`;
  }
  return `마케팅 스냅샷은 ${status} 상태이며 weakness ${weakness} 기준으로 현재 운영 흐름을 계속 누적하면 됩니다.`;
}

async function persist(digest) {
  const metadata = buildPayload(digest);
  const brief = buildBrief(digest);
  const severity = digest?.health?.status === 'watch' ? 'warn' : 'info';

  const id = await eventLake.record({
    eventType: 'blog_marketing_snapshot',
    team: 'blog',
    botName: 'blog.marketing',
    severity,
    title: '블로그 마케팅 운영 스냅샷',
    message: brief,
    tags: ['blog', 'marketing', 'snapshot', 'ops'],
    metadata,
  });

  return {
    persisted: true,
    id,
    brief,
    snapshot: metadata,
  };
}

async function main() {
  const digest = await buildMarketingDigest();
  const aiSummary = await buildBlogCliInsight({
    bot: 'marketing-snapshot',
    requestType: 'marketing-snapshot',
    title: '블로그 마케팅 snapshot 요약',
    data: {
      health: digest?.health,
      channelPerformance: digest?.channelPerformance,
      diagnosis: digest?.diagnosis,
      strategyAdoption: digest?.strategyAdoption,
      nextGeneralPreview: digest?.nextGeneralPreview,
    },
    fallback: buildSnapshotFallback(digest),
  });

  if (dryRun) {
    const payload = {
      persisted: false,
      brief: buildBrief(digest),
      snapshot: buildPayload(digest),
      aiSummary,
    };
    console.log(json ? JSON.stringify(payload, null, 2) : `${payload.brief}\n🔍 AI: ${aiSummary}`);
    return;
  }

  const result = await persist(digest);
  result.aiSummary = aiSummary;
  console.log(json ? JSON.stringify(result, null, 2) : `${result.brief} id=${result.id || 'n/a'}\n🔍 AI: ${aiSummary}`);
}

main().catch((error) => {
  console.error('[marketing-snapshot] 실패:', error.message);
  process.exit(1);
});
