#!/usr/bin/env node
'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');
const pgPool = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/pg-pool'));
const { ensureBlogCoreSchema } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/schema.ts'));
const { getInstagramConfig } = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/instagram-graph.ts'));
const { analyzeMarketingToRevenue } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/marketing-revenue-correlation.ts'));

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
      COALESCE(COUNT(*) FILTER (WHERE COALESCE(metadata->>'ok', 'false') <> 'true'), 0)::int AS failed_count,
      COALESCE(COUNT(*) FILTER (WHERE COALESCE(metadata->>'failure_kind', '') = 'auth'), 0)::int AS auth_failed_count,
      COALESCE(COUNT(*) FILTER (WHERE COALESCE(metadata->>'failure_kind', '') = 'upload'), 0)::int AS upload_failed_count,
      COALESCE(COUNT(*) FILTER (WHERE COALESCE(metadata->>'failure_kind', '') = 'publish'), 0)::int AS publish_failed_count,
      COALESCE(COUNT(*) FILTER (WHERE COALESCE(metadata->>'failure_kind', '') = 'unknown'), 0)::int AS unknown_failed_count
    FROM agent.event_lake
    WHERE event_type = 'blog_phase1_social_execution_result'
      AND team = 'blog'
      AND COALESCE(metadata->>'target', '') = $1
      AND COALESCE(metadata->>'smoke_test', 'false') <> 'true'
      AND COALESCE(metadata->>'run_status', '') <> 'forced_failure'
      AND created_at >= NOW() - ($2::text || ' days')::interval
  `, [channel, days]).catch(() => null);

  const eventCount = Number(row?.event_count || 0);
  const okCount = Number(row?.ok_count || 0);
  const failedCount = Number(row?.failed_count || 0);
  const authFailedCount = Number(row?.auth_failed_count || 0);
  const uploadFailedCount = Number(row?.upload_failed_count || 0);
  const publishFailedCount = Number(row?.publish_failed_count || 0);
  const unknownFailedCount = Number(row?.unknown_failed_count || 0);

  return {
    channel,
    source: 'event_lake',
    status: failedCount > 0 ? 'watch' : (eventCount > 0 ? 'ok' : 'warming_up'),
    publishedCount: okCount,
    views: 0,
    comments: 0,
    likes: 0,
    engagementRate: 0,
    metadata: {
      windowDays: days,
      eventCount,
      okCount,
      failedCount,
      authFailedCount,
      uploadFailedCount,
      publishFailedCount,
      unknownFailedCount,
      note: 'blog_phase1_social_execution_result 기반 집계',
    },
  };
}

async function collectInstagramChannelStats(days = 7) {
  const execStats = await collectSocialExecutionStats('instagram', days);
  const config = await getInstagramConfig().catch(() => null);
  return {
    ...execStats,
    metadata: {
      ...(execStats.metadata || {}),
      credentialSource: config?.credentialSource || null,
      hasAccessToken: Boolean(config?.accessToken),
      hasIgUserId: Boolean(config?.igUserId),
    },
  };
}

async function collectFacebookChannelStats(days = 7) {
  const config = await getInstagramConfig().catch(() => null);
  const hasBusinessAccount = Boolean(config?.businessAccountId);
  const hasPageId = Boolean(config?.pageId);
  const hasAccessToken = Boolean(config?.accessToken);
  const readyForPublish = hasPageId && hasAccessToken;
  return {
    channel: 'facebook',
    source: 'meta_config',
    status: readyForPublish ? 'warming_up' : 'disabled',
    publishedCount: 0,
    views: 0,
    comments: 0,
    likes: 0,
    engagementRate: 0,
    metadata: {
      windowDays: days,
      hasBusinessAccount,
      hasPageId,
      hasAccessToken,
      note: readyForPublish
        ? 'Facebook 페이지 게시 준비됨 — 실운영 게시/인사이트 수집 확장 가능'
        : hasBusinessAccount
          ? 'Meta 비즈니스 계정은 준비됐지만 page_id 또는 access_token이 부족함'
        : 'facebook business/page 연결 정보 없음',
    },
  };
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

  const snapshotDate = args.date || new Date().toISOString().slice(0, 10);
  const revenue = await analyzeMarketingToRevenue(14).catch(() => null);
  const revenueSignal = Number(revenue?.revenueImpactPct || 0);

  const items = await Promise.all([
    collectNaverBlogStats(args.days),
    collectInstagramChannelStats(args.days),
    collectFacebookChannelStats(args.days),
  ]);

  const persisted = [];
  for (const item of items) {
    persisted.push(await upsertChannelPerformance(snapshotDate, item, revenueSignal, args.dryRun));
  }

  const payload = {
    snapshotDate,
    dryRun: args.dryRun,
    revenueSignal,
    channels: persisted,
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`[channel-insights] snapshot=${snapshotDate} dryRun=${args.dryRun}`);
  for (const item of persisted) {
    console.log(`- ${item.channel}: status=${item.status} published=${item.published_count} views=${item.views} engagement=${item.engagement_rate}`);
  }
}

main().catch((error) => {
  console.error('[channel-insights] 실패:', error?.stack || error?.message || String(error));
  process.exit(1);
});
