#!/usr/bin/env node
// @ts-nocheck

import { getTossCredentials, initHubSecrets, maskSecret } from '../secrets.ts';

export const TOSS_BASE_URL = 'https://openapi.tossinvest.com';

export const TOSS_CAPABILITY = Object.freeze({
  name: 'toss',
  canTrade: false,
  hasSecuritiesWarning: true,
  hasSandbox: false,
  markets: ['domestic', 'overseas'],
});

const DEFAULT_RETRY_COUNT = 2;
const DEFAULT_TOKEN_REFRESH_MAX_MS = 50 * 60 * 1000;

let warnedMissingCredentials = false;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSymbol(value) {
  return String(value || '').trim().toUpperCase();
}

function marketFromSymbol(symbol) {
  return /^[0-9]{6}$/.test(String(symbol || '')) ? 'domestic' : 'overseas';
}

function ensureCredentials(credentials) {
  if (credentials?.apiKey && credentials?.secretKey) return credentials;
  if (!warnedMissingCredentials) {
    warnedMissingCredentials = true;
    console.warn('[toss-client] 토스 키 미설정 — Hub secrets toss.api_key/secret_key 필요');
  }
  throw new Error('토스 키 미설정');
}

function buildQuery(params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `?${text}` : '';
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function summarizeErrorBody(body) {
  if (!body || typeof body !== 'object') return String(body || '');
  const error = body.error || {};
  return [
    body.code,
    body.message,
    body.error_description,
    error.code,
    error.message,
  ].filter(Boolean).join(' ');
}

function retryAfterMs(response, attempt) {
  const retryAfter = Number(response.headers.get('retry-after') || '');
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  const backoff = 1000 * Math.pow(2, attempt);
  const jitter = Math.floor(Math.random() * 150);
  return backoff + jitter;
}

function normalizeQuote(row = {}) {
  const symbol = normalizeSymbol(row.symbol);
  return {
    provider: 'toss',
    symbol,
    market: marketFromSymbol(symbol),
    price: numberOrNull(row.lastPrice),
    currency: row.currency || null,
    timestamp: row.timestamp || null,
    raw: row,
  };
}

function normalizeBar(row = {}, symbol = '') {
  const normalizedSymbol = normalizeSymbol(symbol);
  return {
    provider: 'toss',
    symbol: normalizedSymbol,
    market: marketFromSymbol(normalizedSymbol),
    timestamp: row.timestamp || null,
    open: numberOrNull(row.openPrice),
    high: numberOrNull(row.highPrice),
    low: numberOrNull(row.lowPrice),
    close: numberOrNull(row.closePrice),
    volume: numberOrNull(row.volume),
    currency: row.currency || null,
    raw: row,
  };
}

function normalizeCalendar(payload = {}, market = '') {
  return {
    provider: 'toss',
    market,
    today: payload.today || null,
    previousBusinessDay: payload.previousBusinessDay || null,
    nextBusinessDay: payload.nextBusinessDay || null,
    raw: payload,
  };
}

function normalizeFxRate(payload = {}) {
  return {
    provider: 'toss',
    baseCurrency: payload.baseCurrency || null,
    quoteCurrency: payload.quoteCurrency || null,
    rate: numberOrNull(payload.rate),
    midRate: numberOrNull(payload.midRate),
    basisPoint: numberOrNull(payload.basisPoint),
    rateChangeType: payload.rateChangeType || null,
    validFrom: payload.validFrom || null,
    validUntil: payload.validUntil || null,
    raw: payload,
  };
}

function normalizeWarning(row = {}, symbol = '') {
  return {
    provider: 'toss',
    symbol: normalizeSymbol(symbol),
    warningType: row.warningType || null,
    exchange: row.exchange || null,
    startDate: row.startDate || null,
    endDate: row.endDate || null,
    raw: row,
  };
}

function normalizeAccount(row = {}) {
  return {
    provider: 'toss',
    accountNo: row.accountNo || '',
    accountSeq: row.accountSeq ?? null,
    accountType: row.accountType || null,
    id: [row.accountNo, row.accountSeq].filter((part) => part !== undefined && part !== null && part !== '').join(':'),
    raw: row,
  };
}

export function createTossClient(options = {}) {
  const baseUrl = options.baseUrl || TOSS_BASE_URL;
  const fetchFn = options.fetchFn || globalThis.fetch;
  const sleepFn = options.sleepFn || delay;
  const nowFn = options.nowFn || (() => Date.now());
  const credentialsProvider = options.credentialsProvider || (async () => {
    await initHubSecrets();
    return getTossCredentials();
  });

  let tokenCache = null;
  let tokenPromise = null;

  async function getCredentials() {
    return ensureCredentials(await credentialsProvider());
  }

  async function requestToken() {
    const credentials = await getCredentials();
    const form = new URLSearchParams();
    form.set('grant_type', 'client_credentials');
    form.set('client_id', credentials.apiKey);
    form.set('client' + '_secret', credentials.secretKey);

    const response = await fetchFn(`${baseUrl}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    const body = await parseJsonResponse(response);
    if (!response.ok) {
      const maskedKey = maskSecret(credentials.apiKey);
      throw new Error(`토스 토큰 발급 실패 status=${response.status} client=${maskedKey} ${summarizeErrorBody(body)}`.trim());
    }

    const token = body?.['access' + '_token'];
    const expiresIn = Number(body?.expires_in || 0);
    if (!token || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new Error('토스 토큰 응답 형식 오류');
    }

    const refreshMs = Math.min(Math.floor(expiresIn * 0.83 * 1000), DEFAULT_TOKEN_REFRESH_MAX_MS);
    tokenCache = {
      token,
      expiresIn,
      refreshAt: nowFn() + refreshMs,
    };
    return { accessToken: token, expiresIn };
  }

  async function getTossToken() {
    if (tokenCache && tokenCache.refreshAt > nowFn()) {
      return { accessToken: tokenCache.token, expiresIn: tokenCache.expiresIn, cached: true };
    }
    if (!tokenPromise) {
      tokenPromise = requestToken().finally(() => {
        tokenPromise = null;
      });
    }
    return tokenPromise;
  }

  async function tossGet(path, params = {}, requestOptions = {}) {
    const token = await getTossToken();
    const url = `${baseUrl}${path}${buildQuery(params)}`;
    const headers = {
      authorization: `Bearer ${token.accessToken}`,
      accept: 'application/json',
    };
    if (requestOptions.account) headers['x-tossinvest-account'] = requestOptions.account;

    for (let attempt = 0; attempt <= DEFAULT_RETRY_COUNT; attempt += 1) {
      const response = await fetchFn(url, { method: 'GET', headers });
      const body = await parseJsonResponse(response);
      if (response.status === 429 && attempt < DEFAULT_RETRY_COUNT) {
        await sleepFn(retryAfterMs(response, attempt));
        continue;
      }
      if (!response.ok) {
        throw new Error(`토스 GET 실패 path=${path} status=${response.status} ${summarizeErrorBody(body)}`.trim());
      }
      return body?.result ?? body;
    }
    throw new Error(`토스 GET 실패 path=${path} retry_exhausted`);
  }

  async function getPrice(symbols) {
    const list = Array.isArray(symbols) ? symbols : [symbols];
    const result = await tossGet('/api/v1/prices', {
      symbols: list.map(normalizeSymbol).filter(Boolean).join(','),
    });
    const quotes = Array.isArray(result) ? result.map(normalizeQuote) : [];
    return Array.isArray(symbols) ? quotes : quotes[0] || null;
  }

  async function getCandles(symbol, interval = '1d', options = {}) {
    const normalizedSymbol = normalizeSymbol(symbol);
    const result = await tossGet('/api/v1/candles', {
      symbol: normalizedSymbol,
      interval,
      count: options.count || options.range || 100,
      before: options.before,
      adjusted: options.adjusted ?? true,
    });
    const candles = Array.isArray(result?.candles)
      ? result.candles.map((row) => normalizeBar(row, normalizedSymbol))
      : [];
    return { provider: 'toss', symbol: normalizedSymbol, interval, candles, nextBefore: result?.nextBefore || null, raw: result };
  }

  async function getMarketCalendar(market = 'domestic', options = {}) {
    const normalized = String(market || '').trim().toLowerCase();
    const isUs = normalized === 'us' || normalized === 'overseas' || normalized === 'usa';
    const result = await tossGet(isUs ? '/api/v1/market-calendar/US' : '/api/v1/market-calendar/KR', {
      date: options.date,
    });
    return normalizeCalendar(result, isUs ? 'overseas' : 'domestic');
  }

  async function getExchangeRate(options = {}) {
    const result = await tossGet('/api/v1/exchange-rate', {
      dateTime: options.dateTime,
      baseCurrency: options.baseCurrency || 'USD',
      quoteCurrency: options.quoteCurrency || 'KRW',
    });
    return normalizeFxRate(result);
  }

  async function getSecuritiesWarning(symbol = '005930') {
    const normalizedSymbol = normalizeSymbol(symbol);
    const result = await tossGet(`/api/v1/stocks/${encodeURIComponent(normalizedSymbol)}/warnings`);
    return Array.isArray(result) ? result.map((row) => normalizeWarning(row, normalizedSymbol)) : [];
  }

  async function getAccounts() {
    const result = await tossGet('/api/v1/accounts');
    return Array.isArray(result) ? result.map(normalizeAccount) : [];
  }

  function resetTokenCache() {
    tokenCache = null;
    tokenPromise = null;
  }

  return {
    capability: TOSS_CAPABILITY,
    getTossToken,
    tossGet,
    getPrice,
    getCandles,
    getMarketCalendar,
    getExchangeRate,
    getSecuritiesWarning,
    getAccounts,
    resetTokenCache,
  };
}

const defaultClient = createTossClient();

export const tossCapability = TOSS_CAPABILITY;
export const getTossToken = (...args) => defaultClient.getTossToken(...args);
export const tossGet = (...args) => defaultClient.tossGet(...args);
export const getPrice = (...args) => defaultClient.getPrice(...args);
export const getCandles = (...args) => defaultClient.getCandles(...args);
export const getMarketCalendar = (...args) => defaultClient.getMarketCalendar(...args);
export const getExchangeRate = (...args) => defaultClient.getExchangeRate(...args);
export const getSecuritiesWarning = (...args) => defaultClient.getSecuritiesWarning(...args);
export const getAccounts = (...args) => defaultClient.getAccounts(...args);

export const __test = {
  createTossClient,
};
