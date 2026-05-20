// @ts-nocheck

import crypto from 'node:crypto';

export const EDUX_POST_SHADOW_SOURCE_TYPE = 'edux_post_shadow';
export const EDUX_POST_SHADOW_SOURCE_NAME = 'edux_market_post_shadow';

const CATEGORY_MARKET = {
  crypto: 'crypto',
  kis: 'domestic',
  overseas: 'overseas',
};

const MARKET_LABEL = {
  crypto: 'crypto',
  domestic: 'domestic',
  overseas: 'overseas',
};

const CRYPTO_FALLBACK_SYMBOLS = [
  { keyword: /\bBTC\b|bitcoin|비트코인/i, symbol: 'BTC/USDT' },
  { keyword: /\bETH\b|ethereum|이더리움/i, symbol: 'ETH/USDT' },
  { keyword: /\bSOL\b|solana|솔라나/i, symbol: 'SOL/USDT' },
];

const OVERSEAS_TICKERS = [
  'NVDA', 'MSFT', 'AAPL', 'AMZN', 'META', 'GOOGL', 'GOOG', 'TSLA',
  'AMD', 'AVGO', 'NFLX', 'SPY', 'QQQ', 'XLK', 'XLE',
];

function clamp(value, min = 0, max = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

export function normalizeEduxCategory(category = '') {
  const normalized = String(category || '').trim().toLowerCase();
  return CATEGORY_MARKET[normalized] ? normalized : null;
}

export function marketFromEduxCategory(category = '') {
  const normalized = normalizeEduxCategory(category);
  return normalized ? CATEGORY_MARKET[normalized] : null;
}

export function normalizeEduxText(value = '') {
  return String(value || '')
    .replace(/^#\s+.+$/m, '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

export function fingerprintEduxPost(post = {}) {
  const stable = [
    post.id,
    post.postId,
    post.contentHash,
    post.category,
    post.slot,
    post.title,
    post.generatedAt,
    post.createdAt,
  ].filter(Boolean).join('|');
  const fallback = `${post.title || ''}|${post.content || ''}`.slice(0, 500);
  return crypto.createHash('sha256').update(stable || fallback).digest('hex').slice(0, 24);
}

export function inferEduxSymbols(post = {}) {
  const category = normalizeEduxCategory(post.category);
  const text = `${post.title || ''}\n${post.content || ''}`;
  const symbols = [];

  if (category === 'crypto') {
    const pairs = text.match(/\b[A-Z0-9]{2,12}\/(?:USDT|USD|KRW)\b/g) || [];
    symbols.push(...pairs.map((item) => item.toUpperCase()));
    for (const item of CRYPTO_FALLBACK_SYMBOLS) {
      if (item.keyword.test(text)) symbols.push(item.symbol);
    }
  } else if (category === 'overseas') {
    const upper = text.toUpperCase();
    for (const ticker of OVERSEAS_TICKERS) {
      if (new RegExp(`(^|[^A-Z0-9])${ticker}([^A-Z0-9]|$)`).test(upper)) symbols.push(ticker);
    }
  }

  return unique(symbols).slice(0, 5);
}

function extractBulletsAfterHeading(content = '', headingPattern) {
  const lines = normalizeEduxText(content).split('\n');
  const start = lines.findIndex((line) => headingPattern.test(line.trim()));
  if (start < 0) return [];
  const bullets = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^(?:⚡|📌|📈|🌐|👀|💎|🤖|⚠️?|#)/u.test(trimmed)) break;
    if (/^[-•]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
      bullets.push(trimmed.replace(/^[-•]\s+/, '').replace(/^\d+\.\s+/, ''));
    }
    if (bullets.length >= 3) break;
  }
  return bullets;
}

export function summarizeEduxPostForLuna(post = {}) {
  const title = String(post.title || '').trim();
  const content = normalizeEduxText(post.content || '');
  const quick = extractBulletsAfterHeading(content, /핵심\s*3줄|핵심/i);
  const ai = extractBulletsAfterHeading(content, /인공지능\s*추천|추천안/i);
  const parts = [
    title ? `title=${title}` : null,
    quick[0] ? `quick=${quick[0]}` : null,
    quick[1] ? `context=${quick[1]}` : null,
    ai[0] ? `ai_note=${ai[0]}` : null,
  ].filter(Boolean);
  return parts.join(' | ').slice(0, 480) || 'Edu-X market post shadow context';
}

export function buildEduxPostEvidenceRecords(posts = [], options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const maxSymbolsPerPost = Math.max(1, Number(options.maxSymbolsPerPost || 3));
  const records = [];

  for (const post of posts || []) {
    const category = normalizeEduxCategory(post.category);
    const market = marketFromEduxCategory(category);
    if (!category || !market) continue;

    const symbols = inferEduxSymbols(post).slice(0, maxSymbolsPerPost);
    const createdAt = new Date(post.publishedAt || post.generatedAt || post.createdAt || now);
    const ageHours = Number.isFinite(createdAt.getTime())
      ? Math.max(0, (now.getTime() - createdAt.getTime()) / 36e5)
      : 0;
    const freshnessScore = clamp(Math.exp(-ageHours / 48), 0.05, 1);
    const fingerprint = fingerprintEduxPost(post);
    const evidenceSummary = summarizeEduxPostForLuna(post);
    const baseRawRef = {
      shadowOnly: true,
      liveMutation: false,
      decisionAuthority: 'none',
      tradingDecisionPriority: 'context_only',
      sourcePipeline: 'edu-x',
      eduxFingerprint: fingerprint,
      eduxCategory: category,
      eduxSlot: post.slot || null,
      eduxStatus: post.status || (post.dryRun ? 'dry_run' : null),
      eduxPostId: post.postId || post.id || null,
      eduxSymbols: symbols,
      marketLabel: MARKET_LABEL[market] || market,
    };

    const targets = market === 'crypto' && symbols.length > 0 ? symbols : [null];
    for (const symbol of targets.slice(0, maxSymbolsPerPost)) {
      records.push({
        sourceType: EDUX_POST_SHADOW_SOURCE_TYPE,
        sourceName: EDUX_POST_SHADOW_SOURCE_NAME,
        sourceUrl: post.postUrl || null,
        symbol,
        market,
        strategyFamily: 'community_briefing_context',
        signalDirection: 'neutral',
        score: 0,
        sourceQuality: 0.2,
        freshnessScore: Number(freshnessScore.toFixed(4)),
        evidenceSummary,
        rawRef: {
          ...baseRawRef,
          evidenceSymbol: symbol,
        },
      });
    }
  }

  return records;
}

export function summarizeEduxEvidenceRecords(records = []) {
  const byMarket = {};
  const symbols = [];
  for (const record of records || []) {
    const market = record.market || 'unknown';
    byMarket[market] = (byMarket[market] || 0) + 1;
    if (record.symbol) symbols.push(record.symbol);
  }
  return {
    total: records.length,
    byMarket,
    symbols: unique(symbols).sort(),
    sourceType: EDUX_POST_SHADOW_SOURCE_TYPE,
    shadowOnly: true,
    liveMutation: false,
  };
}

export default {
  EDUX_POST_SHADOW_SOURCE_TYPE,
  EDUX_POST_SHADOW_SOURCE_NAME,
  normalizeEduxCategory,
  marketFromEduxCategory,
  normalizeEduxText,
  fingerprintEduxPost,
  inferEduxSymbols,
  summarizeEduxPostForLuna,
  buildEduxPostEvidenceRecords,
  summarizeEduxEvidenceRecords,
};
