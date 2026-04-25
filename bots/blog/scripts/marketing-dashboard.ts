#!/usr/bin/env node
'use strict';

/**
 * bots/blog/scripts/marketing-dashboard.ts
 *
 * Omnichannel Marketing OS 운영 대시보드 (CLI/JSON).
 * - campaign/queue 상태
 * - marketing digest
 * - creative winner/loser + saturation
 */

const path = require('path');
const env = require('../../../packages/core/lib/env');
const pgPool = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/pg-pool'));
const { buildMarketingDigest } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/marketing-digest.ts'));
const { ensureBlogCoreSchema } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/schema.ts'));
const { ensureMarketingOsSchema } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/omnichannel/marketing-os-schema.ts'));
const {
  ensureMarketingAssetMemorySchema,
  getAssetMemorySnapshot,
} = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/omnichannel/asset-memory.ts'));

function parseArgs(argv = []) {
  return {
    json: argv.includes('--json'),
    days: Math.max(3, Number(readOption(argv, '--days') || 7)),
    queueDays: Math.max(1, Number(readOption(argv, '--queue-days') || 3)),
  };
}

function readOption(argv, key) {
  const idx = argv.indexOf(key);
  if (idx === -1) return '';
  return String(argv[idx + 1] || '').trim();
}

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

async function loadCampaignSummary(days = 7) {
  try {
    const rows = await pgPool.query('blog', `
      SELECT
        status,
        brand_axis,
        objective,
        COUNT(*)::int AS cnt
      FROM blog.marketing_campaigns
      WHERE created_at >= NOW() - ($1::text || ' days')::interval
      GROUP BY status, brand_axis, objective
      ORDER BY cnt DESC, status ASC
    `, [days]);

    const byStatus = {};
    for (const row of rows || []) {
      const status = String(row.status || 'active');
      byStatus[status] = toNumber(byStatus[status], 0) + toNumber(row.cnt, 0);
    }
    return {
      rows: (rows || []).map((row) => ({
        status: String(row.status || 'active'),
        brandAxis: String(row.brand_axis || 'mixed'),
        objective: String(row.objective || 'awareness'),
        count: toNumber(row.cnt, 0),
      })),
      byStatus,
      total: Object.values(byStatus).reduce((sum, item) => sum + toNumber(item, 0), 0),
    };
  } catch (error) {
    return { rows: [], byStatus: {}, total: 0, error: String(error?.message || error) };
  }
}

async function loadQueueSummary(days = 3) {
  try {
    const [statusRows, overdueRows, failureRows] = await Promise.all([
      pgPool.query('blog', `
        SELECT platform, status, COUNT(*)::int AS cnt
        FROM blog.marketing_publish_queue
        WHERE created_at >= NOW() - ($1::text || ' days')::interval
        GROUP BY platform, status
        ORDER BY platform ASC, status ASC
      `, [days]),
      pgPool.query('blog', `
        SELECT platform, COUNT(*)::int AS overdue_cnt
        FROM blog.marketing_publish_queue
        WHERE status IN ('queued', 'preparing')
          AND scheduled_at < NOW() - INTERVAL '30 minutes'
          AND created_at >= NOW() - ($1::text || ' days')::interval
        GROUP BY platform
        ORDER BY overdue_cnt DESC
      `, [days]),
      pgPool.query('blog', `
        SELECT
          platform,
          failure_kind,
          COUNT(*)::int AS cnt
        FROM blog.marketing_publish_queue
        WHERE status IN ('failed', 'blocked')
          AND created_at >= NOW() - ($1::text || ' days')::interval
        GROUP BY platform, failure_kind
        ORDER BY cnt DESC
        LIMIT 10
      `, [days]),
    ]);

    const grouped = {};
    for (const row of statusRows || []) {
      const platform = String(row.platform || 'unknown');
      if (!grouped[platform]) grouped[platform] = {};
      grouped[platform][String(row.status || 'queued')] = toNumber(row.cnt, 0);
    }

    return {
      byPlatformStatus: grouped,
      overdue: (overdueRows || []).map((row) => ({
        platform: String(row.platform || 'unknown'),
        count: toNumber(row.overdue_cnt, 0),
      })),
      recentFailures: (failureRows || []).map((row) => ({
        platform: String(row.platform || 'unknown'),
        failureKind: String(row.failure_kind || 'unknown'),
        count: toNumber(row.cnt, 0),
      })),
    };
  } catch (error) {
    return {
      byPlatformStatus: {},
      overdue: [],
      recentFailures: [],
      error: String(error?.message || error),
    };
  }
}

function renderText(payload = {}) {
  const lines = [
    '📊 블로그팀 Marketing Dashboard',
    `generatedAt: ${payload.generatedAt || new Date().toISOString()}`,
    '',
    '[Digest]',
    `- health: ${payload.digest?.health?.status || 'unknown'}`,
    `- reason: ${payload.digest?.health?.reason || 'n/a'}`,
    `- top signal: ${payload.digest?.senseSummary?.topSignal?.message || 'none'}`,
    `- revenue impact: ${(toNumber(payload.digest?.revenueCorrelation?.revenueImpactPct, 0) * 100).toFixed(1)}%`,
    '',
    '[Campaigns]',
    `- total(${payload.windowDays}d): ${toNumber(payload.campaignSummary?.total, 0)}`,
  ];

  const statusMap = payload.campaignSummary?.byStatus || {};
  Object.keys(statusMap).sort().forEach((key) => {
    lines.push(`- ${key}: ${toNumber(statusMap[key], 0)}`);
  });

  lines.push('', '[Queue]');
  const byPlatformStatus = payload.queueSummary?.byPlatformStatus || {};
  const platforms = Object.keys(byPlatformStatus).sort();
  if (platforms.length === 0) {
    lines.push('- no queue rows');
  } else {
    for (const platform of platforms) {
      const row = byPlatformStatus[platform] || {};
      const queued = toNumber(row.queued, 0);
      const preparing = toNumber(row.preparing, 0);
      const publishing = toNumber(row.publishing, 0);
      const published = toNumber(row.published, 0);
      const failed = toNumber(row.failed, 0) + toNumber(row.blocked, 0);
      lines.push(`- ${platform}: queued ${queued}, preparing ${preparing}, publishing ${publishing}, published ${published}, issues ${failed}`);
    }
  }

  if (Array.isArray(payload.queueSummary?.overdue) && payload.queueSummary.overdue.length > 0) {
    lines.push('- overdue jobs:');
    payload.queueSummary.overdue.slice(0, 3).forEach((item) => {
      lines.push(`  ${item.platform} ${item.count}`);
    });
  }

  lines.push('', '[Creative Memory]');
  const winners = Array.isArray(payload.assetMemory?.winners) ? payload.assetMemory.winners : [];
  const losers = Array.isArray(payload.assetMemory?.losers) ? payload.assetMemory.losers : [];
  const saturated = Array.isArray(payload.assetMemory?.saturation)
    ? payload.assetMemory.saturation.filter((item) => item.saturated)
    : [];

  if (winners.length === 0 && losers.length === 0) {
    lines.push('- warming_up (insufficient samples)');
  } else {
    winners.slice(0, 2).forEach((item) => {
      lines.push(`- winner ${item.platform}: success ${(item.successRate * 100).toFixed(1)}% / q ${item.avgQuality.toFixed(1)} / ${item.creativeFingerprint}`);
    });
    losers.slice(0, 2).forEach((item) => {
      lines.push(`- loser ${item.platform}: success ${(item.successRate * 100).toFixed(1)}% / q ${item.avgQuality.toFixed(1)} / ${item.creativeFingerprint}`);
    });
  }

  if (saturated.length > 0) {
    lines.push('- saturation alerts:');
    saturated.slice(0, 3).forEach((item) => {
      lines.push(`  ${item.platform} ${(item.saturationRatio * 100).toFixed(1)}% top=${item.topFingerprint}`);
    });
  } else {
    lines.push('- saturation: none');
  }

  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await ensureBlogCoreSchema();
  await ensureMarketingOsSchema().catch((error) => {
    console.warn('[marketing-dashboard] marketing OS schema ensure 실패:', String(error?.message || error));
  });
  await ensureMarketingAssetMemorySchema();

  const [digest, campaignSummary, queueSummary, assetMemory] = await Promise.all([
    buildMarketingDigest({
      revenueWindow: args.days * 2,
      diagnosisWindow: args.days,
      channelWindow: args.days,
      snapshotWindow: args.days,
    }),
    loadCampaignSummary(args.days),
    loadQueueSummary(args.queueDays),
    getAssetMemorySnapshot({
      laneDays: Math.max(14, args.days * 2),
      saturationDays: Math.max(7, args.days),
    }),
  ]);

  const payload = {
    generatedAt: new Date().toISOString(),
    windowDays: args.days,
    queueWindowDays: args.queueDays,
    digest,
    campaignSummary,
    queueSummary,
    assetMemory,
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(renderText(payload));
}

main().catch((error) => {
  console.error('[marketing-dashboard] 실패:', error?.stack || error?.message || String(error));
  process.exit(1);
});
