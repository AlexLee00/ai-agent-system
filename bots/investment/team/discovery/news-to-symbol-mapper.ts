// @ts-nocheck
import * as db from '../../shared/db.ts';
import { callViaHub } from '../../shared/hub-llm-client.ts';
import { upsertCandidateSignals } from './discovery-store.ts';
import { insertUnmappedNewsEvent } from '../../shared/luna-discovery-entry-store.ts';

const MARKET_DICTIONARY = {
  domestic: [
    { symbol: '005930', keys: ['삼성전자', 'samsung electronics', 'hbm'] },
    { symbol: '000660', keys: ['sk하이닉스', 'hynix'] },
    { symbol: '035420', keys: ['네이버', 'naver'] },
    { symbol: '005380', keys: ['현대차', 'hyundai motor'] },
  ],
  overseas: [
    { symbol: 'AAPL', keys: ['apple', 'iphone', 'ios'] },
    { symbol: 'MSFT', keys: ['microsoft', 'azure'] },
    { symbol: 'NVDA', keys: ['nvidia', 'gpu', 'cuda'] },
    { symbol: 'TSLA', keys: ['tesla', 'robotaxi'] },
    { symbol: 'AMZN', keys: ['amazon', 'aws'] },
    { symbol: 'GOOGL', keys: ['google', 'alphabet', 'gemini'] },
    { symbol: 'META', keys: ['meta', 'facebook', 'instagram'] },
  ],
  crypto: [
    { symbol: 'BTC/USDT', keys: ['bitcoin', 'btc'] },
    { symbol: 'ETH/USDT', keys: ['ethereum', 'eth'] },
    { symbol: 'SOL/USDT', keys: ['solana', 'sol'] },
    { symbol: 'XRP/USDT', keys: ['ripple', 'xrp'] },
    { symbol: 'BNB/USDT', keys: ['binance coin', 'bnb'] },
  ],
};

const EVENT_TYPE_RULES = [
  { type: 'm_a', patterns: ['인수', '합병', 'm&a', 'acquire', 'merger'] },
  { type: 'earnings', patterns: ['실적', '어닝', 'earnings', 'guidance'] },
  { type: 'regulation', patterns: ['규제', '소송', 'lawsuit', 'sec'] },
  { type: 'partnership', patterns: ['파트너십', '제휴', 'partnership'] },
  { type: 'product_launch', patterns: ['출시', 'launch', '신제품'] },
  { type: 'leadership_change', patterns: ['ceo', '사임', '임명'] },
  { type: 'macro', patterns: ['fomc', '금리', 'cpi', 'pce'] },
];

function inferEventType(headline = '') {
  const text = String(headline || '').toLowerCase();
  for (const rule of EVENT_TYPE_RULES) {
    if (rule.patterns.some((pattern) => text.includes(pattern.toLowerCase()))) return rule.type;
  }
  return 'macro';
}

function inferMagnitude(headline = '') {
  const text = String(headline || '').toLowerCase();
  if (text.includes('급등') || text.includes('record') || text.includes('1조') || text.includes('10%')) return 'high';
  if (text.includes('우려') || text.includes('하락') || text.includes('부진')) return 'medium';
  return 'low';
}

function confidenceFromMagnitude(magnitude = 'low') {
  if (magnitude === 'high') return 0.82;
  if (magnitude === 'medium') return 0.72;
  return 0.62;
}

function scoreFromMagnitude(magnitude = 'low') {
  if (magnitude === 'high') return 0.86;
  if (magnitude === 'medium') return 0.76;
  return 0.66;
}

function extractMappedSymbols(headline = '', market = 'crypto') {
  const text = String(headline || '').toLowerCase();
  const dictionary = MARKET_DICTIONARY[market] || [];
  const mapped = [];
  for (const row of dictionary) {
    if (row.keys.some((key) => text.includes(String(key).toLowerCase()))) {
      mapped.push(row.symbol);
    }
  }
  return mapped;
}

function parseLlmSymbolResponse(text = '') {
  try {
    const clean = String(text || '').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const start = clean.search(/[\[{]/);
    const end = Math.max(clean.lastIndexOf('}'), clean.lastIndexOf(']'));
    if (start < 0 || end < start) return [];
    const parsed = JSON.parse(clean.slice(start, end + 1));
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.symbols) ? parsed.symbols : [];
    return rows
      .map((row) => (typeof row === 'string' ? row : row?.symbol || row?.ticker))
      .map((symbol) => String(symbol || '').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function extractMappedSymbolsWithLlm(headline = '', market = 'crypto') {
  if (process.env.LUNA_NEWS_SYMBOL_MAPPING_LLM_ENABLED !== 'true') return [];
  const prompt = [
    `market=${market}`,
    `headline=${headline}`,
    'Return only tradable tickers likely affected by this news.',
    'Use JSON: {"symbols":["NVDA","005930","BTC/USDT"],"confidence":0.0}',
  ].join('\n');
  const result = await callViaHub(
    'luna',
    'You extract tradable tickers from financial news. Return compact JSON only.',
    prompt,
    {
      maxTokens: 160,
      market,
      urgency: 'normal',
      taskType: 'investment.news.symbol_extraction',
    },
  ).catch(() => null);
  if (!result?.ok) return [];
  return parseLlmSymbolResponse(result.text);
}

export async function collectRecentNewsEvents({
  exchange = 'binance',
  minutes = 120,
  limit = 80,
} = {}) {
  const rows = await db.query(
    `SELECT symbol, exchange, metadata, created_at
       FROM analysis
      WHERE analyst = 'news'
        AND exchange = $1
        AND created_at >= now() - INTERVAL '1 minute' * $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [exchange, Math.max(5, Number(minutes || 120)), Math.max(1, Number(limit || 80))],
  ).catch(() => []);

  const events = [];
  for (const row of rows) {
    const headlines = Array.isArray(row?.metadata?.headlines) ? row.metadata.headlines : [];
    for (const title of headlines.slice(0, 5)) {
      events.push({
        headline: String(title || '').trim(),
        source: 'analysis_news',
        publishedAt: row.created_at || null,
        originSymbol: row.symbol || null,
      });
    }
  }
  return events;
}

export async function mapNewsToSymbols(events = [], market = 'crypto') {
  const mapped = [];
  const unmapped = [];
  for (const event of events) {
    const headline = String(event?.headline || '').trim();
    if (!headline) continue;
    const dictionarySymbols = extractMappedSymbols(headline, market);
    const llmSymbols = dictionarySymbols.length > 0 ? [] : await extractMappedSymbolsWithLlm(headline, market);
    const symbols = Array.from(new Set([...dictionarySymbols, ...llmSymbols]));
    const eventType = inferEventType(headline);
    const magnitude = inferMagnitude(headline);
    const confidence = confidenceFromMagnitude(magnitude);
    const score = scoreFromMagnitude(magnitude);

    if (symbols.length <= 0) {
      unmapped.push({
        headline,
        source: event?.source || null,
        confidence,
        reason: 'symbol_not_matched',
        eventMeta: {
          eventType,
          magnitude,
          originSymbol: event?.originSymbol || null,
          llmAttempted: process.env.LUNA_NEWS_SYMBOL_MAPPING_LLM_ENABLED === 'true',
        },
      });
      continue;
    }

    for (const symbol of symbols) {
      mapped.push({
        symbol,
        market,
        source: 'news_symbol_mapper',
        score,
        confidence,
        reason: `[${eventType}/${magnitude}] ${headline}`.slice(0, 180),
        reasonCode: 'news_symbol_mapping',
        provenance: {
          eventType,
          magnitude,
          source: event?.source || null,
          publishedAt: event?.publishedAt || null,
          extraction: dictionarySymbols.length > 0 ? 'dictionary' : 'hub_llm',
        },
      });
    }
  }

  return { mapped, unmapped };
}

export async function runNewsToSymbolMapping({
  exchange = 'binance',
  market = null,
  events = null,
  ttlHours = 24,
} = {}) {
  const resolvedMarket = market || (exchange === 'kis' ? 'domestic' : exchange === 'kis_overseas' ? 'overseas' : 'crypto');
  const sourceEvents = Array.isArray(events) ? events : await collectRecentNewsEvents({ exchange });
  const mapped = await mapNewsToSymbols(sourceEvents, resolvedMarket);
  const mappedSignals = mapped.mapped.map((item) => ({
    symbol: item.symbol,
    score: item.score,
    confidence: item.confidence,
    reason: item.reason,
    reasonCode: item.reasonCode,
    evidenceRef: item.provenance,
    qualityFlags: ['news_event'],
    raw: { event: item.provenance },
  }));

  if (mappedSignals.length > 0) {
    await upsertCandidateSignals(mappedSignals, resolvedMarket, 'news_symbol_mapper', 1, Math.max(1, Number(ttlHours || 24)));
  }
  if (mapped.unmapped.length > 0) {
    await Promise.allSettled(mapped.unmapped.map((item) => insertUnmappedNewsEvent({
      market: resolvedMarket,
      headline: item.headline,
      source: item.source,
      confidence: item.confidence,
      reason: item.reason,
      eventMeta: item.eventMeta,
    })));
  }

  return {
    market: resolvedMarket,
    mappedCount: mappedSignals.length,
    unmappedCount: mapped.unmapped.length,
    mapped: mapped.mapped,
    unmapped: mapped.unmapped,
  };
}

export default runNewsToSymbolMapping;
