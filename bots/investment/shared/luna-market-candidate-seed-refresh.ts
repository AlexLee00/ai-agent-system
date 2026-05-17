// @ts-nocheck
/**
 * Shadow-safe market candidate seed refresh.
 *
 * Domestic/overseas community coverage can pass while active candidates remain
 * empty because recent evidence is marketwide. This module turns marketwide
 * evidence into low-priority candidate_universe seeds without changing live
 * trading priority.
 */

import { query } from './db/core.ts';

export const LUNA_MARKET_CANDIDATE_SEED_SOURCE = 'luna_market_candidate_seed_refresh';

const SUPPORTED_MARKETS = ['domestic', 'overseas'];

export const DEFAULT_MARKET_SEED_WATCHLIST = {
  domestic: [
    { symbol: '005930', label: 'Samsung Electronics', aliases: ['삼성전자', '삼성', '반도체', '메모리', 'hbm'] },
    { symbol: '000660', label: 'SK Hynix', aliases: ['sk하이닉스', '하이닉스', '반도체', '메모리', 'hbm'] },
    { symbol: '035420', label: 'NAVER', aliases: ['네이버', 'naver', '검색', '커머스', '웹툰'] },
    { symbol: '035720', label: 'Kakao', aliases: ['카카오', 'kakao', '플랫폼', '톡비즈'] },
    { symbol: '051910', label: 'LG Chem', aliases: ['lg화학', '배터리', '2차전지', '화학'] },
    { symbol: '207940', label: 'Samsung Biologics', aliases: ['삼성바이오로직스', '바이오', '의약품', 'cdmo'] },
  ],
  overseas: [
    { symbol: 'NVDA', label: 'NVIDIA', aliases: ['nvidia', '엔비디아', 'gpu', 'blackwell', 'ai chip', 'ai 반도체'] },
    { symbol: 'MSFT', label: 'Microsoft', aliases: ['microsoft', 'msft', '마이크로소프트', 'azure', 'copilot'] },
    { symbol: 'AAPL', label: 'Apple', aliases: ['apple', 'aapl', '애플', 'iphone', 'ios'] },
    { symbol: 'AMZN', label: 'Amazon', aliases: ['amazon', 'amzn', '아마존', 'aws', 'ecommerce'] },
    { symbol: 'GOOGL', label: 'Alphabet', aliases: ['google', 'alphabet', 'googl', '구글', 'gemini'] },
    { symbol: 'META', label: 'Meta', aliases: ['meta', '메타', 'facebook', 'instagram', 'llama'] },
    { symbol: 'TSLA', label: 'Tesla', aliases: ['tesla', 'tsla', '테슬라', 'ev', '전기차'] },
  ],
};

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

export function normalizeMarketCandidateSeedMarket(value = '') {
  const market = String(value || '').trim().toLowerCase();
  if (market === 'kis') return 'domestic';
  if (market === 'kis_overseas' || market === 'us' || market === 'usa') return 'overseas';
  return SUPPORTED_MARKETS.includes(market) ? market : null;
}

function normalizeMarkets(markets: any = null) {
  const raw = Array.isArray(markets)
    ? markets
    : String(markets || 'domestic,overseas').split(',');
  const normalized = raw
    .map((market) => normalizeMarketCandidateSeedMarket(market))
    .filter(Boolean);
  return [...new Set(normalized)].length > 0 ? [...new Set(normalized)] : [...SUPPORTED_MARKETS];
}

function eventText(event: any = {}) {
  const rawRef = event.raw_ref || event.rawRef || {};
  const rawText = [
    event.evidence_summary,
    event.source_name,
    event.source_url,
    rawRef.title,
    rawRef.summary,
    rawRef.description,
    rawRef.link,
    rawRef.source,
  ].filter(Boolean).join(' ');
  return rawText.toLowerCase();
}

function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesAlias(text: string, alias: string) {
  const normalized = String(alias || '').toLowerCase().trim();
  if (!normalized) return false;
  if (/^[a-z0-9 ._-]+$/.test(normalized)) {
    const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegex(normalized)}([^a-z0-9]|$)`, 'i');
    return pattern.test(text);
  }
  return text.includes(normalized);
}

function scoreSeed(seed: any, events: any[] = [], options: any = {}) {
  const aliases = (seed.aliases || []).map((alias) => String(alias || '').toLowerCase()).filter(Boolean);
  const matchedEvents = [];
  const matchedAliases = new Set();
  for (const event of events) {
    const text = eventText(event);
    const hits = aliases.filter((alias) => matchesAlias(text, alias));
    if (hits.length > 0) {
      matchedEvents.push(event);
      hits.forEach((hit) => matchedAliases.add(hit));
    }
  }

  const eventCount = events.length;
  const uniqueSources = new Set(events.map((event) => String(event.source_name || event.sourceName || 'unknown'))).size;
  const avgFreshness = eventCount
    ? events.reduce((sum, event) => sum + clamp(event.freshness_score ?? event.freshnessScore, 0, 1, 0.5), 0) / eventCount
    : 0;
  const avgSourceQuality = eventCount
    ? events.reduce((sum, event) => sum + clamp(event.source_quality ?? event.sourceQuality, 0, 1, 0.5), 0) / eventCount
    : 0;
  const matchedSourceCount = new Set(matchedEvents.map((event) => String(event.source_name || event.sourceName || 'unknown'))).size;
  const hasAliasMatch = matchedEvents.length > 0;
  const base = hasAliasMatch ? 0.50 : 0.43;
  const score = clamp(
    base
      + Math.min(0.13, eventCount * 0.008)
      + Math.min(0.12, uniqueSources * 0.025)
      + (avgFreshness * 0.08)
      + (avgSourceQuality * 0.08)
      + Math.min(0.14, matchedEvents.length * 0.025)
      + Math.min(0.06, matchedSourceCount * 0.02),
    0.35,
    hasAliasMatch ? 0.82 : 0.64,
    0.45,
  );

  return {
    symbol: seed.symbol,
    score: round(score),
    reason: hasAliasMatch
      ? `marketwide community evidence matched ${seed.label}`
      : `marketwide community coverage seed for ${seed.label}`,
    confidence: round(clamp(0.42 + uniqueSources * 0.04 + avgFreshness * 0.12 + avgSourceQuality * 0.12 + (hasAliasMatch ? 0.10 : 0), 0.35, 0.78, 0.5)),
    reasonCode: hasAliasMatch ? 'marketwide_symbol_hint' : 'marketwide_fallback_seed',
    evidenceRef: {
      source: LUNA_MARKET_CANDIDATE_SEED_SOURCE,
      marketwideEvidenceCount: eventCount,
      uniqueSourceCount: uniqueSources,
      matchedEventCount: matchedEvents.length,
      matchedSourceCount,
    },
    qualityFlags: [
      'shadow_seed',
      'marketwide_community_evidence',
      hasAliasMatch ? 'alias_match' : 'marketwide_fallback',
    ],
    raw: {
      source: LUNA_MARKET_CANDIDATE_SEED_SOURCE,
      shadowSeed: true,
      liveMutation: false,
      seedLabel: seed.label,
      marketwideEvidenceCount: eventCount,
      uniqueSourceCount: uniqueSources,
      avgFreshness: round(avgFreshness),
      avgSourceQuality: round(avgSourceQuality),
      matchedEventCount: matchedEvents.length,
      matchedSources: [...new Set(matchedEvents.map((event) => String(event.source_name || event.sourceName || 'unknown')))],
      matchedAliases: Array.from(matchedAliases),
      sampledEvidence: matchedEvents.slice(0, 3).map((event) => ({
        sourceName: event.source_name || event.sourceName || null,
        evidenceSummary: event.evidence_summary || event.evidenceSummary || null,
        createdAt: event.created_at || event.createdAt || null,
      })),
      thresholds: {
        minMarketwideEvents: Number(options.minEvents || 3),
        minUniqueSources: Number(options.minUniqueSources || 1),
      },
    },
  };
}

export function buildLunaMarketCandidateSeedPlan(input: any = {}) {
  const markets = normalizeMarkets(input.markets);
  const events = Array.isArray(input.events) ? input.events : [];
  const limit = Math.max(1, Number(input.limit || 5));
  const minEvents = Math.max(1, Number(input.minEvents || 3));
  const minUniqueSources = Math.max(1, Number(input.minUniqueSources || 1));
  const watchlist = input.watchlist || DEFAULT_MARKET_SEED_WATCHLIST;

  const byMarket = new Map();
  for (const event of events) {
    const market = normalizeMarketCandidateSeedMarket(event.market);
    if (!market || !markets.includes(market)) continue;
    if (!byMarket.has(market)) byMarket.set(market, []);
    byMarket.get(market).push(event);
  }

  const marketPlans = markets.map((market) => {
    const marketEvents = byMarket.get(market) || [];
    const uniqueSources = new Set(marketEvents.map((event) => String(event.source_name || event.sourceName || 'unknown'))).size;
    const blockers = [];
    if (marketEvents.length < minEvents) blockers.push(`marketwide_events<${minEvents}`);
    if (uniqueSources < minUniqueSources) blockers.push(`marketwide_sources<${minUniqueSources}`);

    const signals = blockers.length === 0
      ? (watchlist[market] || [])
        .map((seed) => scoreSeed(seed, marketEvents, { minEvents, minUniqueSources }))
        .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
        .slice(0, limit)
      : [];

    return {
      market,
      eventCount: marketEvents.length,
      uniqueSourceCount: uniqueSources,
      pass: blockers.length === 0,
      blockers,
      plannedSignals: signals.length,
      signals,
    };
  });

  const blockers = marketPlans.flatMap((plan) => plan.blockers.map((reason) => `${plan.market}:${reason}`));
  return {
    ok: blockers.length === 0,
    generatedAt: new Date().toISOString(),
    source: LUNA_MARKET_CANDIDATE_SEED_SOURCE,
    shadowOnly: true,
    liveMutation: false,
    markets: marketPlans,
    blockers,
    summary: {
      markets: marketPlans.length,
      passMarkets: marketPlans.filter((plan) => plan.pass).length,
      plannedSignals: marketPlans.reduce((sum, plan) => sum + plan.plannedSignals, 0),
      totalEvents: marketPlans.reduce((sum, plan) => sum + plan.eventCount, 0),
      totalUniqueSources: marketPlans.reduce((sum, plan) => sum + plan.uniqueSourceCount, 0),
    },
  };
}

export async function fetchLunaMarketCandidateSeedEvents(options: any = {}) {
  const hours = Math.max(1, Number(options.hours || 24));
  const markets = normalizeMarkets(options.markets);
  return query(
    `SELECT market, source_name, source_url, score, source_quality, freshness_score,
            evidence_summary, raw_ref, created_at
       FROM external_evidence_events
      WHERE source_type = 'community'
        AND symbol IS NULL
        AND market = ANY($2::text[])
        AND created_at >= NOW() - ($1::int * INTERVAL '1 hour')
        AND COALESCE(source_name, '') <> 'community_candidate_gap'
        AND COALESCE(source_name, '') NOT LIKE 'fixture_%'
        AND COALESCE(source_name, '') <> 'cryptopanic_news'
        AND COALESCE((raw_ref->>'missing_data')::boolean, false) = false
      ORDER BY created_at DESC
      LIMIT $3`,
    [hours, markets, Math.max(10, Number(options.eventLimit || 500))],
  ).catch(() => []);
}

export function fixtureLunaMarketCandidateSeedEvents() {
  const now = new Date().toISOString();
  return [
    { market: 'domestic', source_name: 'naver_market_news_rss', source_quality: 0.72, freshness_score: 0.92, evidence_summary: '삼성전자와 SK하이닉스 HBM 반도체 수요 확대', created_at: now },
    { market: 'domestic', source_name: 'toss_market_news', source_quality: 0.68, freshness_score: 0.86, evidence_summary: '네이버 커머스와 플랫폼 업종 투자심리 회복', created_at: now },
    { market: 'domestic', source_name: 'dart_disclosure', source_quality: 0.78, freshness_score: 0.80, evidence_summary: '국내 대형주 실적 공시와 바이오 업종 주목', created_at: now },
    { market: 'overseas', source_name: 'reuters_business_rss', source_quality: 0.76, freshness_score: 0.88, evidence_summary: 'NVIDIA Blackwell GPU demand supports AI chip names', created_at: now },
    { market: 'overseas', source_name: 'marketwatch_rss', source_quality: 0.70, freshness_score: 0.82, evidence_summary: 'Microsoft Azure and Amazon AWS cloud capex in focus', created_at: now },
    { market: 'overseas', source_name: 'yahoo_finance_rss', source_quality: 0.66, freshness_score: 0.81, evidence_summary: 'Apple iPhone cycle and Tesla EV margins move megacap sentiment', created_at: now },
  ];
}

export default {
  LUNA_MARKET_CANDIDATE_SEED_SOURCE,
  DEFAULT_MARKET_SEED_WATCHLIST,
  normalizeMarketCandidateSeedMarket,
  buildLunaMarketCandidateSeedPlan,
  fetchLunaMarketCandidateSeedEvents,
  fixtureLunaMarketCandidateSeedEvents,
};
