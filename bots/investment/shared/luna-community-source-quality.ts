// @ts-nocheck
/**
 * Luna community source quality loop.
 *
 * Read-only audit over investment.external_evidence_events that estimates which
 * community/news sources deserve more or less weight before the next collection
 * cycle writes fresh evidence. It intentionally avoids mutating historical
 * evidence so live decisions can be audited against the original inputs.
 */

import * as db from './db.ts';

const COMMUNITY_QUALITY_CAP = 0.60;
const RETIRED_COMMUNITY_SOURCES = new Set([
  'cryptopanic_news',
]);

function n(value: any, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: any, min = 0, max = 1, fallback = 0) {
  return Math.max(min, Math.min(max, n(value, fallback)));
}

function round(value: any, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(n(value, 0) * factor) / factor;
}

function sourceKey({ sourceType = 'community', sourceName = 'unknown', market = 'marketwide' } = {}) {
  return `${String(sourceType || 'community').toLowerCase()}|${String(sourceName || 'unknown').toLowerCase()}|${String(market || 'marketwide').toLowerCase()}`;
}

function normalizeRow(row: any = {}) {
  const predictiveRaw = row.predictive_fire_rate ?? row.predictiveFireRate;
  const backtestRaw = row.backtest_pass_rate ?? row.backtestPassRate;
  return {
    sourceType: row.source_type || row.sourceType || 'community',
    sourceName: row.source_name || row.sourceName || 'unknown',
    market: row.market || 'marketwide',
    eventCount: n(row.event_count ?? row.eventCount, 0),
    symbolEventCount: n(row.symbol_event_count ?? row.symbolEventCount, 0),
    marketEventCount: n(row.market_event_count ?? row.marketEventCount, 0),
    distinctSymbols: n(row.distinct_symbols ?? row.distinctSymbols, 0),
    avgSourceQuality: clamp(row.avg_source_quality ?? row.avgSourceQuality, 0, COMMUNITY_QUALITY_CAP, 0.35),
    avgFreshness: clamp(row.avg_freshness ?? row.avgFreshness, 0, 1, 0.5),
    avgScore: clamp(row.avg_score ?? row.avgScore, -1, 1, 0),
    avgBotNoise: clamp(row.avg_bot_noise ?? row.avgBotNoise, 0, 1, 0),
    hypeSpikeRate: clamp(row.hype_spike_rate ?? row.hypeSpikeRate, 0, 1, 0),
    missingErrorRate: clamp(row.missing_error_rate ?? row.missingErrorRate, 0, 1, 0),
    predictiveFireRate: predictiveRaw == null ? null : clamp(predictiveRaw, 0, 1, 0),
    backtestPassRate: backtestRaw == null ? null : clamp(backtestRaw, 0, 1, 0),
    lastSeenAt: row.last_seen_at || row.lastSeenAt || null,
  };
}

export function scoreCommunitySourceQuality(row: any = {}, options: any = {}) {
  const minEvents = Math.max(1, n(options.minEvents, 3));
  const item = normalizeRow(row);
  const base = item.avgSourceQuality || 0.35;
  const samplePenalty = item.eventCount < minEvents ? 0.08 : 0;
  const freshnessAdjustment = (item.avgFreshness - 0.5) * 0.12;
  const botPenalty = item.avgBotNoise * 0.18;
  const hypePenalty = item.hypeSpikeRate * 0.10;
  const missingPenalty = item.missingErrorRate * 0.25;
  const predictiveAdjustment = item.predictiveFireRate == null ? 0 : (item.predictiveFireRate - 0.5) * 0.08;
  const backtestAdjustment = item.backtestPassRate == null ? 0 : (item.backtestPassRate - 0.5) * 0.10;

  const recommended = clamp(
    base + freshnessAdjustment + predictiveAdjustment + backtestAdjustment - botPenalty - hypePenalty - missingPenalty - samplePenalty,
    0.05,
    COMMUNITY_QUALITY_CAP,
    base,
  );
  const multiplier = base > 0 ? clamp(recommended / base, 0.35, 1.35, 1) : 1;

  const reasons = [];
  if (item.eventCount < minEvents) reasons.push('insufficient_sample');
  if (item.missingErrorRate >= 0.30) reasons.push('source_errors_or_missing_data');
  if (item.avgBotNoise >= 0.45) reasons.push('bot_noise_risk');
  if (item.hypeSpikeRate >= 0.40) reasons.push('hype_spike_risk');
  if (item.avgFreshness < 0.35) reasons.push('stale_source');
  if (item.predictiveFireRate != null && item.predictiveFireRate < 0.20) reasons.push('low_predictive_followthrough');
  if (item.backtestPassRate != null && item.backtestPassRate < 0.25) reasons.push('low_backtest_followthrough');

  let status = 'observe';
  if (recommended <= 0.18 || item.missingErrorRate >= 0.50 || item.avgBotNoise >= 0.70) status = 'block_candidate';
  else if (multiplier <= 0.95) status = 'downweight';
  else if (item.eventCount >= minEvents && reasons.length === 0 && multiplier >= 1.10) status = 'boost';

  return {
    ...item,
    status,
    baseQuality: round(base),
    recommendedQuality: round(recommended),
    multiplier: round(multiplier),
    reasons,
  };
}

export function buildLunaCommunitySourceQualityAudit(input: any = {}) {
  const days = Math.max(1, n(input.days, 7));
  const minEvents = Math.max(1, n(input.minEvents, 3));
  const rows = Array.isArray(input.rows) ? input.rows : [];
  const sources = rows
    .filter((row) => !RETIRED_COMMUNITY_SOURCES.has(String(row.source_name || row.sourceName || '').toLowerCase()))
    .map((row) => scoreCommunitySourceQuality(row, { minEvents }))
    .sort((a, b) => {
      if (a.status === b.status) return a.recommendedQuality - b.recommendedQuality;
      const order = { block_candidate: 0, downweight: 1, observe: 2, boost: 3 };
      return (order[a.status] ?? 9) - (order[b.status] ?? 9);
    });

  const marketMap = new Map();
  for (const source of sources) {
    const market = source.market || 'marketwide';
    const existing = marketMap.get(market) || {
      market,
      eventCount: 0,
      readySources: 0,
      downweightedSources: 0,
      blockedSources: 0,
      distinctSources: 0,
      avgRecommendedQuality: 0,
    };
    existing.eventCount += source.eventCount;
    existing.distinctSources += 1;
    existing.readySources += source.status === 'observe' || source.status === 'boost' ? 1 : 0;
    existing.downweightedSources += source.status === 'downweight' ? 1 : 0;
    existing.blockedSources += source.status === 'block_candidate' ? 1 : 0;
    existing.avgRecommendedQuality += source.recommendedQuality;
    marketMap.set(market, existing);
  }
  const markets = [...marketMap.values()].map((market) => ({
    ...market,
    avgRecommendedQuality: round(market.avgRecommendedQuality / Math.max(1, market.distinctSources)),
  }));

  const blockers = [];
  const warnings = [];
  if (sources.length === 0) warnings.push('no_community_source_quality_rows');
  for (const market of markets) {
    if (market.readySources === 0 && market.eventCount > 0) warnings.push(`no_ready_source:${market.market}`);
  }
  const blockedSources = sources.filter((source) => source.status === 'block_candidate');
  if (blockedSources.length > Math.max(3, Math.ceil(sources.length * 0.5))) {
    blockers.push('majority_community_sources_block_candidate');
  }

  return {
    ok: blockers.length === 0,
    days,
    minEvents,
    generatedAt: new Date().toISOString(),
    totalSources: sources.length,
    blockers,
    warnings,
    markets,
    sources,
    overrides: buildSourceQualityMultiplierMap({ sources }),
  };
}

export function buildSourceQualityMultiplierMap(report: any = {}) {
  const map = {};
  for (const source of report.sources || []) {
    map[sourceKey(source)] = {
      status: source.status,
      multiplier: source.multiplier,
      recommendedQuality: source.recommendedQuality,
      reasons: source.reasons || [],
    };
  }
  return map;
}

export function adjustCommunitySourceQuality(event: any = {}, overrides: any = {}) {
  const market = event.market || 'marketwide';
  const exact = overrides[sourceKey({
    sourceType: event.sourceType || event.source_type || 'community',
    sourceName: event.sourceName || event.source_name || 'unknown',
    market,
  })];
  const marketwide = overrides[sourceKey({
    sourceType: event.sourceType || event.source_type || 'community',
    sourceName: event.sourceName || event.source_name || 'unknown',
    market: 'marketwide',
  })];
  const override = exact || marketwide || null;
  const original = clamp(event.sourceQuality ?? event.source_quality, 0, COMMUNITY_QUALITY_CAP, 0.35);
  if (!override) return { sourceQuality: round(original), applied: false, override: null };
  let adjusted = original;
  if (override.status === 'block_candidate') {
    adjusted = Math.min(original, 0.12);
  } else if (override.status === 'downweight') {
    adjusted = Math.min(original, clamp(original * clamp(override.multiplier, 0.35, 1, 1), 0.05, COMMUNITY_QUALITY_CAP, original));
  } else if (override.status === 'boost') {
    adjusted = Math.max(original, clamp(original * clamp(override.multiplier, 1, 1.35, 1), 0.05, COMMUNITY_QUALITY_CAP, original));
  }
  return {
    sourceQuality: round(adjusted),
    applied: Math.abs(adjusted - original) >= 0.0005,
    override,
  };
}

export async function fetchLunaCommunitySourceQualityAudit(options: any = {}) {
  const days = Math.max(1, n(options.days, 7));
  const minEvents = Math.max(1, n(options.minEvents, 3));
  const market = options.market ? String(options.market) : null;
  const rows = await db.query(
    `WITH evidence AS (
       SELECT source_type,
              COALESCE(NULLIF(source_name, ''), 'unknown') AS source_name,
              COALESCE(NULLIF(market, ''), 'marketwide') AS market,
              symbol,
              score,
              source_quality,
              freshness_score,
              raw_ref,
              created_at,
              CASE
                WHEN COALESCE(raw_ref->'botNoise'->>'score', raw_ref->>'bot_noise_score', '0') ~ '^[-0-9.]+$'
                THEN COALESCE(raw_ref->'botNoise'->>'score', raw_ref->>'bot_noise_score', '0')::double precision
                ELSE 0
              END AS bot_noise_score,
              LOWER(COALESCE(raw_ref->'hypeSpike'->>'detected', raw_ref->>'hype_spike', 'false')) IN ('true','1','yes') AS hype_spike_detected,
              (jsonb_exists(raw_ref, 'missing_secret')
                OR jsonb_exists(raw_ref, 'source_error')
                OR jsonb_exists(raw_ref, 'missing_data')
                OR LOWER(COALESCE(raw_ref->>'missingData', raw_ref->>'missing_data', 'false')) IN ('true','1','yes')) AS missing_or_error
         FROM external_evidence_events
        WHERE source_type = 'community'
          AND created_at >= NOW() - ($1::int * INTERVAL '1 day')
          AND COALESCE(source_name, '') <> 'community_candidate_gap'
          AND COALESCE(source_name, '') NOT LIKE 'fixture_%'
          AND COALESCE(source_name, '') <> 'cryptopanic_news'
          AND ($2::text IS NULL OR COALESCE(NULLIF(market, ''), 'marketwide') = $2::text)
     ),
     latest_predictive AS (
       SELECT DISTINCT ON (symbol, market)
              symbol, market, decision, score, created_at
         FROM predictive_validation_log
        WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
          AND symbol IS NOT NULL
        ORDER BY symbol, market, created_at DESC
     ),
     latest_backtest AS (
       SELECT DISTINCT ON (symbol, market)
              symbol, market, gate_status, healthy, updated_at
         FROM candidate_backtest_status
        WHERE updated_at >= NOW() - (($1::int + 7) * INTERVAL '1 day')
        ORDER BY symbol, market, updated_at DESC
     )
     SELECT e.source_type,
            e.source_name,
            e.market,
            COUNT(*)::int AS event_count,
            COUNT(e.symbol)::int AS symbol_event_count,
            SUM(CASE WHEN e.symbol IS NULL THEN 1 ELSE 0 END)::int AS market_event_count,
            COUNT(DISTINCT e.symbol)::int AS distinct_symbols,
            AVG(e.source_quality)::double precision AS avg_source_quality,
            AVG(e.freshness_score)::double precision AS avg_freshness,
            AVG(e.score)::double precision AS avg_score,
            AVG(e.bot_noise_score)::double precision AS avg_bot_noise,
            AVG(CASE WHEN e.hype_spike_detected THEN 1.0 ELSE 0.0 END)::double precision AS hype_spike_rate,
            AVG(CASE WHEN e.missing_or_error THEN 1.0 ELSE 0.0 END)::double precision AS missing_error_rate,
            AVG(CASE WHEN p.decision IS NULL THEN NULL WHEN p.decision IN ('fire','pass') THEN 1.0 ELSE 0.0 END)::double precision AS predictive_fire_rate,
            AVG(CASE WHEN b.gate_status IS NULL THEN NULL WHEN b.gate_status = 'pass' AND b.healthy IS TRUE THEN 1.0 ELSE 0.0 END)::double precision AS backtest_pass_rate,
            MAX(e.created_at) AS last_seen_at
       FROM evidence e
       LEFT JOIN latest_predictive p
         ON p.symbol = e.symbol AND p.market = e.market
       LEFT JOIN latest_backtest b
         ON b.symbol = e.symbol AND b.market = e.market
      GROUP BY e.source_type, e.source_name, e.market
      ORDER BY event_count DESC, e.source_name ASC`,
    [days, market],
  ).catch((error) => {
    return [{ source_name: 'audit_query_error', market: market || 'marketwide', event_count: 1, avg_source_quality: 0.05, missing_error_rate: 1, raw_error: String(error?.message || error) }];
  });
  const report = buildLunaCommunitySourceQualityAudit({ rows, days, minEvents });
  if (rows.length === 1 && rows[0]?.source_name === 'audit_query_error') {
    report.ok = false;
    report.blockers.push('community_source_quality_query_failed');
  }
  return report;
}

export default {
  scoreCommunitySourceQuality,
  buildLunaCommunitySourceQualityAudit,
  buildSourceQualityMultiplierMap,
  adjustCommunitySourceQuality,
  fetchLunaCommunitySourceQualityAudit,
};
