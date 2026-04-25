#!/usr/bin/env node
'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');
const pgPool = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/pg-pool'));
const { ensureBlogCoreSchema } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/schema.ts'));
const { analyzeMarketingToRevenue } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/marketing-revenue-correlation.ts'));
const {
  collectOmnichannelMetaInsights,
  upsertMarketingChannelMetrics,
} = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/omnichannel/meta-insights.ts'));
const { ensureMarketingOsSchema } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/omnichannel/marketing-os-schema.ts'));

function parseArgs(argv = []) {
  return {
    date: readOption(argv, '--date') || null,
    days: Number(readOption(argv, '--days') || 7),
    json: argv.includes('--json'),
    dryRun: argv.includes('--dry-run'),
  };
}

function readOption(argv, name) {
  const idx = argv.indexOf(name);
  if (idx === -1) return '';
  return String(argv[idx + 1] || '').trim();
}

async function collectNaverBlogStats(days = 7) {
  const row = await pgPool.get('blog', `
    SELECT
      COUNT(*)::int AS published_count,
      COALESCE(SUM(COALESCE(views, 0)), 0)::int AS views,
      COALESCE(SUM(COALESCE(comments, 0)), 0)::int AS comments,
      COALESCE(SUM(COALESCE(likes, 0)), 0)::int AS likes
    FROM blog.posts
    WHERE publish_date >= CURRENT_DATE - ($1::text || ' days')::interval
      AND status = 'published'
  `, [days]).catch(() => null);

  const publishedCount = Number(row?.published_count || 0);
  const views = Number(row?.views || 0);
  const comments = Number(row?.comments || 0);
  const likes = Number(row?.likes || 0);
  const engagementRate = views > 0
    ? Number((((comments + likes) / views) * 100).toFixed(2))
    : 0;

  return {
    channel: 'naver_blog',
    source: 'blog_posts',
    status: publishedCount > 0 ? 'ok' : 'warming_up',
    publishedCount,
    views,
    comments,
    likes,
    engagementRate,
    metadata: {
      windowDays: days,
      note: 'blog.posts 기반 집계',
    },
  };
}

async function collectSocialExecutionStats(channel, days = 7) {
  const row = await pgPool.get('agent', `
    SELECT
      COUNT(*)::int AS event_count,
      COALESCE(COUNT(*) FILTER (WHERE COALESCE(metadata->>'ok', 'false') = 'true'), 0)::int AS ok_count,
      COALESCE(COUNT(*) FILTER (WHERE COALESCE(metadata->>'ok', 'false') <> 'true'), 0)::int AS failed_count
    FROM agent.event_lake
    WHERE event_type = 'blog_phase1_social_execution_result'
      AND team = 'blog'
      AND COALESCE(metadata->>'target', '') = $1
      AND COALESCE(metadata->>'smoke_test', 'false') <> 'true'
      AND COALESCE(metadata->>'run_status', '') <> 'forced_failure'
      AND created_at >= NOW() - ($2::text || ' days')::interval
  `, [channel, days]).catch(() => null);

  return {
    channel,
    source: 'event_lake',
    status: Number(row?.failed_count || 0) > 0 ? 'watch' : (Number(row?.event_count || 0) > 0 ? 'ok' : 'warming_up'),
    publishedCount: Number(row?.ok_count || 0),
    views: 0,
    comments: 0,
    likes: 0,
    engagementRate: 0,
    metadata: {
      windowDays: days,
      eventCount: Number(row?.event_count || 0),
      okCount: Number(row?.ok_count || 0),
      failedCount: Number(row?.failed_count || 0),
      note: 'event_lake fallback 집계',
    },
  };
}

function mergeChannelInsight(metaItem, fallbackItem) {
  const base = metaItem || fallbackItem || {};
  const fallback = fallbackItem || {};
  const merged = {
    channel: base.channel || fallback.channel || 'unknown',
    source: base.source || fallback.source || 'unknown',
    status: base.status || fallback.status || 'warming_up',
    publishedCount: Math.max(Number(base.publishedCount || 0), Number(fallback.publishedCount || 0)),
    views: Number(base.views || fallback.views || 0),
    comments: Number(base.comments || fallback.comments || 0),
    likes: Number(base.likes || fallback.likes || 0),
    engagementRate: Number(base.engagementRate || fallback.engagementRate || 0),
    metadata: {
      ...(fallback.metadata || {}),
      ...(base.metadata || {}),
    },
  };

  // 권한 부족은 최우선으로 유지
  if (String(base.status || '') === 'needs_permission') {
    merged.status = 'needs_permission';
  } else if (String(base.status || '') === 'error' && String(fallback.status || '') !== 'warming_up') {
    merged.status = fallback.status || 'watch';
  }

  return merged;
}

async function upsertChannelPerformance(snapshotDate, item, revenueSignal = 0, dryRun = false) {
  const payload = {
    snapshot_date: snapshotDate,
    channel: item.channel,
    source: item.source || 'local',
    status: item.status || 'ok',
    published_count: Number(item.publishedCount || 0),
    views: Number(item.views || 0),
    comments: Number(item.comments || 0),
    likes: Number(item.likes || 0),
    engagement_rate: Number(item.engagementRate || 0),
    revenue_signal: Number(revenueSignal || 0),
    metadata: item.metadata || {},
  };

  if (dryRun) return payload;

  await pgPool.run('blog', `
    INSERT INTO blog.channel_performance
      (snapshot_date, channel, source, status, published_count, views, comments, likes, engagement_rate, revenue_signal, metadata, updated_at)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, NOW())
    ON CONFLICT (snapshot_date, channel, source)
    DO UPDATE SET
      status = EXCLUDED.status,
      published_count = EXCLUDED.published_count,
      views = EXCLUDED.views,
      comments = EXCLUDED.comments,
      likes = EXCLUDED.likes,
      engagement_rate = EXCLUDED.engagement_rate,
      revenue_signal = EXCLUDED.revenue_signal,
      metadata = EXCLUDED.metadata,
      updated_at = NOW()
  `, [
    payload.snapshot_date,
    payload.channel,
    payload.source,
    payload.status,
    payload.published_count,
    payload.views,
    payload.comments,
    payload.likes,
    payload.engagement_rate,
    payload.revenue_signal,
    JSON.stringify(payload.metadata || {}),
  ]);

  return payload;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await ensureBlogCoreSchema();
  await ensureMarketingOsSchema().catch((error) => {
    console.warn('[channel-insights] marketing OS schema ensure 실패:', String(error?.message || error));
  });

  const snapshotDate = args.date || new Date().toISOString().slice(0, 10);
  const revenue = await analyzeMarketingToRevenue(14).catch(() => null);
  const revenueSignal = Number(revenue?.revenueImpactPct || 0);

  const [naver, metaInsights, instagramFallback, facebookFallback] = await Promise.all([
    collectNaverBlogStats(args.days),
    collectOmnichannelMetaInsights({
      days: args.days,
      date: snapshotDate,
      dryRun: args.dryRun,
    }),
    collectSocialExecutionStats('instagram', args.days),
    collectSocialExecutionStats('facebook', args.days),
  ]);

  const instagram = mergeChannelInsight(metaInsights?.instagram, instagramFallback);
  const facebook = mergeChannelInsight(metaInsights?.facebook, facebookFallback);

  const items = [naver, instagram, facebook];
  const persisted = [];
  for (const item of items) {
    persisted.push(await upsertChannelPerformance(snapshotDate, item, revenueSignal, args.dryRun));
  }

  const metricsWritten = await upsertMarketingChannelMetrics(metaInsights?.metricRows || [], {
    dryRun: args.dryRun,
  });

  const payload = {
    snapshotDate,
    dryRun: args.dryRun,
    revenueSignal,
    channels: persisted,
    marketingMetrics: {
      metricDate: metaInsights?.metricDate || snapshotDate,
      rows: metaInsights?.metricRows || [],
      written: metricsWritten,
    },
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`[channel-insights] snapshot=${snapshotDate} dryRun=${args.dryRun}`);
  for (const item of persisted) {
    console.log(`- ${item.channel}: status=${item.status} published=${item.published_count} views=${item.views} engagement=${item.engagement_rate}`);
  }
  console.log(`[channel-insights] marketing_channel_metrics=${metricsWritten} rows`);
}

main().catch((error) => {
  console.error('[channel-insights] 실패:', error?.stack || error?.message || String(error));
  process.exit(1);
});
