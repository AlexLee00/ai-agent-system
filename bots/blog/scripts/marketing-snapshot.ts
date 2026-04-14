#!/usr/bin/env node
// @ts-nocheck
'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');
const { buildMarketingDigest } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/marketing-digest.ts'));
const eventLake = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/event-lake.js'));

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
  return `marketing=${status} signals=${signals} impact=${impactPct}% autonomy=${autonomyCount} channels_watch=${channelWatch} weakness=${weakness}`;
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

  if (dryRun) {
    const payload = {
      persisted: false,
      brief: buildBrief(digest),
      snapshot: buildPayload(digest),
    };
    console.log(json ? JSON.stringify(payload, null, 2) : payload.brief);
    return;
  }

  const result = await persist(digest);
  console.log(json ? JSON.stringify(result, null, 2) : `${result.brief} id=${result.id || 'n/a'}`);
}

main().catch((error) => {
  console.error('[marketing-snapshot] 실패:', error.message);
  process.exit(1);
});
