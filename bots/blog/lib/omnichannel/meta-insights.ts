'use strict';

/**
 * bots/blog/lib/omnichannel/meta-insights.ts
 *
 * Meta(Graph) 기반 Instagram/Facebook 인사이트 수집 + channel metrics 저장 도우미.
 * - 권한 부족은 disabled 대신 needs_permission으로 분류한다.
 * - dry-run에서는 live API 호출을 생략하고 로컬 publish_log 기반 상태만 반환한다.
 */

const path = require('path');
const env = require('../../../../packages/core/lib/env');
const pgPool = require('../../../../packages/core/lib/pg-pool');
const { getMetaGraphConfig } = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/meta-graph-config.ts'));

const KNOWN_PERMISSION_SCOPES = [
  'pages_manage_posts',
  'pages_read_engagement',
  'pages_manage_metadata',
  'instagram_basic',
  'instagram_content_publish',
  'instagram_manage_insights',
];

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function extractPermissionScopes(text = '') {
  const raw = String(text || '');
  return KNOWN_PERMISSION_SCOPES.filter((scope) => raw.includes(scope));
}

function classifyGraphError(error) {
  const raw = String(error?.message || error || '');
  const lower = raw.toLowerCase();
  const statusCode = toNumber(error?.statusCode || error?.status || 0, 0);
  const needsPermission = (
    statusCode === 403
    || lower.includes('permission')
    || lower.includes('not authorized')
    || lower.includes('permissions error')
    || lower.includes('code\":10')
    || lower.includes('code\":200')
  );
  const tokenExpired = (
    statusCode === 401
    || lower.includes('session has expired')
    || lower.includes('invalid oauth')
    || lower.includes('error code 190')
  );
  return {
    raw,
    statusCode,
    needsPermission,
    tokenExpired,
    permissionScopes: extractPermissionScopes(raw),
  };
}

async function graphGetJson(url, accessToken, fetchImpl = global.fetch) {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = `Meta Graph API failed: HTTP ${response.status} ${JSON.stringify(payload || {})}`;
    const error = new Error(message);
    // @ts-ignore runtime metadata
    error.statusCode = response.status;
    // @ts-ignore runtime metadata
    error.payload = payload;
    throw error;
  }
  return payload;
}

function extractInsightValue(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return toNumber(value, 0);
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + extractInsightValue(item), 0);
  }
  if (value && typeof value === 'object') {
    return Object.values(value).reduce((sum, item) => sum + extractInsightValue(item), 0);
  }
  return 0;
}

function parseGraphInsights(payload = {}) {
  const out = {};
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  for (const row of rows) {
    const key = String(row?.name || '').trim();
    if (!key) continue;
    const firstValue = Array.isArray(row?.values) ? row.values[0]?.value : null;
    out[key] = extractInsightValue(firstValue);
  }
  return out;
}

async function loadLocalPublishSummary(days = 7) {
  try {
    const rows = await pgPool.query('blog', `
      SELECT
        platform,
        COUNT(*) FILTER (WHERE status = 'success')::int AS success_count,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count
      FROM blog.publish_log
      WHERE created_at >= NOW() - ($1::text || ' days')::interval
        AND platform IN ('instagram', 'facebook')
      GROUP BY platform
    `, [days]);
    const out = {
      instagram: { successCount: 0, failedCount: 0 },
      facebook: { successCount: 0, failedCount: 0 },
    };
    for (const row of rows || []) {
      const key = String(row?.platform || '');
      if (!out[key]) continue;
      out[key] = {
        successCount: toNumber(row?.success_count, 0),
        failedCount: toNumber(row?.failed_count, 0),
      };
    }
    return out;
  } catch {
    return {
      instagram: { successCount: 0, failedCount: 0 },
      facebook: { successCount: 0, failedCount: 0 },
    };
  }
}

function buildInstagramMediaUrl(config, fields = []) {
  const base = `${config.baseUrl}/${config.apiVersion}/${config.instagram?.igUserId}/media`;
  const params = new URLSearchParams({
    fields: fields.join(','),
    limit: '10',
  });
  return `${base}?${params.toString()}`;
}

function buildFacebookPostsUrl(config, fields = []) {
  const base = `${config.baseUrl}/${config.apiVersion}/${config.facebook?.pageId}/posts`;
  const params = new URLSearchParams({
    fields: fields.join(','),
    limit: '10',
  });
  return `${base}?${params.toString()}`;
}

function withinWindow(timestamp = '', sinceTs = 0) {
  const ts = Date.parse(String(timestamp || ''));
  if (!Number.isFinite(ts)) return false;
  return ts >= sinceTs;
}

async function collectInstagramLiveMetrics(config, sinceTs, fetchImpl = global.fetch) {
  const accessToken = String(config?.instagram?.accessToken || '');
  const igUserId = String(config?.instagram?.igUserId || '');
  if (!accessToken || !igUserId) {
    return {
      ok: false,
      status: 'needs_permission',
      reason: 'instagram credential missing',
      permissionScopes: ['instagram_basic', 'instagram_manage_insights'],
    };
  }

  const mediaFields = ['id', 'timestamp', 'media_type', 'like_count', 'comments_count'];
  const metrics = [
    'reach',
    'impressions',
    'saved',
    'shares',
    'profile_visits',
    'follows',
    'website_clicks',
  ];

  try {
    const mediaPayload = await graphGetJson(
      buildInstagramMediaUrl(config, mediaFields),
      accessToken,
      fetchImpl,
    );
    const mediaRows = Array.isArray(mediaPayload?.data) ? mediaPayload.data : [];
    const targetRows = mediaRows.filter((row) => withinWindow(row?.timestamp, sinceTs));
    if (targetRows.length === 0) {
      return {
        ok: true,
        status: 'warming_up',
        reason: 'no_recent_instagram_media',
        metrics: {
          reach: 0,
          impressions: 0,
          likes: 0,
          comments: 0,
          saves: 0,
          shares: 0,
          clicks: 0,
          profile_actions: 0,
          follows: 0,
        },
        raw: {
          mediaCount: 0,
          sampledMediaIds: [],
        },
      };
    }

    const aggregate = {
      reach: 0,
      impressions: 0,
      likes: 0,
      comments: 0,
      saves: 0,
      shares: 0,
      clicks: 0,
      profile_actions: 0,
      follows: 0,
    };

    const sampledMediaIds = [];
    for (const media of targetRows) {
      const mediaId = String(media?.id || '').trim();
      if (!mediaId) continue;
      sampledMediaIds.push(mediaId);
      aggregate.likes += toNumber(media?.like_count || 0, 0);
      aggregate.comments += toNumber(media?.comments_count || 0, 0);

      const insightUrl = `${config.baseUrl}/${config.apiVersion}/${mediaId}/insights?${new URLSearchParams({
        metric: metrics.join(','),
      }).toString()}`;
      const insightPayload = await graphGetJson(insightUrl, accessToken, fetchImpl);
      const parsed = parseGraphInsights(insightPayload);
      aggregate.reach += toNumber(parsed.reach, 0);
      aggregate.impressions += toNumber(parsed.impressions, 0);
      aggregate.saves += toNumber(parsed.saved || parsed.saves, 0);
      aggregate.shares += toNumber(parsed.shares, 0);
      aggregate.clicks += toNumber(parsed.website_clicks || parsed.link_clicks, 0);
      aggregate.profile_actions += toNumber(parsed.profile_visits || parsed.profile_views, 0);
      aggregate.follows += toNumber(parsed.follows, 0);
    }

    return {
      ok: true,
      status: 'ok',
      metrics: aggregate,
      raw: {
        mediaCount: targetRows.length,
        sampledMediaIds,
      },
    };
  } catch (error) {
    const classified = classifyGraphError(error);
    return {
      ok: false,
      status: classified.needsPermission ? 'needs_permission' : (classified.tokenExpired ? 'needs_permission' : 'error'),
      reason: classified.raw,
      permissionScopes: classified.permissionScopes,
      metrics: null,
      raw: {
        statusCode: classified.statusCode,
      },
    };
  }
}

async function collectFacebookLiveMetrics(config, sinceTs, fetchImpl = global.fetch) {
  const accessToken = String(config?.facebook?.accessToken || '');
  const pageId = String(config?.facebook?.pageId || '');
  if (!accessToken || !pageId) {
    return {
      ok: false,
      status: 'needs_permission',
      reason: 'facebook credential missing',
      permissionScopes: ['pages_read_engagement'],
    };
  }

  const postFields = [
    'id',
    'created_time',
    'reactions.summary(true).limit(0)',
    'comments.summary(true).limit(0)',
    'shares',
  ];
  const metrics = [
    'post_impressions',
    'post_impressions_unique',
    'post_clicks',
    'post_engaged_users',
  ];

  try {
    const postsPayload = await graphGetJson(
      buildFacebookPostsUrl(config, postFields),
      accessToken,
      fetchImpl,
    );
    const posts = Array.isArray(postsPayload?.data) ? postsPayload.data : [];
    const targetRows = posts.filter((row) => withinWindow(row?.created_time, sinceTs));

    if (targetRows.length === 0) {
      return {
        ok: true,
        status: 'warming_up',
        reason: 'no_recent_facebook_posts',
        metrics: {
          reach: 0,
          impressions: 0,
          likes: 0,
          comments: 0,
          saves: 0,
          shares: 0,
          clicks: 0,
          profile_actions: 0,
          follows: 0,
        },
        raw: {
          postCount: 0,
          sampledPostIds: [],
        },
      };
    }

    const aggregate = {
      reach: 0,
      impressions: 0,
      likes: 0,
      comments: 0,
      saves: 0,
      shares: 0,
      clicks: 0,
      profile_actions: 0,
      follows: 0,
    };
    const sampledPostIds = [];

    for (const post of targetRows) {
      const postId = String(post?.id || '').trim();
      if (!postId) continue;
      sampledPostIds.push(postId);

      aggregate.likes += toNumber(post?.reactions?.summary?.total_count || 0, 0);
      aggregate.comments += toNumber(post?.comments?.summary?.total_count || 0, 0);
      aggregate.shares += toNumber(post?.shares?.count || 0, 0);

      const insightUrl = `${config.baseUrl}/${config.apiVersion}/${postId}/insights?${new URLSearchParams({
        metric: metrics.join(','),
      }).toString()}`;
      const insightPayload = await graphGetJson(insightUrl, accessToken, fetchImpl);
      const parsed = parseGraphInsights(insightPayload);
      aggregate.impressions += toNumber(parsed.post_impressions, 0);
      aggregate.reach += toNumber(parsed.post_impressions_unique, 0);
      aggregate.clicks += toNumber(parsed.post_clicks, 0);
      aggregate.profile_actions += toNumber(parsed.post_engaged_users, 0);
    }

    return {
      ok: true,
      status: 'ok',
      metrics: aggregate,
      raw: {
        postCount: targetRows.length,
        sampledPostIds,
      },
    };
  } catch (error) {
    const classified = classifyGraphError(error);
    return {
      ok: false,
      status: classified.needsPermission ? 'needs_permission' : (classified.tokenExpired ? 'needs_permission' : 'error'),
      reason: classified.raw,
      permissionScopes: classified.permissionScopes,
      metrics: null,
      raw: {
        statusCode: classified.statusCode,
      },
    };
  }
}

function buildEngagementRate(metrics = {}) {
  const impressions = toNumber(metrics.impressions, 0);
  if (impressions <= 0) return 0;
  const interactions = (
    toNumber(metrics.likes, 0)
    + toNumber(metrics.comments, 0)
    + toNumber(metrics.saves, 0)
    + toNumber(metrics.shares, 0)
  );
  return Number(((interactions / impressions) * 100).toFixed(2));
}

function buildMetricRow(platform, metricDate, metrics = {}, rawPayload = null) {
  return {
    variant_id: null,
    platform,
    metric_date: metricDate,
    reach: toNumber(metrics.reach, 0),
    impressions: toNumber(metrics.impressions, 0),
    likes: toNumber(metrics.likes, 0),
    comments: toNumber(metrics.comments, 0),
    saves: toNumber(metrics.saves, 0),
    shares: toNumber(metrics.shares, 0),
    clicks: toNumber(metrics.clicks, 0),
    profile_actions: toNumber(metrics.profile_actions, 0),
    follows: toNumber(metrics.follows, 0),
    raw_payload: rawPayload || {},
  };
}

async function collectOmnichannelMetaInsights({
  days = 7,
  date = '',
  dryRun = false,
  fetchImpl = global.fetch,
} = {}) {
  const metricDate = date || todayDateString();
  const sinceTs = Date.now() - Math.max(1, Number(days || 7)) * 24 * 60 * 60 * 1000;
  const [config, localSummary] = await Promise.all([
    getMetaGraphConfig().catch(() => ({})),
    loadLocalPublishSummary(days),
  ]);

  const instagramLive = dryRun
    ? { ok: true, status: 'warming_up', reason: 'dry_run_live_fetch_skipped', metrics: null, raw: {} }
    : await collectInstagramLiveMetrics(config, sinceTs, fetchImpl);
  const facebookLive = dryRun
    ? { ok: true, status: 'warming_up', reason: 'dry_run_live_fetch_skipped', metrics: null, raw: {} }
    : await collectFacebookLiveMetrics(config, sinceTs, fetchImpl);

  const instagramMetrics = instagramLive.metrics || {
    reach: 0,
    impressions: 0,
    likes: 0,
    comments: 0,
    saves: 0,
    shares: 0,
    clicks: 0,
    profile_actions: 0,
    follows: 0,
  };
  const facebookMetrics = facebookLive.metrics || {
    reach: 0,
    impressions: 0,
    likes: 0,
    comments: 0,
    saves: 0,
    shares: 0,
    clicks: 0,
    profile_actions: 0,
    follows: 0,
  };

  const instagram = {
    channel: 'instagram',
    platform: 'instagram_reel',
    status: instagramLive.status || 'warming_up',
    source: 'meta_insights',
    publishedCount: Math.max(
      toNumber(localSummary?.instagram?.successCount, 0),
      toNumber(instagramLive?.raw?.mediaCount, 0),
    ),
    views: toNumber(instagramMetrics.impressions, 0),
    comments: toNumber(instagramMetrics.comments, 0),
    likes: toNumber(instagramMetrics.likes, 0),
    engagementRate: buildEngagementRate(instagramMetrics),
    metadata: {
      permissionScopes: instagramLive.permissionScopes || [],
      reason: instagramLive.reason || '',
      liveCollected: !dryRun && instagramLive.ok === true,
      localSummary: localSummary.instagram,
      raw: instagramLive.raw || {},
    },
    metricRow: buildMetricRow('instagram_reel', metricDate, instagramMetrics, {
      source: 'meta_graph',
      live: instagramLive,
    }),
  };

  const facebook = {
    channel: 'facebook',
    platform: 'facebook_page',
    status: facebookLive.status || 'warming_up',
    source: 'meta_insights',
    publishedCount: Math.max(
      toNumber(localSummary?.facebook?.successCount, 0),
      toNumber(facebookLive?.raw?.postCount, 0),
    ),
    views: toNumber(facebookMetrics.impressions, 0),
    comments: toNumber(facebookMetrics.comments, 0),
    likes: toNumber(facebookMetrics.likes, 0),
    engagementRate: buildEngagementRate(facebookMetrics),
    metadata: {
      permissionScopes: facebookLive.permissionScopes || [],
      reason: facebookLive.reason || '',
      liveCollected: !dryRun && facebookLive.ok === true,
      localSummary: localSummary.facebook,
      raw: facebookLive.raw || {},
    },
    metricRow: buildMetricRow('facebook_page', metricDate, facebookMetrics, {
      source: 'meta_graph',
      live: facebookLive,
    }),
  };

  return {
    metricDate,
    dryRun,
    instagram,
    facebook,
    metricRows: [instagram.metricRow, facebook.metricRow],
  };
}

async function upsertMarketingChannelMetrics(metricRows = [], { dryRun = false } = {}) {
  const rows = Array.isArray(metricRows) ? metricRows : [];
  if (dryRun || rows.length === 0) return 0;
  let written = 0;
  for (const row of rows) {
    try {
      const variantId = row.variant_id || null;
      if (!variantId) {
        await pgPool.query('blog', `
          DELETE FROM blog.marketing_channel_metrics
          WHERE variant_id IS NULL
            AND platform = $1
            AND metric_date = $2
        `, [row.platform, row.metric_date]);

        await pgPool.query('blog', `
          INSERT INTO blog.marketing_channel_metrics
            (variant_id, platform, metric_date, reach, impressions, likes, comments,
             saves, shares, clicks, profile_actions, follows, raw_payload)
          VALUES
            (NULL, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
        `, [
          row.platform,
          row.metric_date,
          row.reach,
          row.impressions,
          row.likes,
          row.comments,
          row.saves,
          row.shares,
          row.clicks,
          row.profile_actions,
          row.follows,
          JSON.stringify(row.raw_payload || {}),
        ]);
      } else {
        await pgPool.query('blog', `
          INSERT INTO blog.marketing_channel_metrics
            (variant_id, platform, metric_date, reach, impressions, likes, comments,
             saves, shares, clicks, profile_actions, follows, raw_payload)
          VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
          ON CONFLICT (variant_id, platform, metric_date)
          DO UPDATE SET
            reach = EXCLUDED.reach,
            impressions = EXCLUDED.impressions,
            likes = EXCLUDED.likes,
            comments = EXCLUDED.comments,
            saves = EXCLUDED.saves,
            shares = EXCLUDED.shares,
            clicks = EXCLUDED.clicks,
            profile_actions = EXCLUDED.profile_actions,
            follows = EXCLUDED.follows,
            raw_payload = EXCLUDED.raw_payload,
            collected_at = NOW()
        `, [
          variantId,
          row.platform,
          row.metric_date,
          row.reach,
          row.impressions,
          row.likes,
          row.comments,
          row.saves,
          row.shares,
          row.clicks,
          row.profile_actions,
          row.follows,
          JSON.stringify(row.raw_payload || {}),
        ]);
      }
      written += 1;
    } catch (error) {
      console.warn(`[meta-insights] marketing_channel_metrics upsert 실패 (${row.platform}): ${String(error?.message || error)}`);
    }
  }
  return written;
}

module.exports = {
  collectOmnichannelMetaInsights,
  upsertMarketingChannelMetrics,
  classifyGraphError,
  extractPermissionScopes,
};

