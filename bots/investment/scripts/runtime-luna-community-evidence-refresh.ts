#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const SHADOW_MODE = process.env.LUNA_COMMUNITY_EVIDENCE_SHADOW_MODE !== 'false';
const DEFAULT_TIMEOUT_MS = Number(process.env.LUNA_COMMUNITY_EVIDENCE_TIMEOUT_MS || 8000);

const TICKER_SYMBOL_MAP: Record<string, string> = {
  BTC: 'BTC/USDT', ETH: 'ETH/USDT', SOL: 'SOL/USDT', BNB: 'BNB/USDT',
  XRP: 'XRP/USDT', ADA: 'ADA/USDT', DOGE: 'DOGE/USDT', AVAX: 'AVAX/USDT',
  DOT: 'DOT/USDT', MATIC: 'MATIC/USDT', LINK: 'LINK/USDT', ATOM: 'ATOM/USDT',
  NEAR: 'NEAR/USDT', ARB: 'ARB/USDT', OP: 'OP/USDT', SUI: 'SUI/USDT',
};

const SYMBOL_KEYWORDS: Record<string, string[]> = {
  'BTC/USDT': ['bitcoin', 'btc', ' satoshi'],
  'ETH/USDT': ['ethereum', 'eth', ' ether '],
  'SOL/USDT': ['solana', ' sol '],
  'BNB/USDT': ['bnb', 'binance coin'],
  'XRP/USDT': ['xrp', 'ripple'],
  'DOGE/USDT': ['doge', 'dogecoin'],
  'ADA/USDT': ['cardano', ' ada '],
  'AVAX/USDT': ['avalanche', 'avax'],
};

const AMBIGUOUS_SHORT_TICKERS = new Set([
  'AI', 'AS', 'AT', 'IN', 'IT', 'ME', 'NO', 'NOT', 'OF', 'ON', 'ONE', 'OR', 'TO', 'US',
]);

function normalizeSymbol(value = '') {
  return String(value || '').trim().toUpperCase();
}

function tickerFromSymbol(symbol = '') {
  return normalizeSymbol(symbol).split('/')[0]?.replace(/[^A-Z0-9]/g, '') || '';
}

function uniq<T>(values: T[]): T[] {
  return [...new Set(values.filter(Boolean))];
}

function isAmbiguousTicker(base = '') {
  const normalized = normalizeSymbol(base);
  return normalized.length <= 2 || AMBIGUOUS_SHORT_TICKERS.has(normalized);
}

function keywordsForSymbol(symbol = '') {
  const normalized = normalizeSymbol(symbol);
  const base = tickerFromSymbol(normalized);
  const configured = SYMBOL_KEYWORDS[normalized] || [];
  const ticker = base.toLowerCase();
  const strict = [
    `$${ticker}`,
    `#${ticker}`,
    `${ticker}/usdt`,
    `${ticker}-usdt`,
    `${ticker}usdt`,
  ];
  const dynamic = isAmbiguousTicker(base)
    ? strict
    : [
      base,
      base.length >= 3 ? ` ${ticker} ` : null,
      base.length >= 3 ? `#${ticker}` : null,
      normalized.replace('/USDT', '').toLowerCase(),
      ...strict,
    ].filter(Boolean);
  return uniq([...configured, ...dynamic].map((item) => String(item).toLowerCase()));
}

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesKeyword(text = '', keyword = '') {
  const lower = String(text || '').toLowerCase();
  const kw = String(keyword || '').trim().toLowerCase();
  if (kw.length < 2) return false;
  if (isAmbiguousTicker(kw.toUpperCase())) return false;
  if (kw.startsWith('$') || kw.startsWith('#') || kw.includes('/') || kw.includes('-') || kw.endsWith('usdt')) {
    return lower.includes(kw);
  }
  if (kw.startsWith(' ') || kw.endsWith(' ') || kw.includes(' ')) {
    return lower.includes(kw);
  }
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(kw)}([^a-z0-9]|$)`).test(lower);
}

async function getActiveCryptoCandidateSymbols(limit = 60): Promise<string[]> {
  const rows = await db.query(
    `WITH active_candidates AS (
      SELECT DISTINCT ON (symbol, market)
             symbol, score, discovered_at
        FROM candidate_universe
       WHERE expires_at > NOW()
         AND market = 'crypto'
       ORDER BY symbol, market, score DESC, discovered_at DESC
    )
    SELECT symbol
      FROM active_candidates
     ORDER BY score DESC, discovered_at DESC
     LIMIT $1`,
    [limit],
  ).catch(() => []);
  return rows.map((row: any) => normalizeSymbol(row.symbol)).filter((symbol: string) => symbol.endsWith('/USDT'));
}

function buildTickerSymbolMap(activeSymbols: string[] = []) {
  const map = { ...TICKER_SYMBOL_MAP };
  for (const symbol of activeSymbols) {
    const ticker = tickerFromSymbol(symbol);
    if (ticker && !map[ticker]) map[ticker] = symbol;
  }
  return map;
}

const BULLISH_KW = [
  'bull', 'moon', 'pump', 'buy', 'long', 'rally', 'surge', 'breakout', 'ath',
  'gain', 'profit', 'uptrend', 'accumulate', 'hodl', 'bullish', 'green', 'rip',
  'explode', 'launch', 'rocketship', 'to the moon',
];
const BEARISH_KW = [
  'bear', 'dump', 'sell', 'short', 'crash', 'drop', 'correction', 'dip',
  'loss', 'bearish', 'red', 'collapse', 'fear', 'capitulate', 'downtrend',
  'rekt', 'liquidat', 'bankrupt',
];

function argValue(name: string, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function inferDirection(text: string): 'bullish' | 'bearish' | 'neutral' {
  const lower = String(text || '').toLowerCase();
  const bullScore = BULLISH_KW.filter((kw) => lower.includes(kw)).length;
  const bearScore = BEARISH_KW.filter((kw) => lower.includes(kw)).length;
  if (bullScore > bearScore) return 'bullish';
  if (bearScore > bullScore) return 'bearish';
  return 'neutral';
}

function directionScore(direction: string, magnitude = 0.5): number {
  const m = Math.min(1, Math.max(0.1, Number(magnitude) || 0.5));
  if (direction === 'bullish') return m;
  if (direction === 'bearish') return -m;
  return 0;
}

function classifyBotNoise(rawRef: any = {}) {
  const mentions = Number(rawRef.mentions || 0);
  const upvotes = Number(rawRef.upvotes || rawRef.totalScore || 0);
  const avgUpvoteRatio = Number(rawRef.avgUpvoteRatio || 0.5);
  const flags = [];
  if (mentions >= 20 && upvotes <= 2) flags.push('many_mentions_low_vote');
  if (avgUpvoteRatio > 0 && avgUpvoteRatio < 0.35) flags.push('low_upvote_ratio');
  if (Number(rawRef.mentionGrowth || 0) > 5 && upvotes <= 5) flags.push('hype_growth_low_engagement');
  return {
    score: flags.length === 0 ? 0 : Math.min(1, 0.35 + flags.length * 0.25),
    flags,
  };
}

function classifyHypeSpike(rawRef: any = {}) {
  const mentionGrowth = Number(rawRef.mentionGrowth || 0);
  const mentions = Number(rawRef.mentions || 0);
  const zScore = Number(rawRef.mentionZScore || (mentionGrowth >= 1 ? 3.2 : mentionGrowth >= 0.5 ? 2.1 : 0));
  return {
    detected: mentionGrowth >= 0.75 || zScore >= 3,
    mentionGrowth,
    mentionCount: mentions,
    zScore: Number(zScore.toFixed(3)),
  };
}

function normalizeEvent(event: any, aggregate: any) {
  const rawRef = event.rawRef || {};
  return {
    ...event,
    rawRef: {
      ...rawRef,
      sourceDiversity: aggregate?.sourceDiversity || { sourceCount: 1, uniqueSources: [event.sourceName].filter(Boolean) },
      freshness: {
        lastSeenAt: new Date().toISOString(),
        ageMinutes: 0,
        decayScore: Number(event.freshnessScore ?? 1),
      },
      botNoise: classifyBotNoise(rawRef),
      hypeSpike: classifyHypeSpike(rawRef),
      shadowMode: SHADOW_MODE,
    },
  };
}

async function fetchWithTimeout(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'luna-community-evidence/1.1 (team-jay research)' },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

function fixtureEvents(limit = 20) {
  return [
    {
      sourceType: 'community',
      sourceName: 'fixture_reddit_cryptocurrency',
      sourceUrl: 'fixture://reddit',
      symbol: 'BTC/USDT',
      market: 'crypto',
      strategyFamily: 'community_sentiment',
      signalDirection: 'bullish',
      score: 0.62,
      sourceQuality: 0.40,
      freshnessScore: 1.0,
      evidenceSummary: 'Fixture Reddit: BTC breakout discussion with balanced engagement',
      rawRef: { fixture: true, mentions: 7, avgUpvoteRatio: 0.72, totalScore: 84, mentionGrowth: 0.42 },
    },
    {
      sourceType: 'community',
      sourceName: 'fixture_apewisdom_crypto',
      sourceUrl: 'fixture://apewisdom',
      symbol: 'SOL/USDT',
      market: 'crypto',
      strategyFamily: 'community_sentiment',
      signalDirection: 'bearish',
      score: -0.48,
      sourceQuality: 0.45,
      freshnessScore: 1.0,
      evidenceSummary: 'Fixture ApeWisdom: SOL mentions spiked with weak vote quality',
      rawRef: { fixture: true, mentions: 22, upvotes: 3, mentions_24h_ago: 9, mentionGrowth: 1.44 },
    },
  ].slice(0, limit);
}

async function fetchApeWisdom(limit = 60, activeSymbols: string[] = []): Promise<any[]> {
  const data = await fetchWithTimeout('https://apewisdom.io/api/v1.0/filter/all-crypto/page/1');
  const results: any[] = data?.results || [];
  const events: any[] = [];
  const tickerSymbolMap = buildTickerSymbolMap(activeSymbols);

  for (const item of results.slice(0, limit)) {
    const ticker = String(item?.ticker || '').toUpperCase();
    const symbol = tickerSymbolMap[ticker];
    if (!symbol) continue;
    const mentions = Number(item?.mentions || 0);
    const prev = Number(item?.mentions_24h_ago || 0);
    const upvotes = Number(item?.upvotes || 0);
    const mentionGrowth = prev > 0 ? (mentions - prev) / prev : 0;
    const direction = mentionGrowth >= 0.25 ? 'bullish' : mentionGrowth <= -0.25 ? 'bearish' : 'neutral';
    const magnitude = Math.min(1, 0.3 + Math.abs(mentionGrowth) * 0.4);
    events.push({
      sourceType: 'community',
      sourceName: 'apewisdom_crypto',
      sourceUrl: 'https://apewisdom.io/',
      symbol,
      market: 'crypto',
      strategyFamily: 'community_sentiment',
      signalDirection: direction,
      score: directionScore(direction, magnitude),
      sourceQuality: 0.45,
      freshnessScore: 1.0,
      evidenceSummary: `ApeWisdom: ${ticker} mentions=${mentions} (${mentionGrowth >= 0 ? '+' : ''}${(mentionGrowth * 100).toFixed(0)}% 24h) upvotes=${upvotes}`,
      rawRef: { mentions, mentions_24h_ago: prev, upvotes, mentionGrowth, rank: item?.rank ?? null, ticker },
    });
  }
  return events;
}

async function fetchRedditSubreddit(subreddit: string, symbol: string, sourceQuality = 0.40): Promise<any[]> {
  const data = await fetchWithTimeout(`https://www.reddit.com/r/${subreddit}/hot.json?limit=25`);
  const posts: any[] = (data?.data?.children || []).map((c: any) => c?.data).filter(Boolean);
  const keywords = SYMBOL_KEYWORDS[symbol] || [symbol.replace('/USDT', '').toLowerCase()];
  const relevant = posts.filter((p) => {
    const title = String(p?.title || '').toLowerCase();
    return keywords.some((kw) => matchesKeyword(title, kw));
  });
  if (relevant.length === 0) return [];
  const avgUpvoteRatio = relevant.reduce((s, p) => s + Number(p?.upvote_ratio || 0.5), 0) / relevant.length;
  const totalScore = relevant.reduce((s, p) => s + Number(p?.score || 0), 0);
  const combinedText = relevant.map((p) => p?.title || '').join(' ');
  const direction = inferDirection(combinedText);
  const magnitude = Math.min(1, 0.25 + avgUpvoteRatio * 0.4 + Math.min(0.35, relevant.length / 10));
  return [{
    sourceType: 'community',
    sourceName: `reddit_${subreddit.toLowerCase()}`,
    sourceUrl: `https://www.reddit.com/r/${subreddit}/`,
    symbol,
    market: 'crypto',
    strategyFamily: 'community_sentiment',
    signalDirection: direction,
    score: directionScore(direction, magnitude),
    sourceQuality,
    freshnessScore: 1.0,
    evidenceSummary: `Reddit r/${subreddit}: ${symbol} mentions=${relevant.length} avg_upvote=${avgUpvoteRatio.toFixed(2)} totalScore=${totalScore}`,
    rawRef: {
      mentions: relevant.length,
      avgUpvoteRatio,
      totalScore,
      subreddit,
      topPosts: relevant.slice(0, 3).map((p) => ({ title: p?.title, score: p?.score, upvote_ratio: p?.upvote_ratio })),
    },
  }];
}

async function fetchAllRedditSources(limit = 20): Promise<any[]> {
  const tasks = [
    fetchRedditSubreddit('CryptoCurrency', 'BTC/USDT', 0.40),
    fetchRedditSubreddit('CryptoCurrency', 'ETH/USDT', 0.40),
    fetchRedditSubreddit('CryptoCurrency', 'SOL/USDT', 0.40),
    fetchRedditSubreddit('Bitcoin', 'BTC/USDT', 0.42),
    fetchRedditSubreddit('ethereum', 'ETH/USDT', 0.42),
    fetchRedditSubreddit('solana', 'SOL/USDT', 0.42),
  ];
  const settled = await Promise.allSettled(tasks);
  return settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])).slice(0, limit);
}

async function fetchRedditCandidateMentions(activeSymbols: string[] = [], limit = 60): Promise<any[]> {
  const symbols = activeSymbols.slice(0, Math.max(1, limit));
  if (symbols.length === 0) return [];
  const subreddits = ['CryptoCurrency', 'CryptoMarkets', 'altcoin'];
  const settled = await Promise.allSettled(
    subreddits.map(async (subreddit) => {
      const data = await fetchWithTimeout(`https://www.reddit.com/r/${subreddit}/hot.json?limit=50`);
      return {
        subreddit,
        posts: (data?.data?.children || []).map((c: any) => c?.data).filter(Boolean),
      };
    }),
  );

  const events: any[] = [];
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    const { subreddit, posts } = result.value;
    for (const symbol of symbols) {
      const keywords = keywordsForSymbol(symbol);
      const relevant = posts.filter((post: any) => {
        const title = String(post?.title || '').toLowerCase();
        return keywords.some((kw) => matchesKeyword(title, kw));
      });
      if (relevant.length === 0) continue;
      const avgUpvoteRatio = relevant.reduce((s: number, p: any) => s + Number(p?.upvote_ratio || 0.5), 0) / relevant.length;
      const totalScore = relevant.reduce((s: number, p: any) => s + Number(p?.score || 0), 0);
      const combinedText = relevant.map((p: any) => p?.title || '').join(' ');
      const direction = inferDirection(combinedText);
      const magnitude = Math.min(1, 0.25 + avgUpvoteRatio * 0.35 + Math.min(0.25, relevant.length / 12));
      events.push({
        sourceType: 'community',
        sourceName: `reddit_candidate_${subreddit.toLowerCase()}`,
        sourceUrl: `https://www.reddit.com/r/${subreddit}/`,
        symbol,
        market: 'crypto',
        strategyFamily: 'community_sentiment',
        signalDirection: direction,
        score: directionScore(direction, magnitude),
        sourceQuality: 0.38,
        freshnessScore: 1.0,
        evidenceSummary: `Reddit candidate scan r/${subreddit}: ${symbol} mentions=${relevant.length} totalScore=${totalScore}`,
        rawRef: {
          candidateDriven: true,
          mentions: relevant.length,
          avgUpvoteRatio,
          totalScore,
          subreddit,
          keywords,
          topPosts: relevant.slice(0, 3).map((p: any) => ({ title: p?.title, score: p?.score, upvote_ratio: p?.upvote_ratio })),
        },
      });
    }
  }
  return events.slice(0, limit);
}

function buildMissingCommunityEvidence(activeSymbols: string[] = [], existingEvents: any[] = [], limit = 60) {
  if (String(process.env.LUNA_COMMUNITY_GAP_EVIDENCE_ENABLED || 'true').toLowerCase() === 'false') return [];
  const seen = new Set(existingEvents.map((event) => normalizeSymbol(event.symbol)).filter(Boolean));
  return activeSymbols
    .filter((symbol) => !seen.has(normalizeSymbol(symbol)))
    .slice(0, limit)
    .map((symbol) => ({
      sourceType: 'community',
      sourceName: 'community_candidate_gap',
      sourceUrl: null,
      symbol,
      market: 'crypto',
      strategyFamily: 'community_sentiment',
      signalDirection: 'neutral',
      score: 0,
      sourceQuality: 0.10,
      freshnessScore: 1.0,
      evidenceSummary: `Community evidence gap recorded for active candidate ${symbol}`,
      rawRef: {
        missing_data: true,
        candidateDriven: true,
        reason: 'no_reddit_apewisdom_news_match',
        mentions: 0,
        sourceDiversity: { sourceCount: 0, uniqueSources: [] },
      },
    }));
}

function missingSecretEvent(sourceName: string, missing: string[]) {
  return {
    sourceType: 'community',
    sourceName,
    sourceUrl: null,
    symbol: null,
    market: 'crypto',
    strategyFamily: 'community_sentiment',
    signalDirection: 'neutral',
    score: 0,
    sourceQuality: 0,
    freshnessScore: 1,
    evidenceSummary: `${sourceName}: skipped because required secret is missing`,
    rawRef: { missing_secret: true, missing, provider: sourceName },
  };
}

async function fetchCryptoPanic(apiKey: string | null, limit = 30): Promise<any[]> {
  if (!apiKey) return [missingSecretEvent('cryptopanic_news', ['CRYPTOPANIC_API_KEY'])];
  const url = `https://cryptopanic.com/api/v1/posts/?auth_token=${apiKey}&kind=news&filter=hot`;
  const data = await fetchWithTimeout(url);
  const posts: any[] = data?.results || [];
  const symbolMap: Record<string, string> = { BTC: 'BTC/USDT', ETH: 'ETH/USDT', SOL: 'SOL/USDT', BNB: 'BNB/USDT', XRP: 'XRP/USDT' };
  const events: any[] = [];
  for (const post of posts.slice(0, limit)) {
    const currencies: string[] = (post?.currencies || []).map((c: any) => String(c?.code || '').toUpperCase());
    for (const code of currencies) {
      const symbol = symbolMap[code];
      if (!symbol) continue;
      const positive = Number(post?.votes?.positive || 0);
      const negative = Number(post?.votes?.negative || 0);
      const total = positive + negative;
      const direction = inferDirection(post?.title || '');
      const magnitude = total > 0 ? Math.min(1, 0.3 + (positive / total) * 0.7) : 0.3;
      events.push({
        sourceType: 'community',
        sourceName: 'cryptopanic_news',
        sourceUrl: post?.url || 'https://cryptopanic.com',
        symbol,
        market: 'crypto',
        strategyFamily: 'community_sentiment',
        signalDirection: direction,
        score: directionScore(direction, magnitude),
        sourceQuality: 0.50,
        freshnessScore: 1.0,
        evidenceSummary: `CryptoPanic: ${symbol} - ${String(post?.title || '').slice(0, 120)}`,
        rawRef: { votes: post?.votes || {}, title: post?.title || '', currencies },
      });
    }
  }
  return events;
}

async function fetchNaverNews({ clientId, clientSecret, limit = 20 } = {}): Promise<any[]> {
  if (!clientId || !clientSecret) return [missingSecretEvent('naver_news', ['NAVER_CLIENT_ID', 'NAVER_CLIENT_SECRET'])];
  const query = encodeURIComponent('비트코인 OR 이더리움 OR 솔라나');
  const resp = await fetch(`https://openapi.naver.com/v1/search/news.json?query=${query}&display=${Math.min(100, limit)}&sort=date`, {
    headers: {
      'X-Naver-Client-Id': clientId,
      'X-Naver-Client-Secret': clientSecret,
      'User-Agent': 'luna-community-evidence/1.1',
    },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`Naver HTTP ${resp.status}`);
  const data = await resp.json();
  const items: any[] = data?.items || [];
  return items.slice(0, limit).flatMap((item) => {
    const text = `${item?.title || ''} ${item?.description || ''}`.replace(/<[^>]+>/g, ' ');
    const symbol = text.includes('솔라나') ? 'SOL/USDT' : text.includes('이더리움') ? 'ETH/USDT' : 'BTC/USDT';
    const direction = inferDirection(text);
    return [{
      sourceType: 'community',
      sourceName: 'naver_news',
      sourceUrl: item?.originallink || item?.link || 'https://search.naver.com',
      symbol,
      market: 'crypto',
      strategyFamily: 'community_sentiment',
      signalDirection: direction,
      score: directionScore(direction, 0.35),
      sourceQuality: 0.46,
      freshnessScore: 1.0,
      evidenceSummary: `Naver news: ${text.slice(0, 140)}`,
      rawRef: { title: item?.title, pubDate: item?.pubDate, mentions: 1 },
    }];
  });
}

async function collectSource(name: string, fn: () => Promise<any[]>) {
  try {
    const events = await fn();
    return { source: name, ok: true, count: events.length, events, error: null };
  } catch (error) {
    return {
      source: name,
      ok: false,
      count: 0,
      events: [{
        sourceType: 'community',
        sourceName: name,
        sourceUrl: null,
        symbol: null,
        market: 'crypto',
        strategyFamily: 'community_sentiment',
        signalDirection: 'neutral',
        score: 0,
        sourceQuality: 0,
        freshnessScore: 1,
        evidenceSummary: `${name}: source_error ${error?.message || error}`,
        rawRef: { source_error: true, error: String(error?.message || error), provider: name },
      }],
      error: String(error?.message || error),
    };
  }
}

function attachAggregates(events: any[]) {
  const bySymbol = new Map<string, any[]>();
  for (const event of events) {
    const key = event.symbol || '__market__';
    bySymbol.set(key, [...(bySymbol.get(key) || []), event]);
  }
  return events.map((event) => {
    const scoped = bySymbol.get(event.symbol || '__market__') || [event];
    const uniqueSources = [...new Set(scoped.map((item) => item.sourceName).filter(Boolean))];
    return normalizeEvent(event, {
      sourceDiversity: {
        sourceCount: uniqueSources.length,
        uniqueSources,
      },
    });
  });
}

async function insertAllEvents(events: any[], dryRun = false): Promise<number> {
  if (dryRun) return 0;
  let count = 0;
  for (const ev of events) {
    const id = await db.insertExternalEvidence(ev).catch(() => null);
    if (id) count++;
  }
  return count;
}

export async function runCommunityEvidenceRefresh(options: any = {}): Promise<any> {
  const json = options.json === true;
  const dryRun = options.dryRun === true;
  const fixture = options.fixture === true;
  const limit = Math.max(1, Number(options.limit || 60));
  if (!dryRun) await db.initSchema();
  const activeSymbols = fixture ? [] : await getActiveCryptoCandidateSymbols(limit);

  const sourceResults = fixture
    ? [{ source: 'fixture', ok: true, count: fixtureEvents(limit).length, events: fixtureEvents(limit), error: null }]
    : await Promise.all([
      collectSource('apewisdom_crypto', () => fetchApeWisdom(limit, activeSymbols)),
      collectSource('reddit', () => fetchAllRedditSources(limit)),
      collectSource('reddit_candidate_scan', () => fetchRedditCandidateMentions(activeSymbols, limit)),
      collectSource('cryptopanic_news', () => fetchCryptoPanic(process.env.CRYPTOPANIC_API_KEY || null, limit)),
      collectSource('naver_news', () => fetchNaverNews({
        clientId: process.env.NAVER_CLIENT_ID || process.env.NAVER_NEWS_CLIENT_ID,
        clientSecret: process.env.NAVER_CLIENT_SECRET || process.env.NAVER_NEWS_CLIENT_SECRET,
        limit,
      })),
    ]);

  const collectedEvents = sourceResults.flatMap((result) => result.events || []);
  const gapEvents = buildMissingCommunityEvidence(activeSymbols, collectedEvents, limit);
  const allEvents = attachAggregates([
    ...collectedEvents.slice(0, limit),
    ...gapEvents.slice(0, Math.max(0, limit - Math.min(limit, collectedEvents.length))),
  ]);
  const mentionsBySymbol: Record<string, number> = {};
  for (const ev of allEvents) {
    if (ev.symbol) mentionsBySymbol[ev.symbol] = (mentionsBySymbol[ev.symbol] || 0) + (ev.rawRef?.mentions ?? 1);
  }

  const inserted = await insertAllEvents(allEvents, dryRun);
  const payload = {
    ok: true,
    shadowMode: SHADOW_MODE,
    dryRun,
    fixture,
    collected: allEvents.length,
    inserted,
    bySource: Object.fromEntries(sourceResults.map((result) => [result.source, result.count])),
    activeCandidateSymbols: activeSymbols,
    gapEvidence: gapEvents.length,
    sourceReports: sourceResults.map(({ events, ...rest }) => rest),
    symbols: Object.keys(mentionsBySymbol),
    mentionsBySymbol,
    sample: allEvents.slice(0, 3),
  };

  if (!json) console.log(`[luna-community] 완료: collected=${allEvents.length} inserted=${inserted} dryRun=${dryRun} shadow=${SHADOW_MODE}`);
  return json ? payload : JSON.stringify(payload, null, 2);
}

export const __test = {
  keywordsForSymbol,
  matchesKeyword,
};

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => runCommunityEvidenceRefresh({
      json: hasFlag('json'),
      dryRun: hasFlag('dry-run'),
      fixture: hasFlag('fixture'),
      limit: Number(argValue('limit', 60)),
    }),
    onSuccess: async (result) => {
      if (typeof result === 'string') console.log(result);
      else console.log(JSON.stringify(result, null, 2));
    },
    errorPrefix: 'runtime-luna-community-evidence-refresh error:',
  });
}
