#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

// Shadow mode: DB에 저장하되 trade 결정에는 영향 없음 (1주 로그 누적 목적)
const SHADOW_MODE = process.env.LUNA_COMMUNITY_EVIDENCE_SHADOW_MODE !== 'false';

const TICKER_SYMBOL_MAP: Record<string, string> = {
  BTC: 'BTC/USDT', ETH: 'ETH/USDT', SOL: 'SOL/USDT', BNB: 'BNB/USDT',
  XRP: 'XRP/USDT', ADA: 'ADA/USDT', DOGE: 'DOGE/USDT', AVAX: 'AVAX/USDT',
  DOT: 'DOT/USDT', MATIC: 'MATIC/USDT', LINK: 'LINK/USDT', ATOM: 'ATOM/USDT',
  NEAR: 'NEAR/USDT', ARB: 'ARB/USDT', OP: 'OP/USDT', SUI: 'SUI/USDT',
};

// 종목별 Reddit 검색 키워드
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

function inferDirection(text: string): 'bullish' | 'bearish' | 'neutral' {
  const lower = String(text || '').toLowerCase();
  const bullScore = BULLISH_KW.filter(kw => lower.includes(kw)).length;
  const bearScore = BEARISH_KW.filter(kw => lower.includes(kw)).length;
  if (bullScore > bearScore) return 'bullish';
  if (bearScore > bullScore) return 'bearish';
  return 'neutral';
}

function directionScore(direction: string, magnitude = 0.5): number {
  const m = Math.min(1, Math.max(0.1, magnitude));
  if (direction === 'bullish') return m;
  if (direction === 'bearish') return -m;
  return 0;
}

async function fetchWithTimeout(url: string, timeoutMs = 8000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'luna-community-evidence/1.0 (team-jay research)' },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── ApeWisdom: 무료, 인증 불필요, 암호화폐 커뮤니티 언급 수 ──────────────────
async function fetchApeWisdom(): Promise<any[]> {
  const data = await fetchWithTimeout('https://apewisdom.io/api/v1.0/filter/all-crypto/page/1');
  const results: any[] = data?.results || [];
  const events: any[] = [];

  for (const item of results.slice(0, 60)) {
    const ticker = String(item?.ticker || '').toUpperCase();
    const symbol = TICKER_SYMBOL_MAP[ticker];
    if (!symbol) continue;

    const mentions = Number(item?.mentions || 0);
    const prev = Number(item?.mentions_24h_ago || 0);
    const upvotes = Number(item?.upvotes || 0);
    const mentionGrowth = prev > 0 ? (mentions - prev) / prev : 0;

    // 언급 급증 = 관심 증가 → 기본 bullish, 급감 = bearish
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

// ── Reddit: 공개 JSON API, 인증 불필요 ──────────────────────────────────────
async function fetchRedditSubreddit(subreddit: string, symbol: string, sourceQuality = 0.40): Promise<any[]> {
  const data = await fetchWithTimeout(`https://www.reddit.com/r/${subreddit}/hot.json?limit=25`);
  const posts: any[] = (data?.data?.children || []).map((c: any) => c?.data).filter(Boolean);

  const keywords = SYMBOL_KEYWORDS[symbol] || [symbol.replace('/USDT', '').toLowerCase()];
  const relevant = posts.filter(p => {
    const title = String(p?.title || '').toLowerCase();
    return keywords.some(kw => title.includes(kw));
  });

  if (relevant.length === 0) return [];

  const avgUpvoteRatio = relevant.reduce((s, p) => s + Number(p?.upvote_ratio || 0.5), 0) / relevant.length;
  const totalScore = relevant.reduce((s, p) => s + Number(p?.score || 0), 0);
  const combinedText = relevant.map(p => p?.title || '').join(' ');
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
      topPosts: relevant.slice(0, 3).map(p => ({ title: p?.title, score: p?.score, upvote_ratio: p?.upvote_ratio })),
    },
  }];
}

async function fetchAllRedditSources(): Promise<any[]> {
  const tasks = [
    fetchRedditSubreddit('CryptoCurrency', 'BTC/USDT', 0.40),
    fetchRedditSubreddit('CryptoCurrency', 'ETH/USDT', 0.40),
    fetchRedditSubreddit('CryptoCurrency', 'SOL/USDT', 0.40),
    fetchRedditSubreddit('Bitcoin', 'BTC/USDT', 0.42),
    fetchRedditSubreddit('ethereum', 'ETH/USDT', 0.42),
    fetchRedditSubreddit('solana', 'SOL/USDT', 0.42),
  ];
  const settled = await Promise.allSettled(tasks);
  return settled.flatMap(r => r.status === 'fulfilled' ? r.value : []);
}

// ── CryptoPanic: API 키 필요 (없으면 스킵) ───────────────────────────────────
async function fetchCryptoPanic(apiKey: string | null): Promise<any[]> {
  if (!apiKey) return [];
  const url = `https://cryptopanic.com/api/v1/posts/?auth_token=${apiKey}&kind=news&filter=hot`;
  const data = await fetchWithTimeout(url);
  const posts: any[] = data?.results || [];
  const symbolMap: Record<string, string> = {
    BTC: 'BTC/USDT', ETH: 'ETH/USDT', SOL: 'SOL/USDT', BNB: 'BNB/USDT', XRP: 'XRP/USDT',
  };
  const events: any[] = [];

  for (const post of posts.slice(0, 30)) {
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

async function getCryptoPanicKey(): Promise<string | null> {
  return process.env.CRYPTOPANIC_API_KEY || null;
}

async function insertAllEvents(events: any[]): Promise<number> {
  let count = 0;
  for (const ev of events) {
    const id = await db.insertExternalEvidence(ev).catch(() => null);
    if (id) count++;
  }
  return count;
}

export async function runCommunityEvidenceRefresh({ json = false } = {}): Promise<any> {
  await db.initSchema();

  const [apeResult, redditResult] = await Promise.allSettled([
    fetchApeWisdom(),
    fetchAllRedditSources(),
  ]);

  const cryptoPanicKey = await getCryptoPanicKey();
  const cryptoPanicEvents = await fetchCryptoPanic(cryptoPanicKey).catch(() => []);

  const allEvents = [
    ...(apeResult.status === 'fulfilled' ? apeResult.value : []),
    ...(redditResult.status === 'fulfilled' ? redditResult.value : []),
    ...cryptoPanicEvents,
  ];

  // hype spike 감지: symbol별 언급 집계
  const mentionsBySymbol: Record<string, number> = {};
  for (const ev of allEvents) {
    if (ev.symbol) mentionsBySymbol[ev.symbol] = (mentionsBySymbol[ev.symbol] || 0) + (ev.rawRef?.mentions || 1);
  }

  const inserted = await insertAllEvents(allEvents);

  const payload = {
    ok: true,
    shadowMode: SHADOW_MODE,
    collected: allEvents.length,
    inserted,
    bySource: {
      apewisdom: apeResult.status === 'fulfilled' ? apeResult.value.length : 0,
      reddit: redditResult.status === 'fulfilled' ? redditResult.value.length : 0,
      cryptopanic: cryptoPanicEvents.length,
    },
    symbols: Object.keys(mentionsBySymbol),
    mentionsBySymbol,
    errors: {
      apewisdom: apeResult.status === 'rejected' ? String(apeResult.reason?.message || apeResult.reason) : null,
      reddit: redditResult.status === 'rejected' ? String(redditResult.reason?.message || redditResult.reason) : null,
    },
  };

  console.log(`[luna-community] 완료: ${inserted}건 저장 (shadow=${SHADOW_MODE})`);
  return json ? payload : JSON.stringify(payload, null, 2);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => runCommunityEvidenceRefresh({ json: process.argv.includes('--json') }),
    onSuccess: async (result) => {
      if (typeof result === 'string') console.log(result);
      else console.log(JSON.stringify(result, null, 2));
    },
    errorPrefix: '❌ runtime-luna-community-evidence-refresh 오류:',
  });
}
