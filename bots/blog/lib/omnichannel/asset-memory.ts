'use strict';

/**
 * bots/blog/lib/omnichannel/asset-memory.ts
 *
 * 성공/실패한 creative를 누적 저장해
 * - winner/loser cluster
 * - 포맷 saturation
 * 을 계산하는 경량 memory 레이어.
 */

const pgPool = require('../../../../packages/core/lib/pg-pool');

let schemaEnsured = false;

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function toList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  if (typeof value === 'string') {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function normalizeToken(value = '', fallback = 'na') {
  const raw = String(value || '').trim().toLowerCase();
  const cleaned = raw
    .replace(/[^\p{L}\p{N}_-]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

function inferHookStyle(variant = {}) {
  const text = String(variant.caption || variant.body || variant.title || '').trim();
  if (!text) return 'neutral';
  if (text.includes('?')) return 'question';
  if (/[0-9]+\s*(가지|개|tips?|tip|포인트|방법)/i.test(text)) return 'listicle';
  if (/(지금|오늘|이번주|바로|긴급|마감|놓치지)/.test(text)) return 'urgency';
  return 'story';
}

function inferCtaStyle(variant = {}) {
  const text = String(variant.cta || variant.caption || variant.body || '').trim();
  if (!text) return 'none';
  if (/(예약|문의|방문|신청|등록|좌석|스터디룸)/.test(text)) return 'conversion';
  if (/(댓글|공감|저장|공유|질문|의견)/.test(text)) return 'engagement';
  if (/(팔로우|브랜드|소개|스토리|후기)/.test(text)) return 'awareness';
  return 'mixed';
}

function inferHashtagCluster(variant = {}) {
  const tags = toList(variant.hashtags).map((tag) => normalizeToken(String(tag).replace(/^#/, ''), 'tag'));
  if (tags.length === 0) return 'none';
  return tags.slice(0, 3).join('|');
}

function buildCreativeFingerprint(variant = {}) {
  const platform = normalizeToken(variant.platform || 'unknown', 'unknown');
  const sourceMode = normalizeToken(variant.source_mode || 'strategy_native', 'strategy_native');
  const hook = inferHookStyle(variant);
  const cta = inferCtaStyle(variant);
  const hashtagCluster = inferHashtagCluster(variant);
  return `${platform}::${sourceMode}::${hook}::${cta}::${hashtagCluster}`;
}

async function ensureMarketingAssetMemorySchema() {
  if (schemaEnsured) return;
  await pgPool.run('blog', `
    CREATE TABLE IF NOT EXISTS blog.marketing_asset_memory (
      variant_id TEXT PRIMARY KEY,
      campaign_id TEXT,
      platform TEXT NOT NULL,
      brand_axis TEXT DEFAULT 'mixed',
      objective TEXT DEFAULT 'awareness',
      source_mode TEXT DEFAULT 'strategy_native',
      creative_fingerprint TEXT NOT NULL,
      hook_style TEXT,
      cta_style TEXT,
      hashtag_cluster TEXT,
      quality_score NUMERIC(6,2),
      gate_result TEXT DEFAULT 'pending',
      publish_status TEXT DEFAULT 'pending',
      failure_kind TEXT,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgPool.run('blog', `
    CREATE INDEX IF NOT EXISTS idx_marketing_asset_memory_platform_date
    ON blog.marketing_asset_memory(platform, created_at DESC)
  `);
  await pgPool.run('blog', `
    CREATE INDEX IF NOT EXISTS idx_marketing_asset_memory_fingerprint
    ON blog.marketing_asset_memory(creative_fingerprint, created_at DESC)
  `);
  schemaEnsured = true;
}

async function recordMarketingAssetOutcome({
  variant = {},
  qualityScore = null,
  gateResult = 'pending',
  publishStatus = 'pending',
  failureKind = '',
  metadata = {},
} = {}) {
  const variantId = String(variant?.variant_id || '').trim();
  if (!variantId) return { ok: false, reason: 'variant_id_missing' };
  await ensureMarketingAssetMemorySchema();

  const hookStyle = inferHookStyle(variant);
  const ctaStyle = inferCtaStyle(variant);
  const hashtagCluster = inferHashtagCluster(variant);
  const creativeFingerprint = buildCreativeFingerprint(variant);

  await pgPool.query('blog', `
    INSERT INTO blog.marketing_asset_memory
      (variant_id, campaign_id, platform, brand_axis, objective, source_mode,
       creative_fingerprint, hook_style, cta_style, hashtag_cluster,
       quality_score, gate_result, publish_status, failure_kind, metadata, created_at, updated_at)
    VALUES
      ($1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10,
       $11, $12, $13, $14, $15::jsonb, NOW(), NOW())
    ON CONFLICT (variant_id)
    DO UPDATE SET
      campaign_id = EXCLUDED.campaign_id,
      platform = EXCLUDED.platform,
      brand_axis = EXCLUDED.brand_axis,
      objective = EXCLUDED.objective,
      source_mode = EXCLUDED.source_mode,
      creative_fingerprint = EXCLUDED.creative_fingerprint,
      hook_style = EXCLUDED.hook_style,
      cta_style = EXCLUDED.cta_style,
      hashtag_cluster = EXCLUDED.hashtag_cluster,
      quality_score = EXCLUDED.quality_score,
      gate_result = EXCLUDED.gate_result,
      publish_status = EXCLUDED.publish_status,
      failure_kind = EXCLUDED.failure_kind,
      metadata = COALESCE(blog.marketing_asset_memory.metadata, '{}'::jsonb) || COALESCE(EXCLUDED.metadata, '{}'::jsonb),
      updated_at = NOW()
  `, [
    variantId,
    String(variant?.campaign_id || '').trim() || null,
    String(variant?.platform || 'unknown').trim(),
    String(variant?.brand_axis || 'mixed').trim(),
    String(variant?.objective || 'awareness').trim(),
    String(variant?.source_mode || 'strategy_native').trim(),
    creativeFingerprint,
    hookStyle,
    ctaStyle,
    hashtagCluster,
    qualityScore != null ? toNumber(qualityScore, null) : null,
    String(gateResult || 'pending').trim(),
    String(publishStatus || 'pending').trim(),
    String(failureKind || '').trim() || null,
    JSON.stringify(metadata || {}),
  ]);

  return {
    ok: true,
    variantId,
    creativeFingerprint,
    hookStyle,
    ctaStyle,
    hashtagCluster,
  };
}

function classifyCreativeLane(successRate = 0, avgQuality = 0, samples = 0) {
  if (samples < 2) return 'warming_up';
  if (successRate >= 0.8 && avgQuality >= 70) return 'winner';
  if (successRate <= 0.4 || avgQuality < 55) return 'loser';
  return 'stable';
}

async function listCreativeLanes({ days = 28, platform = '', limit = 12 } = {}) {
  await ensureMarketingAssetMemorySchema();
  const rows = await pgPool.query('blog', `
    SELECT
      platform,
      creative_fingerprint,
      COUNT(*)::int AS samples,
      COUNT(*) FILTER (WHERE publish_status IN ('published', 'success', 'ok'))::int AS success_count,
      COUNT(*) FILTER (WHERE publish_status IN ('failed', 'blocked'))::int AS fail_count,
      COALESCE(AVG(COALESCE(quality_score, 0)), 0)::float AS avg_quality
    FROM blog.marketing_asset_memory
    WHERE created_at >= NOW() - ($1::text || ' days')::interval
      AND ($2 = '' OR platform = $2)
    GROUP BY platform, creative_fingerprint
    ORDER BY samples DESC, avg_quality DESC
    LIMIT $3
  `, [Math.max(1, Number(days || 28)), String(platform || ''), Math.max(1, Number(limit || 12))]);

  return (rows || []).map((row) => {
    const samples = toNumber(row.samples, 0);
    const successCount = toNumber(row.success_count, 0);
    const successRate = samples > 0 ? Number((successCount / samples).toFixed(4)) : 0;
    const avgQuality = toNumber(row.avg_quality, 0);
    return {
      platform: String(row.platform || ''),
      creativeFingerprint: String(row.creative_fingerprint || ''),
      samples,
      successCount,
      failCount: toNumber(row.fail_count, 0),
      successRate,
      avgQuality,
      lane: classifyCreativeLane(successRate, avgQuality, samples),
    };
  });
}

async function detectFormatSaturation({ days = 14, threshold = 0.6 } = {}) {
  const lanes = await listCreativeLanes({ days, limit: 200 });
  const byPlatform = lanes.reduce((acc, lane) => {
    const key = lane.platform || 'unknown';
    if (!acc[key]) acc[key] = [];
    acc[key].push(lane);
    return acc;
  }, {});

  const results = [];
  for (const [platform, items] of Object.entries(byPlatform)) {
    const total = items.reduce((sum, item) => sum + Number(item.samples || 0), 0);
    if (total < 4) {
      results.push({
        platform,
        totalSamples: total,
        saturationRatio: 0,
        saturated: false,
        topFingerprint: null,
      });
      continue;
    }
    const top = items.slice().sort((a, b) => Number(b.samples || 0) - Number(a.samples || 0))[0];
    const ratio = total > 0 ? Number((Number(top.samples || 0) / total).toFixed(4)) : 0;
    results.push({
      platform,
      totalSamples: total,
      saturationRatio: ratio,
      saturated: ratio >= Number(threshold || 0.6),
      topFingerprint: top?.creativeFingerprint || null,
      topLane: top?.lane || null,
      topSamples: Number(top?.samples || 0),
    });
  }

  return results.sort((a, b) => Number(b.saturationRatio || 0) - Number(a.saturationRatio || 0));
}

async function getAssetMemorySnapshot({ laneDays = 28, saturationDays = 14 } = {}) {
  const [lanes, saturation] = await Promise.all([
    listCreativeLanes({ days: laneDays, limit: 20 }),
    detectFormatSaturation({ days: saturationDays, threshold: 0.6 }),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    winners: lanes.filter((item) => item.lane === 'winner').slice(0, 5),
    losers: lanes.filter((item) => item.lane === 'loser').slice(0, 5),
    warmingUp: lanes.filter((item) => item.lane === 'warming_up').slice(0, 5),
    saturation,
  };
}

module.exports = {
  ensureMarketingAssetMemorySchema,
  inferHookStyle,
  inferCtaStyle,
  inferHashtagCluster,
  buildCreativeFingerprint,
  recordMarketingAssetOutcome,
  listCreativeLanes,
  detectFormatSaturation,
  getAssetMemorySnapshot,
};

