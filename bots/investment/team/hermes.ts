// @ts-nocheck
/**
 * team/hermes.js — 헤르메스 (뉴스 분석가)
 * 호환 레이어: sentinel 통합 이후에도 기존 직접 호출 경로를 유지한다.
 *
 * 역할: 3시장 뉴스 수집 + 감성 분류
 * LLM: Groq Scout (paper+live 모두 무료)
 *
 * 소스:
 *   암호화폐: CoinDesk + CoinTelegraph RSS
 *   미국주식:  Yahoo Finance RSS + MarketWatch RSS
 *   국내주식:  네이버 뉴스 검색 API (키 없으면 스킵) + DART 공시
 *
 * 실행: node team/hermes.js --symbol=BTC/USDT --exchange=binance
 */

import https from 'https';
import http  from 'http';
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { callLLM, parseJSON } from '../shared/llm-client.ts';
import { callLLMWithHub } from '../shared/hub-llm-client.ts';
import { loadSecrets }        from '../shared/secrets.ts';
import { ANALYST_TYPES, ACTIONS } from '../shared/signal.ts';
import { loadLatestScoutIntel, getScoutSignalForSymbol } from '../shared/scout-intel.ts';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const kst = _require('../../../packages/core/lib/kst');
const { resolveNaverCredentials } = _require('../../../packages/core/lib/news-credentials.legacy.js');

const _domesticMetaCache = new Map();
let _dartCorpCodeMapPromise = null;
const DOMESTIC_META_TTL = 6 * 3600 * 1000;
const DOMESTIC_META_MAX = 500;

// ─── RSS 소스 ────────────────────────────────────────────────────────

const RSS_CRYPTO = [
  { name: 'CoinDesk',      hostname: 'www.coindesk.com',      path: '/arc/outboundfeeds/rss/' },
  { name: 'CoinTelegraph', hostname: 'cointelegraph.com',     path: '/rss' },
  { name: 'Decrypt',       hostname: 'decrypt.co',            path: '/feed' },
];

const RSS_US_GENERAL = [
  { name: 'MarketWatch',   hostname: 'feeds.marketwatch.com', path: '/marketwatch/topstories/' },
  { name: 'Yahoo Top',     hostname: 'finance.yahoo.com',     path: '/rss/topstories' },
  { name: 'PRNewswire Tech', hostname: 'www.prnewswire.com',  path: '/rss/technology-latest-news/technology-latest-news-list.rss' },
];

function getYahooSymbolRSS(symbol) {
  return { name: `Yahoo(${symbol})`, hostname: 'feeds.finance.yahoo.com', path: `/rss/2.0/headline?s=${symbol}&region=US&lang=en-US` };
}

// ─── 심볼 키워드 ──────────────────────────────────────────────────────

const SYMBOL_KEYWORDS_CRYPTO = {
  'BTC/USDT': ['BITCOIN', 'BTC', '비트코인'],
  'ETH/USDT': ['ETHEREUM', 'ETH', '이더리움'],
  'SOL/USDT': ['SOLANA', 'SOL'],
  'BNB/USDT': ['BINANCE', 'BNB'],
};
const COMMON_KWS_CRYPTO = ['CRYPTO', 'MARKET', 'BULL', 'BEAR', 'SEC', 'FED', 'ETF', 'REGULATION'];

const SYMBOL_KEYWORDS_US = {
  'AAPL': ['APPLE', 'AAPL', '$AAPL', 'IPHONE'],
  'TSLA': ['TESLA', 'TSLA', '$TSLA', 'ELON MUSK'],
  'NVDA': ['NVIDIA', 'NVDA', '$NVDA', 'GPU', 'CUDA'],
  'MSFT': ['MICROSOFT', 'MSFT', '$MSFT', 'AZURE'],
  'GOOGL':['GOOGLE', 'ALPHABET', 'GOOGL'],
  'AMZN': ['AMAZON', 'AMZN', '$AMZN', 'AWS'],
  'META': ['META', 'FACEBOOK', '$META'],
};
const COMMON_KWS_US = ['STOCK', 'NASDAQ', 'NYSE', 'EARNINGS', 'FED', 'RATE', 'BULL', 'BEAR', 'AI', 'TARIFF'];

const SYMBOL_NAME_KR = {
  '005930': '삼성전자', '000660': 'SK하이닉스',
  '035420': 'NAVER',   '051910': 'LG화학',
};

// ─── HTTP(S) GET ──────────────────────────────────────────────────────

function httpsGetRaw(hostname, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const isHttps  = !hostname.startsWith('http://');
    const lib      = isHttps ? https : http;
    const cleanHost = hostname.replace(/^https?:\/\//, '');

    const req = lib.request({
      hostname: cleanHost,
      path,
      method:  'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HermesBot/1.0)', ...headers },
    }, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        try {
          const u = new URL(res.headers.location);
          return httpsGetRaw(u.hostname, u.pathname + u.search, headers).then(resolve).catch(reject);
        } catch { /* 무시 */ }
      }
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('RSS 타임아웃')); });
    req.end();
  });
}

async function fetchDomesticSymbolName(symbol) {
  try {
    const { status, body } = await httpsGetRaw(
      'finance.naver.com',
      `/item/main.naver?code=${symbol}`,
      {
        'User-Agent': 'Mozilla/5.0 (compatible; HermesBot/1.0)',
        'Referer': 'https://finance.naver.com/',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
    );
    if (status !== 200) return null;

    const title = /<title>\s*([^:<]+)\s*[:|-]/i.exec(body)?.[1]?.trim()
      || /<div class="wrap_company">[\s\S]*?<h2[^>]*>\s*([^<]+)\s*</i.exec(body)?.[1]?.trim()
      || '';

    return title || null;
  } catch {
    return null;
  }
}

async function loadDartCorpCodeMap() {
  if (_dartCorpCodeMapPromise) return _dartCorpCodeMapPromise;

  _dartCorpCodeMapPromise = (async () => {
    const s = loadSecrets();
    if (!s.dart_api_key) return new Map();

    try {
      const { status, body } = await httpsGetRaw(
        'engopendart.fss.or.kr',
        `/engapi/corpCode.json?crtfc_key=${s.dart_api_key}`,
      );
      if (status !== 200) return new Map();

      const data = JSON.parse(body);
      const rows = Array.isArray(data?.list) ? data.list : [];
      const map  = new Map();

      for (const row of rows) {
        const stockCode = String(row.stock_code || '').trim();
        if (!stockCode) continue;
        map.set(stockCode, {
          corpCode: String(row.corp_code || '').trim(),
          stockName: String(row.stock_name || row.corp_name || '').trim(),
          corpName: String(row.corp_name || '').trim(),
        });
      }

      return map;
    } catch {
      return new Map();
    }
  })();

  return _dartCorpCodeMapPromise;
}

async function resolveDomesticMeta(symbol) {
  const cached = _domesticMetaCache.get(symbol);
  if (cached && (Date.now() - cached.ts) < DOMESTIC_META_TTL) return cached.value;
  if (cached) _domesticMetaCache.delete(symbol);

  let stockName = SYMBOL_NAME_KR[symbol] || '';
  let corpCode  = '';

  const dartMap = await loadDartCorpCodeMap();
  const dartMeta = dartMap.get(symbol);
  if (dartMeta) {
    stockName ||= dartMeta.stockName || dartMeta.corpName || '';
    corpCode = dartMeta.corpCode || '';
  }

  if (!stockName) {
    stockName = await fetchDomesticSymbolName(symbol) || symbol;
  }

  const meta = { symbol, stockName, corpCode };
  if (_domesticMetaCache.size >= DOMESTIC_META_MAX) {
    const oldestKey = _domesticMetaCache.keys().next().value;
    if (oldestKey) _domesticMetaCache.delete(oldestKey);
  }
  _domesticMetaCache.set(symbol, { value: meta, ts: Date.now() });
  return meta;
}

// ─── RSS 파싱 ────────────────────────────────────────────────────────

function parseRSS(xml) {
  const items = [];
  const re    = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const b     = m[1];
    const title = (/<title[^>]*><!\[CDATA\[(.*?)\]\]><\/title>/.exec(b) ||
                   /<title[^>]*>(.*?)<\/title>/.exec(b))?.[1]?.trim() || '';
    const desc  = (/<description[^>]*><!\[CDATA\[(.*?)\]\]><\/description>/.exec(b) ||
                   /<description[^>]*>(.*?)<\/description>/.exec(b))?.[1]
                    ?.replace(/<[^>]+>/g, '').trim().slice(0, 200) || '';
    if (title) items.push({ title, description: desc });
  }
  return items;
}

function filterRelevant(items, symbol, exchange) {
  const symbolKws = exchange === 'kis_overseas'
    ? (SYMBOL_KEYWORDS_US[symbol] || [symbol])
    : (SYMBOL_KEYWORDS_CRYPTO[symbol] || [symbol.split('/')[0]]);
  const commonKws = exchange === 'kis_overseas' ? COMMON_KWS_US : COMMON_KWS_CRYPTO;

  if (exchange === 'kis_overseas') {
    const strict = items.filter(item => {
      const text = `${item.title} ${item.description}`.toUpperCase();
      return symbolKws.some(kw => text.includes(kw));
    });
    if (strict.length >= 3) return strict.slice(0, 10);

    const fallback = items.filter(item => {
      const text = `${item.title} ${item.description}`.toUpperCase();
      return symbolKws.some(kw => text.includes(kw)) || commonKws.some(kw => text.includes(kw));
    });
    return fallback.slice(0, 10);
  }

  const allKws = [...symbolKws, ...commonKws];
  return items
    .filter(item => {
      const text = `${item.title} ${item.description}`.toUpperCase();
      return allKws.some(kw => text.includes(kw));
    })
    .slice(0, 10);
}

// ─── 네이버 뉴스 검색 API ───────────────────────────────────────────

async function fetchNaverNews(symbol, stockName) {
  const { clientId, clientSecret } = await resolveNaverCredentials();
  if (!clientId || !clientSecret) {
    console.warn(`  ⚠️ [헤르메스] 네이버 API 키 없음 — 국내주식 뉴스 스킵`);
    return [];
  }

  const query = encodeURIComponent(stockName || SYMBOL_NAME_KR[symbol] || symbol);
  const path  = `/v1/search/news.json?query=${query}&display=20&sort=date`;

  try {
    const { status, body } = await httpsGetRaw('openapi.naver.com', path, {
      'X-Naver-Client-Id':     clientId,
      'X-Naver-Client-Secret': clientSecret,
    });
    if (status !== 200) return [];
    const data = JSON.parse(body);
    return (data?.items || []).map(item => ({
      title:       item.title.replace(/<[^>]+>/g, '').trim(),
      description: item.description?.replace(/<[^>]+>/g, '').trim().slice(0, 200) || '',
    }));
  } catch (e) {
    console.warn(`  ⚠️ [헤르메스] 네이버 뉴스 실패 (${symbol}): ${e.message}`);
    return [];
  }
}

// ─── DART 공시 조회 ──────────────────────────────────────────────────

async function fetchDartDisclosures(symbol, corpCode) {
  const s      = loadSecrets();
  const apiKey = s.dart_api_key;
  if (!apiKey) return [];
  if (!corpCode) {
    console.warn(`  ⚠️ [헤르메스] DART corp_code 없음 — 공시 스킵 (${symbol})`);
    return [];
  }

  const today = kst.today().replace(/-/g, '');
  const aWeek = kst.daysAgoStr(7).replace(/-/g, '');
  const path  = `/api/list.json?crtfc_key=${apiKey}&corp_code=${corpCode}&bgn_de=${aWeek}&end_de=${today}&page_count=10`;

  try {
    const { status, body } = await httpsGetRaw('opendart.fss.or.kr', path);
    if (status !== 200) return [];
    const data = JSON.parse(body);
    return (data?.list || []).map(item => ({
      title:       item.report_nm || '',
      description: `${item.corp_name} | ${item.rcept_dt}`,
    }));
  } catch (e) {
    console.warn(`  ⚠️ [헤르메스] DART 조회 실패 (${symbol}): ${e.message}`);
    return [];
  }
}

// ─── 키워드 Fallback ─────────────────────────────────────────────────

const BULL_KWS_CRYPTO = ['SURGE', 'RALLY', 'BULL', 'ATH', 'BREAKOUT', 'ADOPTION', 'APPROVAL', 'ETF', 'INSTITUTIONAL'];
const BEAR_KWS_CRYPTO = ['CRASH', 'DUMP', 'BEAR', 'HACK', 'BAN', 'REGULATION', 'LAWSUIT', 'SELL', 'COLLAPSE'];
const BULL_KWS_US     = ['BEAT', 'SURGE', 'RALLY', 'UPGRADE', 'BUYBACK', 'RECORD', 'GROWTH', 'PROFIT', 'GUIDANCE'];
const BEAR_KWS_US     = ['MISS', 'CRASH', 'LAYOFF', 'DOWNGRADE', 'LAWSUIT', 'INVESTIGATION', 'LOSS', 'WARN', 'CUT'];
const BULL_KWS_KR     = ['상승', '강세', '매수', '급등', '호실적', '증가', '수주', '흑자', '배당'];
const BEAR_KWS_KR     = ['하락', '약세', '매도', '급락', '손실', '감소', '소송', '적자', '리콜'];

function keywordFallback(articles, exchange) {
  const bullKws = exchange === 'kis_overseas' ? BULL_KWS_US : exchange === 'kis' ? BULL_KWS_KR : BULL_KWS_CRYPTO;
  const bearKws = exchange === 'kis_overseas' ? BEAR_KWS_US : exchange === 'kis' ? BEAR_KWS_KR : BEAR_KWS_CRYPTO;
  let score = 0;
  for (const a of articles) {
    const text = `${a.title} ${a.description}`.toUpperCase();
    bullKws.forEach(kw => { if (text.includes(kw)) score += 1; });
    bearKws.forEach(kw => { if (text.includes(kw)) score -= 1; });
  }
  const maxScore   = articles.length * 2 || 1;
  const confidence = Math.min(Math.abs(score) / maxScore, 0.6);
  const signal     = score > 1 ? ACTIONS.BUY : score < -1 ? ACTIONS.SELL : ACTIONS.HOLD;
  return { signal, confidence, reasoning: `키워드 (점수: ${score > 0 ? '+' : ''}${score}, ${articles.length}건)` };
}

// ─── LLM 프롬프트 ─────────────────────────────────────────────────────

const PROMPTS = {
  binance: `당신은 암호화폐 뉴스 감성분석가입니다. 최신 뉴스의 단기(24~48시간) 시장 영향을 판단합니다.
응답 (JSON만): {"action":"BUY"|"SELL"|"HOLD","confidence":0.0~1.0,"reasoning":"근거 (한국어)","sentiment":"강세"|"약세"|"중립"}
규칙: confidence 0.5 미만 → HOLD. 관련 없는 뉴스 → HOLD.`,

  kis_overseas: `당신은 미국 주식 뉴스 감성분석가입니다. 최신 뉴스의 단기(1~3일) 시장 영향을 판단합니다.
응답 (JSON만): {"action":"BUY"|"SELL"|"HOLD","confidence":0.0~1.0,"reasoning":"근거 (한국어)","sentiment":"강세"|"약세"|"중립"}
규칙: 어닝 서프라이즈/신제품 → BUY. 실적 미스/소송 → SELL. confidence 0.5 미만 → HOLD.`,

  kis: `당신은 한국 주식 뉴스 감성분석가입니다. 최신 뉴스와 공시의 단기(1~3일) 시장 영향을 판단합니다.
응답 (JSON만): {"action":"BUY"|"SELL"|"HOLD","confidence":0.0~1.0,"reasoning":"근거 (한국어)","sentiment":"강세"|"약세"|"중립"}
규칙: 호실적/대규모 수주 → BUY. 어닝 쇼크/소송/리콜 → SELL. confidence 0.5 미만 → HOLD.`,
};

// ─── 메인 분석 ─────────────────────────────────────────────────────

export async function analyzeNews(symbol = 'BTC/USDT', exchange = 'binance') {
  const label = exchange === 'kis_overseas' ? '미국주식' : exchange === 'kis' ? '국내주식' : '암호화폐';
  const domesticMeta = exchange === 'kis' ? await resolveDomesticMeta(symbol) : null;
  const displaySymbol = domesticMeta?.stockName ? `${symbol}/${domesticMeta.stockName}` : symbol;
  const scoutIntel = await loadLatestScoutIntel();
  const scoutSignal = getScoutSignalForSymbol(scoutIntel, symbol);
  console.log(`\n📰 [헤르메스] ${displaySymbol}(${label}) 뉴스 수집 중...`);

  let rssSources;
  let extraItems = [];

  if (exchange === 'kis_overseas') {
    rssSources = [getYahooSymbolRSS(symbol), ...RSS_US_GENERAL];
  } else if (exchange === 'kis') {
    rssSources = [];
    extraItems = await Promise.all([
      fetchNaverNews(symbol, domesticMeta?.stockName),
      fetchDartDisclosures(symbol, domesticMeta?.corpCode),
    ]).then(([naver, dart]) => [...naver, ...dart]);
  } else {
    rssSources = RSS_CRYPTO;
  }

  const rssItems = [];
  await Promise.all(rssSources.map(async ({ name, hostname, path }) => {
    try {
      const { body } = await httpsGetRaw(hostname, path);
      const items    = parseRSS(body);
      console.log(`  ${name}: ${items.length}건`);
      rssItems.push(...items);
    } catch (e) {
      console.warn(`  ⚠️ [헤르메스] ${name}: ${e.message}`);
    }
  }));

  const allItems = [...rssItems, ...extraItems];
  const relevant = exchange === 'kis' ? allItems.slice(0, 10) : filterRelevant(allItems, symbol, exchange);
  console.log(`  관련 기사: ${relevant.length}건 / 전체 ${allItems.length}건`);

  if (relevant.length === 0) {
    await db.insertAnalysis({ symbol, analyst: ANALYST_TYPES.NEWS, signal: ACTIONS.HOLD, confidence: 0.1,
      reasoning: '[뉴스] 관련 기사 없음 → HOLD', metadata: { articleCount: 0, exchange }, exchange });
    return { symbol, signal: ACTIONS.HOLD, confidence: 0.1, reasoning: '관련 기사 없음' };
  }

  const headlines = relevant.map((a, i) => `${i + 1}. ${a.title}`).join('\n');
  relevant.slice(0, 3).forEach(a => console.log(`  • ${a.title.slice(0, 70)}`));

  const systemPrompt = PROMPTS[exchange] || PROMPTS.binance;
  const userMsg = [
    `심볼: ${symbol} (${label})`,
    scoutSignal
      ? `스카우트 힌트: ${scoutSignal.source} / score=${scoutSignal.score} / ${scoutSignal.evidence || scoutSignal.label}`
      : null,
    `최신 뉴스 ${relevant.length}건:\n${headlines}`,
  ].filter(Boolean).join('\n');
  const responseText = await callLLMWithHub('hermes', systemPrompt, userMsg, callLLM, 300, { symbol });
  const parsed       = parseJSON(responseText);

  let signal, confidence, reasoning, sentiment = '중립';
  if (parsed?.action) {
    signal = parsed.action; confidence = parsed.confidence; reasoning = parsed.reasoning; sentiment = parsed.sentiment || '중립';
  } else {
    ({ signal, confidence, reasoning } = keywordFallback(relevant, exchange));
  }

  console.log(`  → [헤르메스] ${signal} (${(confidence * 100).toFixed(0)}%) | ${sentiment}`);

  await db.insertAnalysis({
    symbol, analyst: ANALYST_TYPES.NEWS, signal, confidence,
    reasoning: `[뉴스] ${reasoning}`,
    metadata:  { articleCount: relevant.length, sentiment, exchange,
                 scoutSignal: scoutSignal ? {
                   source: scoutSignal.source,
                   score: scoutSignal.score,
                   label: scoutSignal.label,
                 } : null,
                 headlines: relevant.slice(0, 5).map(a => a.title) },
    exchange,
  });
  console.log(`  ✅ [헤르메스] DB 저장 완료`);

  return { symbol, signal, confidence, reasoning, sentiment };
}

// CLI 실행
if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: () => db.initSchema(),
    run: async () => {
      const args     = process.argv.slice(2);
      const symbol   = args.find(a => a.startsWith('--symbol='))?.split('=')[1]   || 'BTC/USDT';
      const exchange = args.find(a => a.startsWith('--exchange='))?.split('=')[1] || 'binance';
      return analyzeNews(symbol, exchange);
    },
    onSuccess: async (result) => {
      console.log('\n결과:', JSON.stringify(result, null, 2));
    },
    errorPrefix: '❌ 헤르메스 오류:',
  });
}
