// @ts-nocheck
/**
 * shared/hub-market-pulse.ts
 *
 * Hub event-lake에서 최근 시장 펄스(체결/호가)를 읽어
 * maintenance collect가 장중 상태를 더 직접 반영하도록 돕는 보조 레이어.
 *
 * 현재 지원:
 *  - KIS domestic / overseas
 *  - Binance (향후 확장용 기본 뼈대)
 */

const HUB_BASE = process.env.HUB_BASE_URL || 'http://localhost:7788';
const HUB_TOKEN = process.env.HUB_AUTH_TOKEN || '';

function toNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toTimestamp(value) {
  if (!value) return null;
  const ts = Date.parse(String(value));
  return Number.isFinite(ts) ? ts : null;
}

function normalizeTopic(metadata = {}, row = {}) {
  return String(
    metadata.topic
      || metadata.event?.topic
      || row.topic
      || '',
  ).trim();
}

function normalizePayload(metadata = {}) {
  if (metadata.payload && typeof metadata.payload === 'object') return metadata.payload;
  if (metadata.data && typeof metadata.data === 'object') return metadata.data;
  if (metadata.body?.payload && typeof metadata.body.payload === 'object') return metadata.body.payload;
  return {};
}

async function searchHubEvents(query, minutes = 120, limit = 30) {
  const url = new URL('/hub/events/search', HUB_BASE);
  url.searchParams.set('q', query);
  url.searchParams.set('minutes', String(Math.max(1, Number(minutes || 0) || 120)));
  url.searchParams.set('limit', String(Math.max(1, Number(limit || 0) || 30)));

  try {
    const res = await fetch(url, {
      headers: HUB_TOKEN ? { Authorization: `Bearer ${HUB_TOKEN}` } : {},
    });
    if (!res.ok) {
      return { ok: false, error: `hub_search_${res.status}`, results: [] };
    }
    const json = await res.json();
    return { ok: true, results: Array.isArray(json?.results) ? json.results : [] };
  } catch (error) {
    return { ok: false, error: error.message || 'hub_search_failed', results: [] };
  }
}

function buildPulseSummary({ exchange, symbol, tickRows = [], quoteRows = [] } = {}) {
  const tickPayloads = tickRows.map((row) => {
    const metadata = row?.metadata || {};
    const payload = normalizePayload(metadata);
    return {
      ...payload,
      _createdAt: row?.created_at || null,
      _topic: normalizeTopic(metadata, row),
    };
  });

  const quotePayloads = quoteRows.map((row) => {
    const metadata = row?.metadata || {};
    const payload = normalizePayload(metadata);
    return {
      ...payload,
      _createdAt: row?.created_at || null,
      _topic: normalizeTopic(metadata, row),
    };
  });

  const latestTick = tickPayloads[0] || null;
  const latestQuote = quotePayloads[0] || null;

  const latestTickPrice = toNumber(latestTick?.price);
  const oldestTickPrice = toNumber(tickPayloads.at(-1)?.price);
  const tickDeltaPct = (
    latestTickPrice != null
    && oldestTickPrice != null
    && oldestTickPrice > 0
  )
    ? Number((((latestTickPrice - oldestTickPrice) / oldestTickPrice) * 100).toFixed(4))
    : null;

  const askPrice = toNumber(latestQuote?.askPrice);
  const bidPrice = toNumber(latestQuote?.bidPrice);
  const spreadAbs = (
    askPrice != null
    && bidPrice != null
  ) ? Number((askPrice - bidPrice).toFixed(4)) : null;
  const spreadPct = (
    spreadAbs != null
    && bidPrice != null
    && bidPrice > 0
  ) ? Number(((spreadAbs / bidPrice) * 100).toFixed(4)) : null;

  const latestTime = Math.max(
    toTimestamp(latestTick?._createdAt) || 0,
    toTimestamp(latestQuote?._createdAt) || 0,
  );
  const freshnessSeconds = latestTime > 0
    ? Math.max(0, Math.round((Date.now() - latestTime) / 1000))
    : null;

  const tickCount = tickPayloads.length;
  const quoteCount = quotePayloads.length;
  const hasRecentPulse = freshnessSeconds != null && freshnessSeconds <= 180;

  return {
    exchange,
    symbol,
    status: (tickCount > 0 || quoteCount > 0) ? 'ready' : 'empty',
    hasRecentPulse,
    freshnessSeconds,
    tickCount,
    quoteCount,
    lastTradePrice: latestTickPrice,
    lastTradeVolume: toNumber(latestTick?.volume),
    tickDeltaPct,
    askPrice,
    bidPrice,
    spreadAbs,
    spreadPct,
    topicSample: [latestTick?._topic, latestQuote?._topic].filter(Boolean),
  };
}

export async function getRecentHubMarketPulse(symbol, exchange = 'kis', {
  minutes = 120,
  limit = 30,
} = {}) {
  const normalizedSymbol = String(symbol || '').trim();
  const normalizedExchange = String(exchange || '').trim();

  if (!normalizedSymbol) {
    return { status: 'empty', symbol: normalizedSymbol, exchange: normalizedExchange };
  }

  const topicPrefix = normalizedExchange === 'binance'
    ? {
        tick: `luna.binance.trade.${normalizedSymbol}`,
        quote: `luna.binance.orderbook.${normalizedSymbol}`,
      }
    : {
        tick: `luna.kis.tick.${normalizedSymbol}`,
        quote: `luna.kis.quote.${normalizedSymbol}`,
      };

  const [tickSearch, quoteSearch] = await Promise.all([
    searchHubEvents(topicPrefix.tick, minutes, limit),
    searchHubEvents(topicPrefix.quote, minutes, limit),
  ]);

  const filterByMarket = (rows) => rows.filter((row) => {
    const payload = normalizePayload(row?.metadata || {});
    if (!payload?.market) return normalizedExchange === 'binance';
    return String(payload.market).trim() === normalizedExchange;
  });

  const tickRows = filterByMarket(tickSearch.results || []);
  const quoteRows = filterByMarket(quoteSearch.results || []);
  const summary = buildPulseSummary({
    exchange: normalizedExchange,
    symbol: normalizedSymbol,
    tickRows,
    quoteRows,
  });

  if (!tickSearch.ok || !quoteSearch.ok) {
    return {
      ...summary,
      status: summary.status === 'ready' ? 'degraded' : 'empty',
      error: tickSearch.error || quoteSearch.error || null,
    };
  }

  return summary;
}
