// @ts-nocheck
/**
 * Luna community coverage gate.
 *
 * Read-only coverage audit across crypto/domestic/overseas community evidence.
 * It does not write evidence and does not affect trading priority.
 */

import { query } from './db/core.ts';

export const DEFAULT_COMMUNITY_COVERAGE_THRESHOLDS = {
  crypto: { minEvents: 20, minUniqueSources: 4 },
  domestic: { minEvents: 10, minUniqueSources: 3 },
  overseas: { minEvents: 10, minUniqueSources: 3 },
  common: {
    minAvgFreshness: 0.50,
    maxMissingErrorRate: 0.35,
    maxBotNoiseRate: 0.40,
    maxHypeSpikeRate: 0.45,
  },
};

const REQUIRED_MARKETS = ['crypto', 'domestic', 'overseas'];

function n(value: any, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: any, min = 0, max = 1, fallback = 0) {
  return Math.max(min, Math.min(max, n(value, fallback)));
}

function round(value: any, digits = 4) {
  return Number(n(value, 0).toFixed(digits));
}

function normalizeMarket(value = '') {
  const market = String(value || '').trim().toLowerCase();
  if (market === 'binance') return 'crypto';
  if (market === 'kis') return 'domestic';
  if (market === 'kis_overseas' || market === 'us' || market === 'usa') return 'overseas';
  if (REQUIRED_MARKETS.includes(market)) return market;
  return market || 'unknown';
}

function thresholdForMarket(market: string, thresholds = DEFAULT_COMMUNITY_COVERAGE_THRESHOLDS) {
  return {
    ...(thresholds[market] || thresholds.domestic),
    ...(thresholds.common || {}),
  };
}

function normalizeCoverageRow(row: any = {}) {
  return {
    market: normalizeMarket(row.market),
    eventCount: n(row.event_count ?? row.eventCount, 0),
    uniqueSourceCount: n(row.unique_source_count ?? row.uniqueSourceCount, 0),
    avgFreshness: clamp(row.avg_freshness ?? row.avgFreshness, 0, 1, 0),
    avgSourceQuality: clamp(row.avg_source_quality ?? row.avgSourceQuality, 0, 1, 0),
    missingErrorRate: clamp(row.missing_error_rate ?? row.missingErrorRate, 0, 1, 0),
    botNoiseRate: clamp(row.bot_noise_rate ?? row.botNoiseRate, 0, 1, 0),
    hypeSpikeRate: clamp(row.hype_spike_rate ?? row.hypeSpikeRate, 0, 1, 0),
    symbolCount: n(row.symbol_count ?? row.symbolCount, 0),
    newestEventAt: row.newest_event_at || row.newestEventAt || null,
  };
}

export function evaluateCommunityCoverageMarket(row: any = {}, options: any = {}) {
  const item = normalizeCoverageRow(row);
  const thresholds = thresholdForMarket(item.market, options.thresholds || DEFAULT_COMMUNITY_COVERAGE_THRESHOLDS);
  const blockers = [];
  const warnings = [];

  if (item.eventCount < thresholds.minEvents) blockers.push(`events<${thresholds.minEvents}`);
  if (item.uniqueSourceCount < thresholds.minUniqueSources) blockers.push(`sources<${thresholds.minUniqueSources}`);
  if (item.avgFreshness < thresholds.minAvgFreshness) blockers.push(`freshness<${thresholds.minAvgFreshness}`);
  if (item.missingErrorRate > thresholds.maxMissingErrorRate) blockers.push(`missing_error>${thresholds.maxMissingErrorRate}`);
  if (item.botNoiseRate > thresholds.maxBotNoiseRate) blockers.push(`bot_noise>${thresholds.maxBotNoiseRate}`);
  if (item.hypeSpikeRate > thresholds.maxHypeSpikeRate) blockers.push(`hype_spike>${thresholds.maxHypeSpikeRate}`);

  if (item.eventCount === 0) warnings.push('no_recent_community_events');
  if (item.uniqueSourceCount === 0) warnings.push('no_recent_community_sources');
  if (item.symbolCount === 0) warnings.push('marketwide_only_or_unmapped_symbols');

  return {
    ...item,
    pass: blockers.length === 0,
    thresholds,
    blockers,
    warnings,
    recommendedRefreshCommand: 'npm --prefix bots/investment run -s runtime:luna-community-evidence-refresh -- --json',
  };
}

export function buildLunaCommunityCoverageGate(input: any = {}) {
  const hours = Math.max(1, n(input.hours, 24));
  const rows = Array.isArray(input.rows) ? input.rows : [];
  const byMarket = new Map(rows.map((row) => [normalizeMarket(row.market), row]));
  const markets = REQUIRED_MARKETS.map((market) => evaluateCommunityCoverageMarket({
    market,
    ...(byMarket.get(market) || {}),
  }, { thresholds: input.thresholds || DEFAULT_COMMUNITY_COVERAGE_THRESHOLDS }));
  const blockers = markets.flatMap((market) => market.blockers.map((reason) => `community_coverage_gate_failed:${market.market}:${reason}`));
  const warnings = markets.flatMap((market) => market.warnings.map((reason) => `community_coverage_gate_warning:${market.market}:${reason}`));
  if (input.queryError) blockers.push('community_coverage_query_failed');

  return {
    ok: blockers.length === 0,
    generatedAt: new Date().toISOString(),
    hours,
    thresholds: input.thresholds || DEFAULT_COMMUNITY_COVERAGE_THRESHOLDS,
    summary: {
      totalMarkets: markets.length,
      passMarkets: markets.filter((market) => market.pass).length,
      totalEvents: markets.reduce((sum, market) => sum + market.eventCount, 0),
      totalUniqueSources: markets.reduce((sum, market) => sum + market.uniqueSourceCount, 0),
    },
    blockers,
    warnings,
    markets,
    queryError: input.queryError || null,
  };
}

export async function fetchLunaCommunityCoverageGate(options: any = {}) {
  const hours = Math.max(1, n(options.hours, 24));
  let queryError = null;
  const rows = await query(
    `WITH evidence AS (
       SELECT COALESCE(NULLIF(market, ''), 'unknown') AS market,
              COALESCE(NULLIF(source_name, ''), 'unknown') AS source_name,
              symbol,
              source_quality,
              freshness_score,
              COALESCE(raw_ref, '{}'::jsonb) AS raw_ref,
              created_at,
              CASE
                WHEN COALESCE(raw_ref->'botNoise'->>'score', raw_ref->>'bot_noise_score', '0') ~ '^[-+]?[0-9]*\\.?[0-9]+$'
                THEN COALESCE(raw_ref->'botNoise'->>'score', raw_ref->>'bot_noise_score', '0')::double precision
                ELSE 0
              END AS bot_noise_score,
              LOWER(COALESCE(raw_ref->'hypeSpike'->>'detected', raw_ref->>'hype_spike', 'false')) IN ('true','1','yes') AS hype_spike_detected,
              (jsonb_exists(COALESCE(raw_ref, '{}'::jsonb), 'missing_secret')
                OR jsonb_exists(COALESCE(raw_ref, '{}'::jsonb), 'source_error')
                OR jsonb_exists(COALESCE(raw_ref, '{}'::jsonb), 'missing_data')
                OR LOWER(COALESCE(raw_ref->>'missingData', raw_ref->>'missing_data', 'false')) IN ('true','1','yes')) AS missing_or_error
         FROM external_evidence_events
        WHERE source_type = 'community'
          AND created_at >= NOW() - ($1::int * INTERVAL '1 hour')
          AND COALESCE(source_name, '') <> 'community_candidate_gap'
          AND COALESCE(source_name, '') NOT LIKE 'fixture_%'
          AND COALESCE(source_name, '') <> 'cryptopanic_news'
     )
     SELECT market,
            COUNT(*)::int AS event_count,
            COUNT(DISTINCT source_name)::int AS unique_source_count,
            COUNT(DISTINCT symbol) FILTER (WHERE symbol IS NOT NULL)::int AS symbol_count,
            AVG(source_quality)::double precision AS avg_source_quality,
            AVG(freshness_score)::double precision AS avg_freshness,
            AVG(CASE WHEN missing_or_error THEN 1.0 ELSE 0.0 END)::double precision AS missing_error_rate,
            AVG(CASE WHEN bot_noise_score >= 0.50 THEN 1.0 ELSE 0.0 END)::double precision AS bot_noise_rate,
            AVG(CASE WHEN hype_spike_detected THEN 1.0 ELSE 0.0 END)::double precision AS hype_spike_rate,
            MAX(created_at) AS newest_event_at
       FROM evidence
      GROUP BY market
      ORDER BY market ASC`,
    [hours],
  ).catch((error) => {
    queryError = String(error?.message || error);
    return [];
  });
  return buildLunaCommunityCoverageGate({ rows, hours, queryError });
}

export default {
  DEFAULT_COMMUNITY_COVERAGE_THRESHOLDS,
  evaluateCommunityCoverageMarket,
  buildLunaCommunityCoverageGate,
  fetchLunaCommunityCoverageGate,
};
