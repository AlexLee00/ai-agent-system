#!/usr/bin/env node
// @ts-nocheck

import { createRequire } from 'node:module';
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { collectTossMarketIntel } from '../team/toss-market-intel.ts';
import {
  adjustCommunitySourceQuality,
  fetchLunaCommunitySourceQualityAudit,
} from '../shared/luna-community-source-quality.ts';

const require = createRequire(import.meta.url);
const {
  resolveNaverCredentials,
} = require('../../../packages/core/lib/news-credentials.legacy.js');

const SHADOW_MODE = process.env.LUNA_COMMUNITY_EVIDENCE_SHADOW_MODE !== 'false';
const DEFAULT_TIMEOUT_MS = Number(process.env.LUNA_COMMUNITY_EVIDENCE_TIMEOUT_MS || 8000);

const TICKER_SYMBOL_MAP: Record<string, string> = {
  BTC: 'BTC/USDT', ETH: 'ETH/USDT', SOL: 'SOL/USDT', BNB: 'BNB/USDT',
  XRP: 'XRP/USDT', ADA: 'ADA/USDT', DOGE: 'DOGE/USDT', AVAX: 'AVAX/USDT',
  DOT: 'DOT/USDT', MATIC: 'MATIC/USDT', LINK: 'LINK/USDT', ATOM: 'ATOM/USDT',
  NEAR: 'NEAR/USDT', ARB: 'ARB/USDT', OP: 'OP/USDT', SUI: 'SUI/USDT',
};

const SYMBOL_KEYWORDS: Record<string, string[]> = {
  'AI/USDT': ['sleepless ai', '$ai', '#ai', 'ai/usdt', 'ai-usdt', 'aiusdt'],
  'AIGENSYN/USDT': ['aigensyn', 'aigen', '$aigensyn', '#aigensyn', 'aigensyn/usdt', 'aigensynusdt'],
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

const CRYPTO_NEWS_RSS_FEEDS = [
  { key: 'coindesk', publisher: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', sourceQuality: 0.45 },
  { key: 'cointelegraph', publisher: 'Cointelegraph', url: 'https://cointelegraph.com/rss', sourceQuality: 0.43 },
  { key: 'decrypt', publisher: 'Decrypt', url: 'https://decrypt.co/feed', sourceQuality: 0.42 },
  { key: 'theblock', publisher: 'The Block', url: 'https://www.theblock.co/rss.xml', sourceQuality: 0.44 },
  { key: 'cryptoslate', publisher: 'CryptoSlate', url: 'https://cryptoslate.com/feed/', sourceQuality: 0.39 },
  { key: 'bitcoinmagazine', publisher: 'Bitcoin Magazine', url: 'https://bitcoinmagazine.com/feed', sourceQuality: 0.38 },
  { key: 'newsbtc', publisher: 'NewsBTC', url: 'https://www.newsbtc.com/feed/', sourceQuality: 0.34 },
  { key: 'bitcoinist', publisher: 'Bitcoinist', url: 'https://bitcoinist.com/feed/', sourceQuality: 0.33 },
  { key: 'utoday', publisher: 'U.Today', url: 'https://u.today/rss', sourceQuality: 0.35 },
  { key: 'beincrypto', publisher: 'BeInCrypto', url: 'https://beincrypto.com/feed/', sourceQuality: 0.36 },
];

const DOMESTIC_MARKET_NEWS_RSS_FEEDS = [
  { key: 'yonhap_economy', publisher: 'Yonhap Economy', url: 'https://www.yna.co.kr/rss/economy.xml', sourceQuality: 0.43 },
  { key: 'hankyung_finance', publisher: 'Hankyung Finance', url: 'https://www.hankyung.com/feed/finance', sourceQuality: 0.41 },
  { key: 'mk_stock', publisher: 'Maeil Economy Stock', url: 'https://www.mk.co.kr/rss/30100041/', sourceQuality: 0.40 },
];

const OVERSEAS_MARKET_NEWS_RSS_FEEDS = [
  { key: 'cnbc_investing', publisher: 'CNBC Investing', url: 'https://www.cnbc.com/id/15839069/device/rss/rss.html', sourceQuality: 0.43 },
  { key: 'marketwatch_topstories', publisher: 'MarketWatch Top Stories', url: 'https://feeds.marketwatch.com/marketwatch/topstories/', sourceQuality: 0.42 },
  { key: 'yahoo_finance_news', publisher: 'Yahoo Finance News', url: 'https://finance.yahoo.com/news/rssindex', sourceQuality: 0.41 },
  { key: 'nasdaq_markets', publisher: 'Nasdaq Markets', url: 'https://www.nasdaq.com/feed/rssoutbound?category=Markets', sourceQuality: 0.40 },
  { key: 'prnewswire_finance', publisher: 'PRNewswire Finance', url: 'https://www.prnewswire.com/rss/financial-services-latest-news/financial-services-latest-news-list.rss', sourceQuality: 0.36 },
  { key: 'seekingalpha_market_currents', publisher: 'Seeking Alpha Market Currents', url: 'https://seekingalpha.com/market_currents.xml', sourceQuality: 0.38 },
];

type CandidateMarket = 'crypto' | 'domestic' | 'overseas';
type ActiveCandidate = {
  symbol: string;
  market: CandidateMarket;
  score?: number;
  source?: string;
  discoveredAt?: string | null;
  rawData?: any;
};

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
  const rows = await getActiveCandidateRows('crypto', limit);
  return rows.map((row: ActiveCandidate) => normalizeSymbol(row.symbol)).filter((symbol: string) => symbol.endsWith('/USDT'));
}

async function getActiveCandidateRows(market: CandidateMarket, limit = 60): Promise<ActiveCandidate[]> {
  const rows = await db.query(
    `WITH active_candidates AS (
      SELECT DISTINCT ON (symbol, market)
             symbol, market, score, source, discovered_at, raw_data
        FROM candidate_universe
       WHERE expires_at > NOW()
         AND market = $1
       ORDER BY symbol, market, score DESC, discovered_at DESC
    )
    SELECT symbol, market, score, source, discovered_at, raw_data
      FROM active_candidates
     ORDER BY score DESC, discovered_at DESC
     LIMIT $2`,
    [market, limit],
  ).catch(() => []);
  return rows
    .map((row: any) => ({
      symbol: normalizeSymbol(row.symbol),
      market: row.market,
      score: Number(row.score || 0),
      source: row.source || null,
      discoveredAt: row.discovered_at || null,
      rawData: row.raw_data || {},
    }))
    .filter((row: ActiveCandidate) => row.symbol && row.market === market);
}

function buildTickerSymbolMap(activeSymbols: string[] = [], options: { includeAmbiguous?: boolean } = {}) {
  const includeAmbiguous = options.includeAmbiguous !== false;
  const map = { ...TICKER_SYMBOL_MAP };
  for (const symbol of activeSymbols) {
    const ticker = tickerFromSymbol(symbol);
    if (ticker && !map[ticker] && (includeAmbiguous || !isAmbiguousTicker(ticker))) map[ticker] = symbol;
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
const KOREAN_BULLISH_KW = [
  '상승', '매수', '급등', '강세', '호재', '실적', '목표가', '상향', '돌파',
  '수급', '외인', '기관', '반등', '신고가', '흑자', '성장',
];
const KOREAN_BEARISH_KW = [
  '하락', '매도', '급락', '약세', '악재', '손실', '하한가', '전환사채', '폭락',
  '이탈', '물림', '적자', '유증', '감자', '리스크', '경고',
];
const EQUITY_SYMBOL_ALIASES: Record<string, string[]> = {
  NVDA: ['nvda', '$nvda', 'nvidia'],
  AAPL: ['aapl', '$aapl', 'apple'],
  MSFT: ['msft', '$msft', 'microsoft'],
  GOOGL: ['googl', '$googl', 'google', 'alphabet'],
  GOOG: ['goog', '$goog', 'google', 'alphabet'],
  META: ['meta', '$meta'],
  TSLA: ['tsla', '$tsla', 'tesla'],
  AMD: ['amd', '$amd'],
  AVGO: ['avgo', '$avgo', 'broadcom'],
  AMZN: ['amzn', '$amzn', 'amazon'],
  NFLX: ['nflx', '$nflx', 'netflix'],
  CSCO: ['csco', '$csco', 'cisco'],
  F: ['$f', 'ford'],
  POET: ['poet', '$poet'],
  SNAL: ['snal', '$snal'],
  ONDS: ['onds', '$onds'],
  QUBT: ['qubt', '$qubt'],
  QUCY: ['qucy', '$qucy'],
};

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

function keywordDirection(text: string, bullish: string[], bearish: string[]) {
  const lower = String(text || '').toLowerCase();
  const bullScore = bullish.filter((kw) => lower.includes(String(kw).toLowerCase())).length;
  const bearScore = bearish.filter((kw) => lower.includes(String(kw).toLowerCase())).length;
  const direction = bullScore > bearScore ? 'bullish' : bearScore > bullScore ? 'bearish' : 'neutral';
  return { direction, bullScore, bearScore };
}

function directionScore(direction: string, magnitude = 0.5): number {
  const m = Math.min(1, Math.max(0.1, Number(magnitude) || 0.5));
  if (direction === 'bullish') return m;
  if (direction === 'bearish') return -m;
  return 0;
}

function keywordsForEquitySymbol(symbol = '') {
  const normalized = normalizeSymbol(symbol).replace(/[^A-Z0-9.]/g, '');
  const configured = EQUITY_SYMBOL_ALIASES[normalized] || [];
  const ticker = normalized.toLowerCase();
  const strict = [`$${ticker}`];
  const dynamic = normalized.length <= 2
    ? strict
    : [ticker, `$${ticker}`];
  return uniq([...configured, ...dynamic].map((item) => String(item).toLowerCase()));
}

function matchesEquityKeyword(text = '', keyword = '') {
  const lower = String(text || '').toLowerCase();
  const kw = String(keyword || '').trim().toLowerCase();
  if (kw.length < 2) return false;
  if (kw.startsWith('$')) return lower.includes(kw);
  if (kw.includes(' ')) return lower.includes(kw);
  return new RegExp(`(^|[^a-z0-9$])${escapeRegExp(kw)}([^a-z0-9]|$)`).test(lower);
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

async function fetchTextWithTimeout(url: string, timeoutMs = DEFAULT_TIMEOUT_MS, headers: Record<string, string> = {}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 luna-community-evidence/1.1 (team-jay research)',
        ...headers,
      },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const contentType = resp.headers.get('content-type') || '';
    const buffer = await resp.arrayBuffer();
    const charset = /charset=([^;\s]+)/i.exec(contentType)?.[1]?.toLowerCase();
    if (charset && charset !== 'utf-8' && charset !== 'utf8') {
      return new TextDecoder(charset).decode(buffer);
    }
    return new TextDecoder('utf-8').decode(buffer);
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

async function fetchRedditGlobalCryptoSearch(activeSymbols: string[] = [], limit = 60): Promise<any[]> {
  const symbols = activeSymbols.slice(0, Math.min(45, Math.max(1, limit)));
  if (symbols.length === 0) return [];

  const settled = await Promise.allSettled(symbols.map(async (symbol) => {
    const ticker = tickerFromSymbol(symbol);
    const query = isAmbiguousTicker(ticker)
      ? `${ticker} USDT crypto`
      : `${ticker} crypto OR ${ticker} USDT`;
    const data = await fetchWithTimeout(`https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=new&limit=15`);
    const posts: any[] = (data?.data?.children || []).map((c: any) => c?.data).filter(Boolean);
    const keywords = keywordsForSymbol(symbol);
    const relevant = posts.filter((post: any) => {
      const text = `${post?.title || ''} ${post?.selftext || ''}`.slice(0, 2500);
      return keywords.some((kw) => matchesKeyword(text, kw));
    });
    if (relevant.length === 0) return null;
    const avgUpvoteRatio = relevant.reduce((sum: number, post: any) => sum + Number(post?.upvote_ratio || 0.5), 0) / relevant.length;
    const totalScore = relevant.reduce((sum: number, post: any) => sum + Number(post?.score || 0), 0);
    const combinedText = relevant.map((post: any) => `${post?.title || ''} ${post?.selftext || ''}`).join(' ');
    const direction = inferDirection(combinedText);
    const magnitude = Math.min(1, 0.20 + avgUpvoteRatio * 0.30 + Math.min(0.24, relevant.length / 12) + Math.min(0.16, totalScore / 1000));
    return {
      sourceType: 'community',
      sourceName: 'reddit_crypto_global_search',
      sourceUrl: `https://www.reddit.com/search/?q=${encodeURIComponent(query)}&sort=new`,
      symbol,
      market: 'crypto',
      strategyFamily: 'community_sentiment',
      signalDirection: direction,
      score: directionScore(direction, magnitude),
      sourceQuality: 0.34,
      freshnessScore: 1.0,
      evidenceSummary: `Reddit global crypto search: ${symbol} mentions=${relevant.length} totalScore=${totalScore}`,
      rawRef: {
        candidateDriven: true,
        mentions: relevant.length,
        avgUpvoteRatio,
        totalScore,
        query,
        keywords,
        topPosts: relevant.slice(0, 3).map((post: any) => ({
          subreddit: post?.subreddit,
          title: post?.title,
          score: post?.score,
          upvote_ratio: post?.upvote_ratio,
        })),
      },
    };
  }));

  return settled
    .filter((result) => result.status === 'fulfilled' && result.value)
    .map((result: any) => result.value)
    .slice(0, limit);
}

async function fetchGoogleNewsCryptoRss(activeSymbols: string[] = [], limit = 60): Promise<any[]> {
  const symbols = activeSymbols.slice(0, Math.min(35, Math.max(1, limit)));
  if (symbols.length === 0) return [];

  const settled = await Promise.allSettled(symbols.map(async (symbol) => {
    const ticker = tickerFromSymbol(symbol);
    const query = `${ticker} crypto OR ${ticker} cryptocurrency OR ${ticker} USDT`;
    const { url, items } = await fetchGoogleNewsRss(query, { hl: 'en-US', gl: 'US', ceid: 'US:en' }, 8);
    const keywords = keywordsForSymbol(symbol);
    const relevant = items.filter((item) => {
      const text = `${item.title || ''} ${item.description || ''}`;
      return keywords.some((kw) => matchesKeyword(text, kw));
    });
    if (relevant.length === 0) return null;
    const combinedText = relevant.map((item) => `${item.title || ''} ${item.description || ''}`).join(' ');
    const direction = inferDirection(combinedText);
    const magnitude = Math.min(1, 0.24 + Math.min(0.30, relevant.length * 0.07));
    return {
      sourceType: 'community',
      sourceName: 'google_news_crypto_rss',
      sourceUrl: relevant[0]?.link || url,
      symbol,
      market: 'crypto',
      strategyFamily: 'news_sentiment',
      signalDirection: direction,
      score: directionScore(direction, magnitude),
      sourceQuality: 0.37,
      freshnessScore: 1.0,
      evidenceSummary: `Google News crypto RSS: ${symbol} matched=${relevant.length} direction=${direction}`,
      rawRef: {
        candidateDriven: true,
        mentions: relevant.length,
        query,
        keywords,
        items: relevant.slice(0, 4),
      },
    };
  }));

  return settled
    .filter((result) => result.status === 'fulfilled' && result.value)
    .map((result: any) => result.value)
    .slice(0, limit);
}

function rssFreshnessScore(pubDate = '') {
  const publishedAtMs = Date.parse(String(pubDate || ''));
  if (!Number.isFinite(publishedAtMs)) return 0.75;
  const ageHours = Math.max(0, (Date.now() - publishedAtMs) / 3_600_000);
  if (ageHours <= 6) return 1;
  if (ageHours <= 24) return 0.9;
  if (ageHours <= 72) return 0.7;
  return 0.45;
}

function buildDomesticMarketwideArticleEvents(feed: any, items: any[] = [], maxItems = 4) {
  return items
    .slice(0, Math.max(0, maxItems))
    .map((item, index) => {
      const text = `${item.title || ''} ${item.description || ''}`;
      const { direction, bullScore, bearScore } = keywordDirection(text, KOREAN_BULLISH_KW, KOREAN_BEARISH_KW);
      const freshnessScore = rssFreshnessScore(item.pubDate);
      const magnitude = Math.min(0.52, 0.18 + Math.min(0.16, Math.abs(bullScore - bearScore) * 0.05) + Math.min(0.12, freshnessScore * 0.12));
      return {
        sourceType: 'community',
        sourceName: `domestic_market_news_rss_${feed.key}`,
        sourceUrl: item.link || feed.url,
        symbol: null,
        market: 'domestic',
        strategyFamily: 'market_news_sentiment',
        signalDirection: direction,
        score: directionScore(direction, magnitude),
        sourceQuality: feed.sourceQuality,
        freshnessScore,
        evidenceSummary: `${feed.publisher} RSS domestic article #${index + 1}: ${String(item.title || '').slice(0, 120)}`,
        rawRef: {
          marketWide: true,
          articleEvent: true,
          mentions: 1,
          publisher: feed.publisher,
          feedUrl: feed.url,
          articleIndex: index + 1,
          bullishHits: bullScore,
          bearishHits: bearScore,
          article: {
            title: item.title,
            link: item.link,
            pubDate: item.pubDate || null,
            source: item.source || feed.publisher,
          },
        },
      };
    });
}

function buildOverseasMarketwideArticleEvents(feed: any, items: any[] = [], maxItems = 3) {
  return items
    .slice(0, Math.max(0, maxItems))
    .map((item, index) => {
      const text = `${item.title || ''} ${item.description || ''}`;
      const direction = inferDirection(text);
      const freshnessScore = rssFreshnessScore(item.pubDate);
      const magnitude = Math.min(0.54, 0.20 + Math.min(0.14, freshnessScore * 0.14));
      return {
        sourceType: 'community',
        sourceName: `overseas_market_news_rss_${feed.key}`,
        sourceUrl: item.link || feed.url,
        symbol: null,
        market: 'overseas',
        strategyFamily: 'market_news_sentiment',
        signalDirection: direction,
        score: directionScore(direction, magnitude),
        sourceQuality: feed.sourceQuality,
        freshnessScore,
        evidenceSummary: `${feed.publisher} RSS overseas article #${index + 1}: ${String(item.title || '').slice(0, 120)}`,
        rawRef: {
          marketWide: true,
          articleEvent: true,
          mentions: 1,
          publisher: feed.publisher,
          feedUrl: feed.url,
          articleIndex: index + 1,
          article: {
            title: item.title,
            link: item.link,
            pubDate: item.pubDate || null,
            source: item.source || feed.publisher,
          },
        },
      };
    });
}

async function fetchCryptoNewsRssBundle(activeSymbols: string[] = [], limit = 60): Promise<any[]> {
  const symbols = activeSymbols.slice(0, Math.min(50, Math.max(1, limit)));
  if (symbols.length === 0) return [];

  const settled = await Promise.allSettled(CRYPTO_NEWS_RSS_FEEDS.map(async (feed) => {
    const xml = await fetchTextWithTimeout(feed.url, DEFAULT_TIMEOUT_MS, {
      Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.7',
      'Accept-Language': 'en-US,en;q=0.9',
    });
    const items = parseRssItems(xml, 40);
    const feedEvents: any[] = [];

    for (const symbol of symbols) {
      const keywords = keywordsForSymbol(symbol);
      const relevant = items.filter((item) => {
        const text = `${item.title || ''} ${item.description || ''}`;
        return keywords.some((kw) => matchesKeyword(text, kw));
      });
      if (relevant.length === 0) continue;

      const combinedText = relevant.map((item) => `${item.title || ''} ${item.description || ''}`).join(' ');
      const direction = inferDirection(combinedText);
      const freshnessScore = Math.max(...relevant.map((item) => rssFreshnessScore(item.pubDate)));
      const magnitude = Math.min(1, 0.26 + Math.min(0.28, relevant.length * 0.07) + Math.min(0.18, freshnessScore * 0.18));
      feedEvents.push({
        sourceType: 'community',
        sourceName: `crypto_news_rss_${feed.key}`,
        sourceUrl: relevant[0]?.link || feed.url,
        symbol,
        market: 'crypto',
        strategyFamily: 'news_sentiment',
        signalDirection: direction,
        score: directionScore(direction, magnitude),
        sourceQuality: feed.sourceQuality,
        freshnessScore,
        evidenceSummary: `${feed.publisher} RSS: ${symbol} matched=${relevant.length} direction=${direction}`,
        rawRef: {
          candidateDriven: true,
          mentions: relevant.length,
          publisher: feed.publisher,
          feedUrl: feed.url,
          matchedKeywords: keywords,
          articles: relevant.slice(0, 5).map((item) => ({
            title: item.title,
            link: item.link,
            pubDate: item.pubDate || null,
            source: item.source || feed.publisher,
          })),
        },
      });
    }

    return feedEvents;
  }));

  return settled
    .flatMap((result, index) => {
      if (result.status === 'fulfilled') return result.value;
      const feed = CRYPTO_NEWS_RSS_FEEDS[index];
      return [{
        sourceType: 'community',
        sourceName: `crypto_news_rss_${feed?.key || 'unknown'}`,
        sourceUrl: feed?.url || null,
        symbol: null,
        market: 'crypto',
        strategyFamily: 'news_sentiment',
        signalDirection: 'neutral',
        score: 0,
        sourceQuality: 0,
        freshnessScore: 1,
        evidenceSummary: `${feed?.publisher || 'Crypto RSS'}: source_error ${result.reason?.message || result.reason}`,
        rawRef: { source_error: true, provider: feed?.publisher || null, feedUrl: feed?.url || null, error: String(result.reason?.message || result.reason) },
      }];
    })
    .slice(0, limit);
}

async function fetchCoinGeckoTrendingCommunity(activeSymbols: string[] = [], limit = 60): Promise<any[]> {
  const tickerSymbolMap = buildTickerSymbolMap(activeSymbols, { includeAmbiguous: false });
  const data = await fetchWithTimeout('https://api.coingecko.com/api/v3/search/trending');
  const coins: any[] = data?.coins || [];
  const events: any[] = [];

  for (const item of coins.slice(0, Math.max(1, limit))) {
    const coin = item?.item || {};
    const ticker = normalizeSymbol(coin?.symbol || '');
    const symbol = tickerSymbolMap[ticker];
    if (!symbol) continue;
    const rank = Number(coin?.market_cap_rank || item?.score || events.length + 1);
    const rankBoost = Math.max(0, 0.28 - events.length * 0.025);
    events.push({
      sourceType: 'community',
      sourceName: 'coingecko_trending_community',
      sourceUrl: 'https://www.coingecko.com/en/discover',
      symbol,
      market: 'crypto',
      strategyFamily: 'community_sentiment',
      signalDirection: 'neutral',
      score: Number(rankBoost.toFixed(4)),
      sourceQuality: 0.34,
      freshnessScore: 1.0,
      evidenceSummary: `CoinGecko trending/search interest: ${coin?.name || ticker} (${ticker}) rank=${rank || 'n/a'}`,
      rawRef: {
        ticker,
        coinGeckoId: coin?.id || null,
        name: coin?.name || null,
        rank,
        marketCapRank: coin?.market_cap_rank ?? null,
        searchTrend: true,
        candidateDriven: true,
        mentions: 1,
      },
    });
  }
  return events;
}

async function fetchCoinGeckoSearchInterest(activeSymbols: string[] = [], limit = 60): Promise<any[]> {
  const symbols = activeSymbols
    .map((symbol) => ({ symbol, ticker: tickerFromSymbol(symbol) }))
    .filter((item) => item.symbol && item.ticker && !isAmbiguousTicker(item.ticker))
    .slice(0, Math.min(50, Math.max(1, limit)));
  if (symbols.length === 0) return [];

  const settled = await Promise.allSettled(symbols.map(async ({ symbol, ticker }) => {
    const data = await fetchWithTimeout(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(ticker)}`);
    const coins: any[] = data?.coins || [];
    const exact = coins.find((coin) => normalizeSymbol(coin?.symbol) === ticker)
      || coins.find((coin) => String(coin?.name || '').toUpperCase().includes(ticker));
    if (!exact) return null;
    const rank = Number(exact.market_cap_rank || 9999);
    const rankScore = Number(Math.max(0.03, 0.26 - Math.min(rank, 2500) / 12500).toFixed(4));
    return {
      sourceType: 'community',
      sourceName: 'coingecko_search_interest',
      sourceUrl: `https://www.coingecko.com/en/search?query=${encodeURIComponent(ticker)}`,
      symbol,
      market: 'crypto',
      strategyFamily: 'community_sentiment',
      signalDirection: 'neutral',
      score: rankScore,
      sourceQuality: 0.31,
      freshnessScore: 1.0,
      evidenceSummary: `CoinGecko search match: ${symbol} ${exact.name || ticker} rank=${rank || 'n/a'}`,
      rawRef: {
        candidateDriven: true,
        searchInterest: true,
        mentions: 1,
        ticker,
        coinGeckoId: exact.id || null,
        name: exact.name || null,
        marketCapRank: exact.market_cap_rank ?? null,
      },
    };
  }));

  return settled
    .filter((result) => result.status === 'fulfilled' && result.value)
    .map((result: any) => result.value)
    .slice(0, limit);
}

async function fetchAlternativeFearGreed(): Promise<any[]> {
  const data = await fetchWithTimeout('https://api.alternative.me/fng/?limit=1&format=json');
  const latest = data?.data?.[0];
  if (!latest) return [];
  const value = Number(latest.value);
  const classification = String(latest.value_classification || '').toLowerCase();
  const normalized = Number.isFinite(value) ? (value - 50) / 50 : 0;
  const direction = value >= 60 ? 'bullish' : value <= 40 ? 'bearish' : 'neutral';
  return [{
    sourceType: 'community',
    sourceName: 'alternative_fear_greed_index',
    sourceUrl: 'https://alternative.me/crypto/fear-and-greed-index/',
    symbol: null,
    market: 'crypto',
    strategyFamily: 'market_sentiment',
    signalDirection: direction,
    score: Number(Math.max(-1, Math.min(1, normalized)).toFixed(4)),
    sourceQuality: 0.44,
    freshnessScore: 1.0,
    evidenceSummary: `Alternative.me Fear & Greed: ${value} (${latest.value_classification || 'unknown'})`,
    rawRef: {
      marketWide: true,
      value,
      classification,
      timestamp: latest.timestamp || null,
      timeUntilUpdate: latest.time_until_update || null,
      attributionRequired: true,
      mentions: 1,
    },
  }];
}

function decodeHtmlText(value = '') {
  return String(value || '')
    .replace(/<!\[CDATA\[(.*?)\]\]>/gis, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&#034;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTagText(xml = '', tag = '') {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(String(xml || ''));
  if (!match) return '';
  const decoded = decodeHtmlText(String(match[1] || ''));
  return decodeHtmlText(decoded.replace(/<[^>]+>/g, ' '));
}

function parseRssItems(xml = '', limit = 8) {
  return [...String(xml || '').matchAll(/<item\b[\s\S]*?<\/item>/gi)]
    .slice(0, Math.max(1, limit))
    .map((match) => {
      const itemXml = match[0] || '';
      return {
        title: extractTagText(itemXml, 'title'),
        link: extractTagText(itemXml, 'link'),
        pubDate: extractTagText(itemXml, 'pubDate'),
        source: extractTagText(itemXml, 'source'),
        description: extractTagText(itemXml, 'description'),
      };
    })
    .filter((item) => item.title || item.description);
}

async function fetchGoogleNewsRss(query: string, locale: { hl: string; gl: string; ceid: string }, limit = 8) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${locale.hl}&gl=${locale.gl}&ceid=${locale.ceid}`;
  const xml = await fetchTextWithTimeout(url, DEFAULT_TIMEOUT_MS, {
    'Accept-Language': locale.hl.includes('ko') ? 'ko-KR,ko;q=0.9,en;q=0.7' : 'en-US,en;q=0.9',
  });
  return { url, items: parseRssItems(xml, limit) };
}

async function fetchNaverFinanceName(symbol = '') {
  if (!/^\d{6}$/.test(symbol)) return null;
  const html = await fetchTextWithTimeout(`https://finance.naver.com/item/main.naver?code=${encodeURIComponent(symbol)}`, DEFAULT_TIMEOUT_MS, {
    'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
  });
  const h2 = /<div class=["']wrap_company["'][\s\S]*?<h2><a[^>]*>(.*?)<\/a>/i.exec(html)?.[1];
  const title = /<title>(.*?)<\/title>/i.exec(html)?.[1];
  const name = decodeHtmlText(String(h2 || title || '').replace(/\s*:.*$/, ''));
  return name && !/Npay|증권|네이버/i.test(name) ? name : null;
}

function extractNaverBoardTitles(html = '') {
  const titles = [...String(html || '').matchAll(/title=["']([^"']{4,180})["']/g)]
    .map((match) => decodeHtmlText(match[1]))
    .filter((title) => {
      if (!title || title.length < 4) return false;
      if (/[<>]/.test(title)) return false;
      return !/(종목명|지수명|검색|네이버|로그인|동일업종|더보기|관심종목|최근조회)/.test(title);
    });
  return uniq(titles).slice(0, 20);
}

async function fetchNaverFinanceDiscussion(activeCandidates: ActiveCandidate[] = [], limit = 40): Promise<any[]> {
  const candidates = activeCandidates
    .filter((candidate) => candidate.market === 'domestic' && /^\d{6}$/.test(candidate.symbol))
    .slice(0, Math.min(40, Math.max(1, limit)));
  if (candidates.length === 0) return [];

  const settled = await Promise.allSettled(candidates.map(async (candidate) => {
    const symbol = candidate.symbol;
    const sourceUrl = `https://finance.naver.com/item/board.naver?code=${encodeURIComponent(symbol)}`;
    const html = await fetchTextWithTimeout(sourceUrl, DEFAULT_TIMEOUT_MS, {
      Referer: `https://finance.naver.com/item/main.naver?code=${encodeURIComponent(symbol)}`,
      'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
    });
    const titles = extractNaverBoardTitles(html);
    if (titles.length === 0) return null;
    const combinedText = titles.join(' ');
    const { direction, bullScore, bearScore } = keywordDirection(combinedText, KOREAN_BULLISH_KW, KOREAN_BEARISH_KW);
    const magnitude = Math.min(1, 0.24 + Math.min(0.32, titles.length / 40) + Math.min(0.24, Math.abs(bullScore - bearScore) * 0.08));
    return {
      sourceType: 'community',
      sourceName: 'naver_finance_discussion',
      sourceUrl,
      symbol,
      market: 'domestic',
      strategyFamily: 'community_sentiment',
      signalDirection: direction,
      score: directionScore(direction, magnitude),
      sourceQuality: 0.36,
      freshnessScore: 1.0,
      evidenceSummary: `Naver Finance discussion: ${symbol} posts=${titles.length} direction=${direction}`,
      rawRef: {
        candidateDriven: true,
        mentions: titles.length,
        source: 'naver_finance_board',
        sourceCandidate: candidate.source || null,
        candidateScore: candidate.score ?? null,
        bullishHits: bullScore,
        bearishHits: bearScore,
        titles: titles.slice(0, 5),
      },
    };
  }));

  return settled
    .filter((result) => result.status === 'fulfilled' && result.value)
    .map((result: any) => result.value)
    .slice(0, limit);
}

function extractNaverItemNewsTitles(html = '') {
  const titles = [
    ...String(html || '').matchAll(/<a[^>]+href=["'][^"']*news_read[^"']*["'][^>]*>(.*?)<\/a>/gis),
    ...String(html || '').matchAll(/title=["']([^"']{8,180})["']/g),
  ]
    .map((match) => decodeHtmlText(String(match[1] || '').replace(/<[^>]+>/g, ' ')))
    .filter((title) => {
      if (!title || title.length < 6) return false;
      if (/[{}<>]/.test(title)) return false;
      return !/(본문|목록|페이지|이전|다음|네이버|Npay|광고|언론사)/i.test(title);
    });
  return uniq(titles).slice(0, 20);
}

async function fetchNaverFinanceItemNews(activeCandidates: ActiveCandidate[] = [], limit = 40): Promise<any[]> {
  const candidates = activeCandidates
    .filter((candidate) => candidate.market === 'domestic' && /^\d{6}$/.test(candidate.symbol))
    .slice(0, Math.min(45, Math.max(1, limit)));
  if (candidates.length === 0) return [];

  const settled = await Promise.allSettled(candidates.map(async (candidate) => {
    const symbol = candidate.symbol;
    const sourceUrl = `https://finance.naver.com/item/news_news.naver?code=${encodeURIComponent(symbol)}&page=1&sm=title_entity_id.basic&clusterId=`;
    const html = await fetchTextWithTimeout(sourceUrl, DEFAULT_TIMEOUT_MS, {
      Referer: `https://finance.naver.com/item/main.naver?code=${encodeURIComponent(symbol)}`,
      'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
    });
    const titles = extractNaverItemNewsTitles(html);
    if (titles.length === 0) return null;
    const combinedText = titles.join(' ');
    const { direction, bullScore, bearScore } = keywordDirection(combinedText, KOREAN_BULLISH_KW, KOREAN_BEARISH_KW);
    const magnitude = Math.min(1, 0.22 + Math.min(0.30, titles.length / 45) + Math.min(0.22, Math.abs(bullScore - bearScore) * 0.07));
    return {
      sourceType: 'community',
      sourceName: 'naver_finance_item_news',
      sourceUrl,
      symbol,
      market: 'domestic',
      strategyFamily: 'news_sentiment',
      signalDirection: direction,
      score: directionScore(direction, magnitude),
      sourceQuality: 0.39,
      freshnessScore: 1.0,
      evidenceSummary: `Naver Finance item news: ${symbol} items=${titles.length} direction=${direction}`,
      rawRef: {
        candidateDriven: true,
        mentions: titles.length,
        source: 'naver_finance_item_news',
        sourceCandidate: candidate.source || null,
        candidateScore: candidate.score ?? null,
        bullishHits: bullScore,
        bearishHits: bearScore,
        titles: titles.slice(0, 5),
      },
    };
  }));

  return settled
    .filter((result) => result.status === 'fulfilled' && result.value)
    .map((result: any) => result.value)
    .slice(0, limit);
}

async function fetchGoogleNewsDomesticRss(activeCandidates: ActiveCandidate[] = [], limit = 40): Promise<any[]> {
  const candidates = activeCandidates
    .filter((candidate) => candidate.market === 'domestic' && /^\d{6}$/.test(candidate.symbol))
    .slice(0, Math.min(30, Math.max(1, limit)));
  if (candidates.length === 0) return [];

  const settled = await Promise.allSettled(candidates.map(async (candidate) => {
    const symbol = candidate.symbol;
    const name = await fetchNaverFinanceName(symbol).catch(() => null);
    const query = name ? `${name} 주식 OR ${name} 증권` : `${symbol} 주식`;
    const { url, items } = await fetchGoogleNewsRss(query, { hl: 'ko', gl: 'KR', ceid: 'KR:ko' }, 8);
    const relevant = items.filter((item) => {
      const text = `${item.title || ''} ${item.description || ''}`;
      return (name && text.includes(name)) || text.includes(symbol);
    });
    if (relevant.length === 0) return null;
    const combinedText = relevant.map((item) => `${item.title || ''} ${item.description || ''}`).join(' ');
    const { direction, bullScore, bearScore } = keywordDirection(combinedText, KOREAN_BULLISH_KW, KOREAN_BEARISH_KW);
    const magnitude = Math.min(1, 0.22 + Math.min(0.30, relevant.length * 0.07) + Math.min(0.20, Math.abs(bullScore - bearScore) * 0.06));
    return {
      sourceType: 'community',
      sourceName: 'google_news_domestic_rss',
      sourceUrl: relevant[0]?.link || url,
      symbol,
      market: 'domestic',
      strategyFamily: 'news_sentiment',
      signalDirection: direction,
      score: directionScore(direction, magnitude),
      sourceQuality: 0.38,
      freshnessScore: 1.0,
      evidenceSummary: `Google News domestic RSS: ${symbol}${name ? ` ${name}` : ''} matched=${relevant.length} direction=${direction}`,
      rawRef: {
        candidateDriven: true,
        mentions: relevant.length,
        query,
        name,
        sourceCandidate: candidate.source || null,
        candidateScore: candidate.score ?? null,
        bullishHits: bullScore,
        bearishHits: bearScore,
        items: relevant.slice(0, 4),
      },
    };
  }));

  return settled
    .filter((result) => result.status === 'fulfilled' && result.value)
    .map((result: any) => result.value)
    .slice(0, limit);
}

async function fetchDaumFinancePopularRanks(activeCandidates: ActiveCandidate[] = [], limit = 40): Promise<any[]> {
  const activeByCode = new Map(
    activeCandidates
      .filter((candidate) => candidate.market === 'domestic' && /^\d{6}$/.test(candidate.symbol))
      .map((candidate) => [`A${candidate.symbol}`, candidate]),
  );
  if (activeByCode.size === 0) return [];

  const resp = await fetch('https://finance.daum.net/api/search/ranks?limit=100', {
    headers: {
      'User-Agent': 'Mozilla/5.0 luna-community-evidence/1.1',
      Referer: 'https://finance.daum.net/',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`Daum Finance HTTP ${resp.status}`);
  const data = await resp.json();
  const ranks: any[] = data?.data || [];
  const events: any[] = [];

  for (const item of ranks) {
    const code = normalizeSymbol(item?.shortCode || item?.symbolCode || '');
    const candidate = activeByCode.get(code);
    if (!candidate) continue;
    const rank = Number(item?.rank || events.length + 1);
    const rankChange = Number(item?.rankChange || 0);
    const direction = rankChange > 0 ? 'bullish' : rankChange < 0 ? 'bearish' : 'neutral';
    const magnitude = Math.min(1, 0.22 + Math.max(0, 11 - rank) * 0.025 + Math.min(0.18, Math.abs(rankChange) * 0.015));
    events.push({
      sourceType: 'community',
      sourceName: 'daum_finance_popular_rank',
      sourceUrl: item?.boardUrl || `https://finance.daum.net/quotes/${code}`,
      symbol: candidate.symbol,
      market: 'domestic',
      strategyFamily: 'community_sentiment',
      signalDirection: direction,
      score: directionScore(direction, magnitude),
      sourceQuality: 0.34,
      freshnessScore: 1.0,
      evidenceSummary: `Daum Finance popular rank: ${candidate.symbol} rank=${rank} rankChange=${rankChange}`,
      rawRef: {
        candidateDriven: true,
        trendingRank: true,
        mentions: 1,
        rank,
        rankChange,
        name: item?.name || null,
        sourceCandidate: candidate.source || null,
        candidateScore: candidate.score ?? null,
      },
    });
  }
  return events.slice(0, limit);
}

function directionFromTossSignal(signal: any = {}) {
  const source = String(signal?.source || '').toLowerCase();
  if (['aisignals', 'strategies', 'top10', 'community', 'sectors'].includes(source)) return 'bullish';
  return 'neutral';
}

function inferMarketFromTossSignal(signal: any = {}): CandidateMarket | null {
  const market = String(signal?.market || '').toLowerCase();
  if (market === 'domestic' || market === 'overseas' || market === 'crypto') return market as CandidateMarket;
  const symbol = normalizeSymbol(signal?.symbol);
  if (/^\d{6}$/.test(symbol)) return 'domestic';
  if (symbol.endsWith('/USDT')) return 'crypto';
  if (/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) return 'overseas';
  return null;
}

function flattenTossSections(sections: Record<string, any> = {}) {
  const rows: Array<{ section: string; text: string }> = [];
  for (const [section, values] of Object.entries(sections || {})) {
    for (const raw of Array.isArray(values) ? values : []) {
      const text = String(raw || '').replace(/\s+/g, ' ').trim();
      if (text) rows.push({ section, text });
    }
  }
  return rows;
}

async function fetchTossMarketMcpIntel(activeCandidates: ActiveCandidate[] = [], limit = 40): Promise<any[]> {
  const activeBySymbol = new Map(
    activeCandidates
      .filter((candidate) => (
        (candidate.market === 'domestic' && /^\d{6}$/.test(candidate.symbol))
        || (candidate.market === 'overseas' && /^[A-Z][A-Z0-9.]{0,9}$/.test(candidate.symbol))
      ))
      .map((candidate) => [`${candidate.market}|${candidate.symbol}`, candidate]),
  );
  if (activeBySymbol.size === 0) return [];

  const payload = await collectTossMarketIntel({
    dryRun: String(process.env.LUNA_TOSS_MCP_DRY_RUN || '').toLowerCase() === 'true',
    limit: Math.min(40, Math.max(1, limit)),
    headless: process.env.LUNA_TOSS_MCP_HEADLESS !== 'false',
  });
  const signals: any[] = Array.isArray(payload?.signals) ? payload.signals : [];
  const events: any[] = [];
  const qualityStatus = String(payload?.quality?.status || 'unknown');
  const qualityWeight = qualityStatus === 'ready' ? 0.41 : qualityStatus === 'degraded' ? 0.32 : 0.20;
  const emitted = new Set<string>();

  for (const signal of signals) {
    const symbol = normalizeSymbol(signal?.symbol);
    const market = inferMarketFromTossSignal(signal);
    const candidate = market ? activeBySymbol.get(`${market}|${symbol}`) : null;
    if (!candidate) continue;
    const direction = directionFromTossSignal(signal);
    const signalScore = Math.max(0, Math.min(1, Number(signal?.score || 0.5)));
    const magnitude = direction === 'neutral'
      ? Math.min(0.32, 0.12 + signalScore * 0.22)
      : Math.min(1, 0.24 + signalScore * 0.48);
    emitted.add(`${candidate.market}|${symbol}`);
    events.push({
      sourceType: 'community',
      sourceName: 'toss_market_mcp_intel',
      sourceUrl: payload?.targetUrl || 'https://tossinvest.com/',
      symbol,
      market: candidate.market,
      strategyFamily: 'community_sentiment',
      signalDirection: direction,
      score: direction === 'neutral' ? Number(magnitude.toFixed(4)) : directionScore(direction, magnitude),
      sourceQuality: qualityWeight,
      freshnessScore: 1.0,
      evidenceSummary: `Toss MCP intel: ${symbol} ${signal?.label || ''} source=${signal?.source || 'unknown'} score=${signalScore.toFixed(2)}`,
      rawRef: {
        candidateDriven: true,
        mcpServer: 'toss-market-mcp-server',
        provider: 'toss_web_bridge',
        transport: payload?.transport || null,
        quality: payload?.quality || {},
        sectionCounts: payload?.sectionCounts || {},
        sourceCandidate: candidate.source || null,
        candidateScore: candidate.score ?? null,
        signal,
        mentions: 1,
        sectionsSample: Object.fromEntries(
          Object.entries(payload?.sections || {}).map(([key, values]) => [
            key,
            (Array.isArray(values) ? values : []).slice(0, 3),
          ]),
        ),
      },
    });
  }

  const sectionRows = flattenTossSections(payload?.sections || {});
  for (const candidate of activeCandidates.filter((item) => item.market === 'overseas')) {
    const symbol = normalizeSymbol(candidate.symbol);
    if (!symbol || emitted.has(`overseas|${symbol}`)) continue;
    const keywords = keywordsForEquitySymbol(symbol);
    const matches = sectionRows.filter((row) => keywords.some((kw) => matchesEquityKeyword(row.text, kw)));
    if (matches.length === 0) continue;
    const combinedText = matches.map((row) => row.text).join(' ');
    const direction = inferDirection(combinedText);
    const magnitude = Math.min(0.48, 0.18 + matches.length * 0.06);
    emitted.add(`overseas|${symbol}`);
    events.push({
      sourceType: 'community',
      sourceName: 'toss_market_mcp_intel',
      sourceUrl: payload?.targetUrl || 'https://tossinvest.com/',
      symbol,
      market: 'overseas',
      strategyFamily: 'community_sentiment',
      signalDirection: direction,
      score: direction === 'neutral' ? Number(magnitude.toFixed(4)) : directionScore(direction, magnitude),
      sourceQuality: Math.max(0.26, qualityWeight - 0.05),
      freshnessScore: 1.0,
      evidenceSummary: `Toss MCP overseas section match: ${symbol} matches=${matches.length}`,
      rawRef: {
        candidateDriven: true,
        mcpServer: 'toss-market-mcp-server',
        provider: 'toss_web_bridge',
        transport: payload?.transport || null,
        quality: payload?.quality || {},
        sectionCounts: payload?.sectionCounts || {},
        sourceCandidate: candidate.source || null,
        candidateScore: candidate.score ?? null,
        signal: {
          symbol,
          market: 'overseas',
          source: 'section_scan',
          score: magnitude,
        },
        mentions: matches.length,
        matchedKeywords: keywords,
        matchedSections: matches.slice(0, 5),
      },
    });
  }
  return events.slice(0, limit);
}

async function fetchRedditEquityCandidateMentions(activeCandidates: ActiveCandidate[] = [], limit = 60): Promise<any[]> {
  const candidates = activeCandidates
    .filter((candidate) => candidate.market === 'overseas' && candidate.symbol)
    .slice(0, Math.min(80, Math.max(1, limit)));
  if (candidates.length === 0) return [];

  const subreddits = ['stocks', 'investing', 'wallstreetbets'];
  const settled = await Promise.allSettled(
    subreddits.map(async (subreddit) => {
      const data = await fetchWithTimeout(`https://www.reddit.com/r/${subreddit}/hot.json?limit=75`);
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
    for (const candidate of candidates) {
      const symbol = normalizeSymbol(candidate.symbol);
      const keywords = keywordsForEquitySymbol(symbol);
      const relevant = posts.filter((post: any) => {
        const text = `${post?.title || ''} ${post?.selftext || ''}`.slice(0, 2000);
        return keywords.some((kw) => matchesEquityKeyword(text, kw));
      });
      if (relevant.length === 0) continue;
      const avgUpvoteRatio = relevant.reduce((sum: number, post: any) => sum + Number(post?.upvote_ratio || 0.5), 0) / relevant.length;
      const totalScore = relevant.reduce((sum: number, post: any) => sum + Number(post?.score || 0), 0);
      const combinedText = relevant.map((post: any) => `${post?.title || ''} ${post?.selftext || ''}`).join(' ');
      const direction = inferDirection(combinedText);
      const magnitude = Math.min(1, 0.22 + avgUpvoteRatio * 0.30 + Math.min(0.22, relevant.length / 14) + Math.min(0.18, totalScore / 1200));
      const sourceQuality = subreddit === 'wallstreetbets' ? 0.32 : 0.35;
      events.push({
        sourceType: 'community',
        sourceName: `reddit_equity_${subreddit.toLowerCase()}`,
        sourceUrl: `https://www.reddit.com/r/${subreddit}/`,
        symbol,
        market: 'overseas',
        strategyFamily: 'community_sentiment',
        signalDirection: direction,
        score: directionScore(direction, magnitude),
        sourceQuality,
        freshnessScore: 1.0,
        evidenceSummary: `Reddit equity scan r/${subreddit}: ${symbol} mentions=${relevant.length} totalScore=${totalScore}`,
        rawRef: {
          candidateDriven: true,
          mentions: relevant.length,
          avgUpvoteRatio,
          totalScore,
          subreddit,
          sourceCandidate: candidate.source || null,
          candidateScore: candidate.score ?? null,
          keywords,
          topPosts: relevant.slice(0, 3).map((post: any) => ({
            title: post?.title,
            score: post?.score,
            upvote_ratio: post?.upvote_ratio,
          })),
        },
      });
    }
  }
  return events.slice(0, limit);
}

async function fetchRedditEquityGlobalSearch(activeCandidates: ActiveCandidate[] = [], limit = 60): Promise<any[]> {
  const candidates = activeCandidates
    .filter((candidate) => candidate.market === 'overseas' && candidate.symbol)
    .slice(0, Math.min(65, Math.max(1, limit)));
  if (candidates.length === 0) return [];

  const settled = await Promise.allSettled(candidates.map(async (candidate) => {
    const symbol = normalizeSymbol(candidate.symbol);
    const keywords = keywordsForEquitySymbol(symbol);
    const query = `${symbol} stock`;
    const data = await fetchWithTimeout(`https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=new&limit=15`);
    const posts: any[] = (data?.data?.children || []).map((c: any) => c?.data).filter(Boolean);
    const relevant = posts.filter((post: any) => {
      const text = `${post?.title || ''} ${post?.selftext || ''}`.slice(0, 2500);
      return keywords.some((kw) => matchesEquityKeyword(text, kw));
    });
    if (relevant.length === 0) return null;
    const avgUpvoteRatio = relevant.reduce((sum: number, post: any) => sum + Number(post?.upvote_ratio || 0.5), 0) / relevant.length;
    const totalScore = relevant.reduce((sum: number, post: any) => sum + Number(post?.score || 0), 0);
    const combinedText = relevant.map((post: any) => `${post?.title || ''} ${post?.selftext || ''}`).join(' ');
    const direction = inferDirection(combinedText);
    const magnitude = Math.min(1, 0.20 + avgUpvoteRatio * 0.30 + Math.min(0.24, relevant.length / 12) + Math.min(0.16, totalScore / 1000));
    return {
      sourceType: 'community',
      sourceName: 'reddit_equity_global_search',
      sourceUrl: `https://www.reddit.com/search/?q=${encodeURIComponent(query)}&sort=new`,
      symbol,
      market: 'overseas',
      strategyFamily: 'community_sentiment',
      signalDirection: direction,
      score: directionScore(direction, magnitude),
      sourceQuality: 0.34,
      freshnessScore: 1.0,
      evidenceSummary: `Reddit global equity search: ${symbol} mentions=${relevant.length} totalScore=${totalScore}`,
      rawRef: {
        candidateDriven: true,
        mentions: relevant.length,
        avgUpvoteRatio,
        totalScore,
        sourceCandidate: candidate.source || null,
        candidateScore: candidate.score ?? null,
        query,
        keywords,
        topPosts: relevant.slice(0, 3).map((post: any) => ({
          subreddit: post?.subreddit,
          title: post?.title,
          score: post?.score,
          upvote_ratio: post?.upvote_ratio,
        })),
      },
    };
  }));

  return settled
    .filter((result) => result.status === 'fulfilled' && result.value)
    .map((result: any) => result.value)
    .slice(0, limit);
}

async function fetchGoogleNewsEquityRss(activeCandidates: ActiveCandidate[] = [], limit = 60): Promise<any[]> {
  const candidates = activeCandidates
    .filter((candidate) => candidate.market === 'overseas' && candidate.symbol)
    .slice(0, Math.min(55, Math.max(1, limit)));
  if (candidates.length === 0) return [];

  const settled = await Promise.allSettled(candidates.map(async (candidate) => {
    const symbol = normalizeSymbol(candidate.symbol);
    const aliases = keywordsForEquitySymbol(symbol).filter((kw) => !kw.startsWith('$')).slice(0, 3);
    const query = `${symbol} stock${aliases.length > 0 ? ` OR ${aliases.join(' OR ')}` : ''}`;
    const { url, items } = await fetchGoogleNewsRss(query, { hl: 'en-US', gl: 'US', ceid: 'US:en' }, 8);
    const keywords = keywordsForEquitySymbol(symbol);
    const relevant = items.filter((item) => {
      const text = `${item.title || ''} ${item.description || ''}`;
      return keywords.some((kw) => matchesEquityKeyword(text, kw));
    });
    if (relevant.length === 0) return null;
    const combinedText = relevant.map((item) => `${item.title || ''} ${item.description || ''}`).join(' ');
    const direction = inferDirection(combinedText);
    const magnitude = Math.min(1, 0.24 + Math.min(0.30, relevant.length * 0.07));
    return {
      sourceType: 'community',
      sourceName: 'google_news_equity_rss',
      sourceUrl: relevant[0]?.link || url,
      symbol,
      market: 'overseas',
      strategyFamily: 'news_sentiment',
      signalDirection: direction,
      score: directionScore(direction, magnitude),
      sourceQuality: 0.38,
      freshnessScore: 1.0,
      evidenceSummary: `Google News equity RSS: ${symbol} matched=${relevant.length} direction=${direction}`,
      rawRef: {
        candidateDriven: true,
        mentions: relevant.length,
        sourceCandidate: candidate.source || null,
        candidateScore: candidate.score ?? null,
        query,
        keywords,
        items: relevant.slice(0, 4),
      },
    };
  }));

  return settled
    .filter((result) => result.status === 'fulfilled' && result.value)
    .map((result: any) => result.value)
    .slice(0, limit);
}

async function fetchYahooFinanceNewsSearch(activeCandidates: ActiveCandidate[] = [], limit = 60): Promise<any[]> {
  const candidates = activeCandidates
    .filter((candidate) => candidate.market === 'overseas' && candidate.symbol)
    .slice(0, Math.min(60, Math.max(1, limit)));
  if (candidates.length === 0) return [];

  const settled = await Promise.allSettled(candidates.map(async (candidate) => {
    const symbol = normalizeSymbol(candidate.symbol);
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&newsCount=6`;
    const data = await fetchWithTimeout(url);
    const news: any[] = data?.news || [];
    const keywords = keywordsForEquitySymbol(symbol);
    const relevant = news.filter((item) => {
      const text = `${item?.title || ''} ${item?.publisher || ''}`;
      return keywords.some((kw) => matchesEquityKeyword(text, kw));
    });
    if (relevant.length === 0) return null;
    const combinedText = relevant.map((item) => item?.title || '').join(' ');
    const direction = inferDirection(combinedText);
    const recencyBoost = relevant.some((item) => {
      const ts = Number(item?.providerPublishTime || 0) * 1000;
      return ts > 0 && Date.now() - ts <= 12 * 3600_000;
    }) ? 0.08 : 0;
    const magnitude = Math.min(1, 0.28 + Math.min(0.28, relevant.length * 0.06) + recencyBoost);
    return {
      sourceType: 'community',
      sourceName: 'yahoo_finance_news_search',
      sourceUrl: relevant[0]?.link || `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/news`,
      symbol,
      market: 'overseas',
      strategyFamily: 'news_sentiment',
      signalDirection: direction,
      score: directionScore(direction, magnitude),
      sourceQuality: 0.42,
      freshnessScore: 1.0,
      evidenceSummary: `Yahoo Finance news search: ${symbol} matched=${relevant.length} direction=${direction}`,
      rawRef: {
        candidateDriven: true,
        mentions: relevant.length,
        sourceCandidate: candidate.source || null,
        candidateScore: candidate.score ?? null,
        keywords,
        topNews: relevant.slice(0, 4).map((item) => ({
          title: item?.title,
          publisher: item?.publisher,
          providerPublishTime: item?.providerPublishTime,
          link: item?.link,
        })),
      },
    };
  }));

  return settled
    .filter((result) => result.status === 'fulfilled' && result.value)
    .map((result: any) => result.value)
    .slice(0, limit);
}

async function fetchDomesticMarketNewsRssBundle(activeCandidates: ActiveCandidate[] = [], limit = 60): Promise<any[]> {
  const candidates = activeCandidates
    .filter((candidate) => candidate.market === 'domestic' && /^\d{6}$/.test(candidate.symbol))
    .slice(0, Math.min(45, Math.max(1, limit)));

  const nameBySymbol = new Map<string, string | null>();
  await Promise.all(candidates.map(async (candidate) => {
    const symbol = normalizeSymbol(candidate.symbol);
    const name = await fetchNaverFinanceName(symbol).catch(() => null);
    nameBySymbol.set(symbol, name);
  }));

  const settled = await Promise.allSettled(DOMESTIC_MARKET_NEWS_RSS_FEEDS.map(async (feed) => {
    const xml = await fetchTextWithTimeout(feed.url, DEFAULT_TIMEOUT_MS, {
      Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.7',
      'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.7',
    });
    const items = parseRssItems(xml, 80);
    const feedEvents: any[] = [];
    if (items.length > 0) {
      const marketText = items.slice(0, 20).map((item) => `${item.title || ''} ${item.description || ''}`).join(' ');
      const { direction, bullScore, bearScore } = keywordDirection(marketText, KOREAN_BULLISH_KW, KOREAN_BEARISH_KW);
      const freshnessScore = Math.max(...items.slice(0, 20).map((item) => rssFreshnessScore(item.pubDate)));
      feedEvents.push({
        sourceType: 'community',
        sourceName: `domestic_market_news_rss_${feed.key}`,
        sourceUrl: items[0]?.link || feed.url,
        symbol: null,
        market: 'domestic',
        strategyFamily: 'market_news_sentiment',
        signalDirection: direction,
        score: directionScore(direction, Math.min(0.55, 0.20 + Math.min(0.20, Math.abs(bullScore - bearScore) * 0.04))),
        sourceQuality: feed.sourceQuality,
        freshnessScore,
        evidenceSummary: `${feed.publisher} RSS market-wide domestic news: items=${items.length} direction=${direction}`,
        rawRef: {
          marketWide: true,
          mentions: items.length,
          publisher: feed.publisher,
          feedUrl: feed.url,
          bullishHits: bullScore,
          bearishHits: bearScore,
          articles: items.slice(0, 5).map((item) => ({
            title: item.title,
            link: item.link,
            pubDate: item.pubDate || null,
            source: item.source || feed.publisher,
          })),
        },
      });
      feedEvents.push(...buildDomesticMarketwideArticleEvents(feed, items, 4));
    }

    for (const candidate of candidates) {
      const symbol = normalizeSymbol(candidate.symbol);
      const name = nameBySymbol.get(symbol);
      const relevant = items.filter((item) => {
        const text = `${item.title || ''} ${item.description || ''}`;
        return text.includes(symbol) || (Boolean(name) && text.includes(String(name)));
      });
      if (relevant.length === 0) continue;

      const combinedText = relevant.map((item) => `${item.title || ''} ${item.description || ''}`).join(' ');
      const { direction, bullScore, bearScore } = keywordDirection(combinedText, KOREAN_BULLISH_KW, KOREAN_BEARISH_KW);
      const freshnessScore = Math.max(...relevant.map((item) => rssFreshnessScore(item.pubDate)));
      const magnitude = Math.min(1, 0.24 + Math.min(0.28, relevant.length * 0.07) + Math.min(0.18, Math.abs(bullScore - bearScore) * 0.06));
      feedEvents.push({
        sourceType: 'community',
        sourceName: `domestic_market_news_rss_${feed.key}`,
        sourceUrl: relevant[0]?.link || feed.url,
        symbol,
        market: 'domestic',
        strategyFamily: 'news_sentiment',
        signalDirection: direction,
        score: directionScore(direction, magnitude),
        sourceQuality: feed.sourceQuality,
        freshnessScore,
        evidenceSummary: `${feed.publisher} RSS: ${symbol}${name ? `/${name}` : ''} matched=${relevant.length} direction=${direction}`,
        rawRef: {
          candidateDriven: true,
          mentions: relevant.length,
          publisher: feed.publisher,
          feedUrl: feed.url,
          symbolName: name || null,
          sourceCandidate: candidate.source || null,
          candidateScore: candidate.score ?? null,
          bullishHits: bullScore,
          bearishHits: bearScore,
          articles: relevant.slice(0, 5).map((item) => ({
            title: item.title,
            link: item.link,
            pubDate: item.pubDate || null,
            source: item.source || feed.publisher,
          })),
        },
      });
    }

    return feedEvents;
  }));

  return settled
    .flatMap((result, index) => {
      if (result.status === 'fulfilled') return result.value;
      const feed = DOMESTIC_MARKET_NEWS_RSS_FEEDS[index];
      return [{
        sourceType: 'community',
        sourceName: `domestic_market_news_rss_${feed?.key || 'unknown'}`,
        sourceUrl: feed?.url || null,
        symbol: null,
        market: 'domestic',
        strategyFamily: 'market_news_sentiment',
        signalDirection: 'neutral',
        score: 0,
        sourceQuality: 0,
        freshnessScore: 1,
        evidenceSummary: `${feed?.publisher || 'Domestic market RSS'}: source_error ${result.reason?.message || result.reason}`,
        rawRef: { marketWide: true, source_error: true, provider: feed?.publisher || null, feedUrl: feed?.url || null, error: String(result.reason?.message || result.reason) },
      }];
    })
    .slice(0, limit);
}

async function fetchOverseasMarketNewsRssBundle(activeCandidates: ActiveCandidate[] = [], limit = 60): Promise<any[]> {
  const candidates = activeCandidates
    .filter((candidate) => candidate.market === 'overseas' && candidate.symbol)
    .slice(0, Math.min(70, Math.max(1, limit)));

  const settled = await Promise.allSettled(OVERSEAS_MARKET_NEWS_RSS_FEEDS.map(async (feed) => {
    const xml = await fetchTextWithTimeout(feed.url, DEFAULT_TIMEOUT_MS, {
      Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.7',
      'Accept-Language': 'en-US,en;q=0.9',
    });
    const items = parseRssItems(xml, 80);
    const feedEvents: any[] = [];
    if (items.length > 0) {
      const marketText = items.slice(0, 20).map((item) => `${item.title || ''} ${item.description || ''}`).join(' ');
      const direction = inferDirection(marketText);
      const freshnessScore = Math.max(...items.slice(0, 20).map((item) => rssFreshnessScore(item.pubDate)));
      feedEvents.push({
        sourceType: 'community',
        sourceName: `overseas_market_news_rss_${feed.key}`,
        sourceUrl: items[0]?.link || feed.url,
        symbol: null,
        market: 'overseas',
        strategyFamily: 'market_news_sentiment',
        signalDirection: direction,
        score: directionScore(direction, 0.38),
        sourceQuality: feed.sourceQuality,
        freshnessScore,
        evidenceSummary: `${feed.publisher} RSS market-wide overseas news: items=${items.length} direction=${direction}`,
        rawRef: {
          marketWide: true,
          mentions: items.length,
          publisher: feed.publisher,
          feedUrl: feed.url,
          articles: items.slice(0, 5).map((item) => ({
            title: item.title,
            link: item.link,
            pubDate: item.pubDate || null,
            source: item.source || feed.publisher,
          })),
        },
      });
      feedEvents.push(...buildOverseasMarketwideArticleEvents(feed, items, 3));
    }

    for (const candidate of candidates) {
      const symbol = normalizeSymbol(candidate.symbol);
      const keywords = keywordsForEquitySymbol(symbol);
      const relevant = items.filter((item) => {
        const text = `${item.title || ''} ${item.description || ''}`;
        return keywords.some((kw) => matchesEquityKeyword(text, kw));
      });
      if (relevant.length === 0) continue;

      const combinedText = relevant.map((item) => `${item.title || ''} ${item.description || ''}`).join(' ');
      const direction = inferDirection(combinedText);
      const freshnessScore = Math.max(...relevant.map((item) => rssFreshnessScore(item.pubDate)));
      const magnitude = Math.min(1, 0.25 + Math.min(0.28, relevant.length * 0.07) + Math.min(0.16, freshnessScore * 0.16));
      feedEvents.push({
        sourceType: 'community',
        sourceName: `overseas_market_news_rss_${feed.key}`,
        sourceUrl: relevant[0]?.link || feed.url,
        symbol,
        market: 'overseas',
        strategyFamily: 'news_sentiment',
        signalDirection: direction,
        score: directionScore(direction, magnitude),
        sourceQuality: feed.sourceQuality,
        freshnessScore,
        evidenceSummary: `${feed.publisher} RSS: ${symbol} matched=${relevant.length} direction=${direction}`,
        rawRef: {
          candidateDriven: true,
          mentions: relevant.length,
          publisher: feed.publisher,
          feedUrl: feed.url,
          matchedKeywords: keywords,
          sourceCandidate: candidate.source || null,
          candidateScore: candidate.score ?? null,
          articles: relevant.slice(0, 5).map((item) => ({
            title: item.title,
            link: item.link,
            pubDate: item.pubDate || null,
            source: item.source || feed.publisher,
          })),
        },
      });
    }

    return feedEvents;
  }));

  return settled
    .flatMap((result, index) => {
      if (result.status === 'fulfilled') return result.value;
      const feed = OVERSEAS_MARKET_NEWS_RSS_FEEDS[index];
      return [{
        sourceType: 'community',
        sourceName: `overseas_market_news_rss_${feed?.key || 'unknown'}`,
        sourceUrl: feed?.url || null,
        symbol: null,
        market: 'overseas',
        strategyFamily: 'market_news_sentiment',
        signalDirection: 'neutral',
        score: 0,
        sourceQuality: 0,
        freshnessScore: 1,
        evidenceSummary: `${feed?.publisher || 'Overseas market RSS'}: source_error ${result.reason?.message || result.reason}`,
        rawRef: { marketWide: true, source_error: true, provider: feed?.publisher || null, feedUrl: feed?.url || null, error: String(result.reason?.message || result.reason) },
      }];
    })
    .slice(0, limit);
}

function buildMissingCommunityEvidence(activeSymbols: string[] = [], existingEvents: any[] = [], limit = 60) {
  if (String(process.env.LUNA_COMMUNITY_GAP_EVIDENCE_ENABLED || 'true').toLowerCase() === 'false') return [];
  const cryptoCandidates = activeSymbols.map((symbol) => ({ symbol, market: 'crypto' as CandidateMarket }));
  return buildMissingCommunityEvidenceForCandidates(cryptoCandidates, existingEvents, limit);
}

function buildMissingCommunityEvidenceForCandidates(activeCandidates: ActiveCandidate[] = [], existingEvents: any[] = [], limit = 60) {
  if (String(process.env.LUNA_COMMUNITY_GAP_EVIDENCE_ENABLED || 'true').toLowerCase() === 'false') return [];
  const seen = new Set(existingEvents
    .filter((event) => event.symbol && event.market)
    .map((event) => `${event.market}|${normalizeSymbol(event.symbol)}`));
  return activeCandidates
    .filter((candidate) => candidate.symbol && candidate.market)
    .filter((candidate) => !seen.has(`${candidate.market}|${normalizeSymbol(candidate.symbol)}`))
    .slice(0, limit)
    .map((candidate) => ({
      sourceType: 'community',
      sourceName: 'community_candidate_gap',
      sourceUrl: null,
      symbol: candidate.symbol,
      market: candidate.market,
      strategyFamily: 'community_sentiment',
      signalDirection: 'neutral',
      score: 0,
      sourceQuality: 0.10,
      freshnessScore: 1.0,
      evidenceSummary: `Community evidence gap recorded for active ${candidate.market} candidate ${candidate.symbol}`,
      rawRef: {
        missing_data: true,
        candidateDriven: true,
        reason: candidate.market === 'crypto' ? 'no_reddit_apewisdom_news_match' : 'no_market_community_match',
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

async function resolveLunaNaverNewsCredentials() {
  const envCredentials = {
    clientId: process.env.NAVER_CLIENT_ID || process.env.NAVER_NEWS_CLIENT_ID || '',
    clientSecret: process.env.NAVER_CLIENT_SECRET || process.env.NAVER_NEWS_CLIENT_SECRET || '',
  };
  if (envCredentials.clientId && envCredentials.clientSecret) {
    return { ...envCredentials, source: 'env' };
  }
  try {
    const resolved = await resolveNaverCredentials({
      timeoutMs: Number(process.env.LUNA_NAVER_CREDENTIAL_TIMEOUT_MS || 3000),
    });
    return {
      clientId: resolved?.clientId || envCredentials.clientId,
      clientSecret: resolved?.clientSecret || envCredentials.clientSecret,
      source: resolved?.clientId && resolved?.clientSecret ? 'hub_or_shared_news_credentials' : 'missing',
    };
  } catch (error) {
    return {
      ...envCredentials,
      source: 'credential_resolver_error',
      error: String(error?.message || error),
    };
  }
}

async function fetchNaverNews({ clientId, clientSecret, limit = 20 } = {}): Promise<any[]> {
  if (!clientId || !clientSecret) {
    return [missingSecretEvent('naver_news', [
      'NAVER_CLIENT_ID',
      'NAVER_CLIENT_SECRET',
      'NAVER_NEWS_CLIENT_ID',
      'NAVER_NEWS_CLIENT_SECRET',
      'hub.news.naver_client_id',
      'hub.news.naver_client_secret',
    ])];
  }
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

async function collectSource(name: string, fn: () => Promise<any[]>, market: CandidateMarket = 'crypto') {
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
        market,
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
    const key = `${event.market || 'unknown'}|${event.symbol || '__market__'}`;
    bySymbol.set(key, [...(bySymbol.get(key) || []), event]);
  }
  return events.map((event) => {
    const scoped = bySymbol.get(`${event.market || 'unknown'}|${event.symbol || '__market__'}`) || [event];
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

async function applySourceQualityFeedback(events: any[], options: any = {}) {
  if (options.enabled === false || events.length === 0) {
    return { events, audit: null, adjustedCount: 0 };
  }
  const audit = await fetchLunaCommunitySourceQualityAudit({
    days: Number(options.days || 7),
    minEvents: Number(options.minEvents || 3),
  }).catch((error) => ({
    ok: false,
    blockers: ['community_source_quality_audit_failed'],
    warnings: [String(error?.message || error)],
    overrides: {},
  }));
  const overrides = audit?.overrides || {};
  let adjustedCount = 0;
  const adjustedEvents = events.map((event) => {
    const adjusted = adjustCommunitySourceQuality(event, overrides);
    if (!adjusted.applied) return event;
    adjustedCount += 1;
    return {
      ...event,
      sourceQuality: adjusted.sourceQuality,
      rawRef: {
        ...(event.rawRef || {}),
        sourceQualityFeedback: {
          applied: true,
          previousSourceQuality: event.sourceQuality,
          adjustedSourceQuality: adjusted.sourceQuality,
          status: adjusted.override?.status,
          reasons: adjusted.override?.reasons || [],
        },
      },
    };
  });
  return { events: adjustedEvents, audit, adjustedCount };
}

export async function runCommunityEvidenceRefresh(options: any = {}): Promise<any> {
  const json = options.json === true;
  const dryRun = options.dryRun === true;
  const fixture = options.fixture === true;
  const limit = Math.max(1, Number(options.limit || 60));
  if (!dryRun) await db.initSchema();
  const [activeCryptoCandidates, activeDomesticCandidates, activeOverseasCandidates] = fixture
    ? [[], [], []]
    : await Promise.all([
      getActiveCandidateRows('crypto', limit),
      getActiveCandidateRows('domestic', limit),
      getActiveCandidateRows('overseas', limit),
    ]);
  const activeSymbols = activeCryptoCandidates
    .map((candidate: ActiveCandidate) => normalizeSymbol(candidate.symbol))
    .filter((symbol: string) => symbol.endsWith('/USDT'));
  const allActiveCandidates = [
    ...activeCryptoCandidates,
    ...activeDomesticCandidates,
    ...activeOverseasCandidates,
  ];
  const naverNewsCredentials = fixture
    ? { clientId: '', clientSecret: '', source: 'fixture_skipped' }
    : await resolveLunaNaverNewsCredentials();

  const sourceResults = fixture
    ? [{ source: 'fixture', ok: true, count: fixtureEvents(limit).length, events: fixtureEvents(limit), error: null }]
    : await Promise.all([
      collectSource('apewisdom_crypto', () => fetchApeWisdom(limit, activeSymbols)),
      collectSource('reddit', () => fetchAllRedditSources(limit)),
      collectSource('reddit_candidate_scan', () => fetchRedditCandidateMentions(activeSymbols, limit)),
      collectSource('reddit_crypto_global_search', () => fetchRedditGlobalCryptoSearch(activeSymbols, limit)),
      collectSource('google_news_crypto_rss', () => fetchGoogleNewsCryptoRss(activeSymbols, limit)),
      collectSource('crypto_news_rss_bundle', () => fetchCryptoNewsRssBundle(activeSymbols, limit)),
      collectSource('coingecko_trending_community', () => fetchCoinGeckoTrendingCommunity(activeSymbols, limit)),
      collectSource('coingecko_search_interest', () => fetchCoinGeckoSearchInterest(activeSymbols, limit)),
      collectSource('alternative_fear_greed_index', () => fetchAlternativeFearGreed()),
      collectSource('naver_news', () => fetchNaverNews({
        clientId: naverNewsCredentials.clientId,
        clientSecret: naverNewsCredentials.clientSecret,
        limit,
      })),
      collectSource('naver_finance_discussion', () => fetchNaverFinanceDiscussion(activeDomesticCandidates, limit), 'domestic'),
      collectSource('naver_finance_item_news', () => fetchNaverFinanceItemNews(activeDomesticCandidates, limit), 'domestic'),
      collectSource('google_news_domestic_rss', () => fetchGoogleNewsDomesticRss(activeDomesticCandidates, limit), 'domestic'),
      collectSource('domestic_market_news_rss_bundle', () => fetchDomesticMarketNewsRssBundle(activeDomesticCandidates, limit), 'domestic'),
      collectSource('daum_finance_popular_rank', () => fetchDaumFinancePopularRanks(activeDomesticCandidates, limit), 'domestic'),
      collectSource('toss_market_mcp_intel', () => fetchTossMarketMcpIntel([...activeDomesticCandidates, ...activeOverseasCandidates], limit), 'domestic'),
      collectSource('reddit_equity_candidate_scan', () => fetchRedditEquityCandidateMentions(activeOverseasCandidates, limit), 'overseas'),
      collectSource('reddit_equity_global_search', () => fetchRedditEquityGlobalSearch(activeOverseasCandidates, limit), 'overseas'),
      collectSource('google_news_equity_rss', () => fetchGoogleNewsEquityRss(activeOverseasCandidates, limit), 'overseas'),
      collectSource('yahoo_finance_news_search', () => fetchYahooFinanceNewsSearch(activeOverseasCandidates, limit), 'overseas'),
      collectSource('overseas_market_news_rss_bundle', () => fetchOverseasMarketNewsRssBundle(activeOverseasCandidates, limit), 'overseas'),
    ]);

  const collectedEvents = sourceResults.flatMap((result) => result.events || []);
  const gapEvents = buildMissingCommunityEvidenceForCandidates(allActiveCandidates, collectedEvents, limit);
  const maxTotalEvents = fixture ? limit : limit * 8;
  const selectedCollectedEvents = collectedEvents.slice(0, maxTotalEvents);
  const baseEvents = attachAggregates([
    ...selectedCollectedEvents,
    ...gapEvents.slice(0, Math.max(0, maxTotalEvents - selectedCollectedEvents.length)),
  ]);
  const sourceQualityFeedback = await applySourceQualityFeedback(baseEvents, {
    enabled: !fixture && options.sourceQualityFeedback !== false,
    days: Number(options.sourceQualityDays || 7),
    minEvents: Number(options.sourceQualityMinEvents || 3),
  });
  const allEvents = sourceQualityFeedback.events;
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
    credentialSources: {
      naverNews: {
        source: naverNewsCredentials.source,
        present: Boolean(naverNewsCredentials.clientId && naverNewsCredentials.clientSecret),
        error: naverNewsCredentials.error || null,
      },
    },
    activeCandidateSymbols: activeSymbols,
    activeCandidateSymbolsByMarket: {
      crypto: activeCryptoCandidates.map((candidate: ActiveCandidate) => candidate.symbol),
      domestic: activeDomesticCandidates.map((candidate: ActiveCandidate) => candidate.symbol),
      overseas: activeOverseasCandidates.map((candidate: ActiveCandidate) => candidate.symbol),
    },
    gapEvidence: gapEvents.length,
    gapEvidenceByMarket: gapEvents.reduce((acc: Record<string, number>, event: any) => {
      const market = event.market || 'unknown';
      acc[market] = (acc[market] || 0) + 1;
      return acc;
    }, {}),
    gapEvidenceSymbols: gapEvents.slice(0, 20).map((event: any) => ({
      market: event.market || null,
      symbol: event.symbol || null,
      reason: event.rawRef?.reason || 'community_evidence_gap',
    })),
    sourceQualityFeedback: {
      enabled: !fixture && options.sourceQualityFeedback !== false,
      ok: sourceQualityFeedback.audit?.ok ?? null,
      adjustedCount: sourceQualityFeedback.adjustedCount,
      blockers: sourceQualityFeedback.audit?.blockers || [],
      warnings: sourceQualityFeedback.audit?.warnings || [],
      totalSources: sourceQualityFeedback.audit?.totalSources || 0,
    },
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
  parseRssItems,
  fetchDomesticMarketNewsRssBundle,
  fetchOverseasMarketNewsRssBundle,
};

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => runCommunityEvidenceRefresh({
      json: hasFlag('json'),
      dryRun: hasFlag('dry-run'),
      fixture: hasFlag('fixture'),
      limit: Number(argValue('limit', 60)),
      sourceQualityFeedback: !hasFlag('no-source-quality-feedback'),
      sourceQualityDays: Number(argValue('source-quality-days', 7)),
      sourceQualityMinEvents: Number(argValue('source-quality-min-events', 3)),
    }),
    onSuccess: async (result) => {
      if (typeof result === 'string') console.log(result);
      else console.log(JSON.stringify(result, null, 2));
    },
    errorPrefix: 'runtime-luna-community-evidence-refresh error:',
  });
}
