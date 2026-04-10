// @ts-nocheck
/**
 * team/sophia.js — 소피아 (커뮤니티 감성 분석가)
 * 호환 레이어: sentinel 통합 이후에도 기존 직접 호출 경로를 유지한다.
 *
 * 역할: 커뮤니티 감성 분석 (3시장)
 * LLM: Groq llama-4-scout (PAPER) / Groq llama-4-scout (LIVE, sophia는 Groq 전용)
 *
 * 소스:
 *   암호화폐: Reddit + DCInside + CryptoPanic
 *   미국주식:  Reddit (r/stocks, r/investing, r/wallstreetbets)
 *   국내주식:  네이버 증권 종목토론실
 *
 * 실행: node team/sophia.js --symbol=BTC/USDT --exchange=binance
 */

import https from 'https';
import { execFile } from 'child_process';
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { callLLM, parseJSON } from '../shared/llm-client.ts';
import { loadSecrets } from '../shared/secrets.ts';
import { ANALYST_TYPES, ACTIONS } from '../shared/signal.ts';
import { loadLatestScoutIntel, getScoutSignalForSymbol } from '../shared/scout-intel.ts';

// ─── 소스 설정 ────────────────────────────────────────────────────────

const REDDIT_SOURCES_CRYPTO = {
  'BTC/USDT': ['Bitcoin', 'CryptoCurrency'],
  'ETH/USDT': ['ethereum', 'CryptoCurrency'],
  'SOL/USDT': ['solana',  'CryptoCurrency'],
  'BNB/USDT': ['binance', 'CryptoCurrency'],
};
const DEFAULT_REDDIT_CRYPTO = ['CryptoCurrency'];

const DC_SOURCES_CRYPTO = {
  'BTC/USDT': ['bitcoingall'],
  'ETH/USDT': ['ethereum'],
  'SOL/USDT': ['solana'],
};

const SYMBOL_KEYWORDS_CRYPTO = {
  'BTC/USDT': ['bitcoin', 'btc', '비트코인', '비트'],
  'ETH/USDT': ['ethereum', 'eth', '이더리움'],
  'SOL/USDT': ['solana', 'sol', '솔라나'],
  'BNB/USDT': ['binance', 'bnb', '바이낸스'],
};
const COMMON_KWS_CRYPTO = ['crypto', 'market', 'bull', 'bear', '코인', '암호화폐'];

const DEFAULT_REDDIT_US = ['stocks', 'investing', 'wallstreetbets'];
const REDDIT_SOURCES_US = {
  'AAPL': ['apple'], 'TSLA': ['teslamotors'], 'NVDA': ['nvidia'],
  'MSFT': ['microsoft'], 'GOOGL': ['google'], 'AMZN': ['amazon'], 'META': ['facebook'],
};
const SYMBOL_KEYWORDS_US = {
  'AAPL': ['apple', 'aapl', '$aapl', 'iphone'],
  'TSLA': ['tesla', 'tsla', '$tsla', 'elon', 'ev'],
  'NVDA': ['nvidia', 'nvda', '$nvda', 'gpu', 'jensen'],
  'MSFT': ['microsoft', 'msft', '$msft', 'azure'],
  'GOOGL':['google', 'alphabet', 'googl', 'gemini'],
  'AMZN': ['amazon', 'amzn', '$amzn', 'aws'],
  'META': ['meta', 'facebook', '$meta'],
};
const COMMON_KWS_US = ['stock', 'market', 'nasdaq', 'earnings', 'fed', 'bull', 'bear', 'tariff'];

const NAVER_DISC_NAMES = {
  '005930': '삼성전자',
  '000660': 'SK하이닉스',
};

// ─── 인메모리 캐시 ─────────────────────────────────────────────────────

const _fgCache   = { data: null, ts: 0 };  // Fear & Greed 캐시 (1시간)
const _sentCache = new Map();               // 감성 결과 캐시 (5분, key: `exchange:symbol`)
const FG_TTL     = 3_600_000;
const SENT_TTL   = 300_000;
const SENT_CACHE_MAX = 1000;

function execCurl(args) {
  return new Promise((resolve, reject) => {
    execFile('curl', args, { maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr?.trim() || stdout?.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

function cleanupSentCache(now = Date.now()) {
  for (const [key, value] of _sentCache.entries()) {
    if ((now - value.ts) >= SENT_TTL) _sentCache.delete(key);
  }
  while (_sentCache.size > SENT_CACHE_MAX) {
    const oldestKey = _sentCache.keys().next().value;
    if (!oldestKey) break;
    _sentCache.delete(oldestKey);
  }
}

// ─── Fear & Greed Index (alternative.me) ─────────────────────────────

async function fetchFearGreedIndex() {
  const now = Date.now();
  if (_fgCache.data !== null && (now - _fgCache.ts) < FG_TTL) return _fgCache.data;
  try {
    const { status, body } = await httpsGet('api.alternative.me', '/fng/?limit=1');
    if (status !== 200) return null;
    const json  = JSON.parse(body);
    const value = parseInt(json?.data?.[0]?.value ?? '-1', 10);
    if (isNaN(value) || value < 0 || value > 100) return null;
    _fgCache.data = value;
    _fgCache.ts   = now;
    console.log(`  📊 [소피아] Fear & Greed Index: ${value} (${json?.data?.[0]?.value_classification})`);
    return value;
  } catch (e) {
    if (!['ENOTFOUND', 'EAI_AGAIN'].includes(e?.code)) {
      console.warn(`  ⚠️ [소피아] Fear & Greed 조회 실패: ${e.message}`);
      return null;
    }
    try {
      const raw = await execCurl(['-sS', '-m', '10', 'https://api.alternative.me/fng/?limit=1']);
      const json = JSON.parse(raw);
      const value = parseInt(json?.data?.[0]?.value ?? '-1', 10);
      if (isNaN(value) || value < 0 || value > 100) return null;
      _fgCache.data = value;
      _fgCache.ts = now;
      console.log(`  📊 [소피아] Fear & Greed Index(curl): ${value} (${json?.data?.[0]?.value_classification})`);
      return value;
    } catch (fallbackError) {
      console.warn(`  ⚠️ [소피아] Fear & Greed 조회 실패: ${fallbackError.message}`);
      return null;
    }
  }
}

// ─── 감성 점수 통합 (가중 평균) ───────────────────────────────────────

/**
 * 다중 소스 감성 점수 통합 (소셜은 커뮤니티에 포함)
 * @param {number}      communityScore  -1~1 (LLM/키워드 + Reddit/DC 종합)
 * @param {number|null} fearGreed       0~100 (alternative.me) 또는 null
 * @param {number|null} newsScore       -1~1 (CryptoPanic 뉴스 투표 비율) 또는 null
 * @returns {{ combined: number, fgNorm: number|null, label: string }}
 */
export function combineSentiment(communityScore, fearGreed, newsScore) {
  const fgNorm = fearGreed != null ? (fearGreed - 50) / 50 : null;

  // 소셜(Reddit/DC)은 커뮤니티 점수에 포함 → community 기본비중 0.5 (0.4+0.1)
  let wC = 0.5, wF = fgNorm != null ? 0.3 : 0, wN = newsScore != null ? 0.2 : 0;
  const sum = wC + wF + wN;
  wC /= sum; wF /= sum; wN /= sum;  // 합이 1이 되도록 정규화

  const combined = communityScore * wC
    + (fgNorm   != null ? fgNorm    * wF : 0)
    + (newsScore != null ? newsScore * wN : 0);

  const label = combined >= 0.3 ? '낙관' : combined <= -0.3 ? '비관' : '중립';
  return { combined: Math.max(-1, Math.min(1, combined)), fgNorm, label };
}

// ─── HTTP(S) GET ──────────────────────────────────────────────────────

function httpsGet(hostname, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname,
      path,
      method:  'GET',
      headers: { 'User-Agent': 'SentimentBot/1.0 (Investment)', ...headers },
    }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        const loc = res.headers.location;
        if (loc) {
          try {
            const u = new URL(loc);
            return httpsGet(u.hostname, u.pathname + u.search, headers).then(resolve).catch(reject);
          } catch { /* 무시 */ }
        }
      }
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('타임아웃')); });
    req.end();
  });
}

// ─── Reddit ──────────────────────────────────────────────────────────

async function fetchReddit(subreddit) {
  try {
    const { status, body } = await httpsGet('www.reddit.com', `/r/${subreddit}/hot.json?limit=25`);
    if (status !== 200) return [];
    const data  = JSON.parse(body);
    return (data?.data?.children || [])
      .filter(p => !p.data.stickied)
      .map(p => ({ title: p.data.title, score: p.data.score || 0, subreddit: p.data.subreddit }));
  } catch (e) {
    console.warn(`  ⚠️ [소피아] Reddit r/${subreddit}: ${e.message}`);
    return [];
  }
}

// ─── DCInside ────────────────────────────────────────────────────────

async function fetchDCinside(gallId) {
  try {
    const { status, body } = await httpsGet(
      'gall.dcinside.com', `/board/lists/?id=${gallId}`,
      { 'Referer': 'https://gall.dcinside.com/', 'Accept-Language': 'ko-KR,ko;q=0.9' },
    );
    if (status !== 200) return [];
    const posts = [];
    const re    = /class="ub-content[^"]*"[\s\S]*?<\/tr>/g;
    let m;
    while ((m = re.exec(body)) !== null) {
      const row        = m[0];
      const titleMatch = /class="gall_tit[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i.exec(row);
      const title      = titleMatch?.[1]?.replace(/<[^>]+>/g, '').trim() || '';
      const recMatch   = /class="gall_recommend"[^>]*>([\d]+)<\/td>/i.exec(row);
      const recommend  = parseInt(recMatch?.[1] || '0', 10);
      if (title && title.length > 2) posts.push({ title, recommend });
    }
    return posts;
  } catch (e) {
    console.warn(`  ⚠️ [소피아] DCInside ${gallId}: ${e.message}`);
    return [];
  }
}

// ─── CryptoPanic ─────────────────────────────────────────────────────

async function fetchCryptoPanic(symbol) {
  const s      = loadSecrets();
  const apiKey = s.cryptopanic_api_key;
  if (!apiKey) return [];

  const ticker = symbol.split('/')[0].toLowerCase();
  try {
    const { status, body } = await httpsGet(
      'cryptopanic.com',
      `/api/v1/posts/?auth_token=${apiKey}&currencies=${ticker.toUpperCase()}&filter=hot`,
    );
    if (status !== 200) return [];
    const data = JSON.parse(body);
    return (data?.results || []).slice(0, 10).map(p => ({
      title:  p.title || '',
      score:  (p.votes?.positive || 0) - (p.votes?.negative || 0),
      source: 'cryptopanic',
    }));
  } catch (e) {
    console.warn(`  ⚠️ [소피아] CryptoPanic: ${e.message}`);
    return [];
  }
}

// ─── 네이버 증권 종목토론실 ───────────────────────────────────────────

async function fetchNaverDiscussion(stockCode) {
  try {
    const { status, body } = await httpsGet(
      'finance.naver.com',
      `/item/board.nhn?code=${stockCode}`,
      {
        'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Referer':         'https://finance.naver.com/',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        'Accept':          'text/html,application/xhtml+xml',
      },
    );
    if (status !== 200) return [];

    const posts = [];
    const re = /href="[^"]*board_read\.[^"]*"[^>]*title="([^"]{4,})"/g;
    let m;
    while ((m = re.exec(body)) !== null) {
      const title = m[1]?.trim().replace(/\s+/g, ' ');
      if (title && title.length >= 4) posts.push({ title, source: 'naver_disc', weight: 1 });
    }
    return posts.slice(0, 20);
  } catch (e) {
    console.warn(`  ⚠️ [소피아] 네이버 토론 ${stockCode}: ${e.message}`);
    return [];
  }
}

// ─── 게시물 필터링 ────────────────────────────────────────────────────

function filterAndRankCrypto(redditPosts, dcPosts, cpPosts, symbol) {
  const symbolKws = SYMBOL_KEYWORDS_CRYPTO[symbol] || [symbol.split('/')[0].toLowerCase()];
  const allKws    = [...symbolKws, ...COMMON_KWS_CRYPTO];

  const filteredReddit = redditPosts
    .filter(p => allKws.some(kw => p.title.toLowerCase().includes(kw)))
    .sort((a, b) => b.score - a.score).slice(0, 10)
    .map(p => ({ source: 'reddit', title: p.title, weight: Math.min(p.score / 1000, 3) + 1 }));

  const filteredDC = dcPosts
    .filter(p => allKws.some(kw => p.title.toLowerCase().includes(kw)))
    .sort((a, b) => b.recommend - a.recommend).slice(0, 5)
    .map(p => ({ source: 'dcinside', title: p.title, weight: Math.min(p.recommend / 10, 2) + 0.5 }));

  const filteredCP = cpPosts
    .map(p => ({ source: 'cryptopanic', title: p.title, weight: Math.max(p.score / 10 + 1, 0.5) }));

  return [...filteredReddit, ...filteredDC, ...filteredCP];
}

function filterAndRankUS(redditPosts, symbol) {
  const symbolKws = SYMBOL_KEYWORDS_US[symbol] || [symbol.toLowerCase(), `$${symbol.toLowerCase()}`];
  const allKws    = [...symbolKws, ...COMMON_KWS_US];
  return redditPosts
    .filter(p => allKws.some(kw => p.title.toLowerCase().includes(kw)))
    .sort((a, b) => b.score - a.score).slice(0, 15)
    .map(p => ({ source: 'reddit', title: p.title, weight: Math.min(p.score / 1000, 3) + 1 }));
}

// ─── Keyword Fallback ────────────────────────────────────────────────

const BULL_KWS_CRYPTO = ['moon', 'bullish', 'pump', 'ath', 'buy', 'hodl', '상승', '매수', '급등', '불장'];
const BEAR_KWS_CRYPTO = ['crash', 'bearish', 'dump', 'sell', 'fear', 'rekt', '하락', '매도', '급락', '폭락'];
const BULL_KWS_US     = ['buy', 'bullish', 'surge', 'beat', 'upgrade', 'calls', 'long', 'growth'];
const BEAR_KWS_US     = ['sell', 'bearish', 'crash', 'miss', 'downgrade', 'puts', 'short', 'lawsuit', 'layoff'];
const BULL_KWS_KIS    = ['상승', '매수', '급등', '강세', '목표가', '상향', '호재', '실적', '돌파'];
const BEAR_KWS_KIS    = ['하락', '매도', '급락', '약세', '하향', '악재', '손실', '이탈', '리스크'];

function keywordFallback(posts, exchange) {
  let bullKws, bearKws;
  if (exchange === 'kis_overseas') { bullKws = BULL_KWS_US;     bearKws = BEAR_KWS_US; }
  else if (exchange === 'kis')     { bullKws = BULL_KWS_KIS;    bearKws = BEAR_KWS_KIS; }
  else                              { bullKws = BULL_KWS_CRYPTO; bearKws = BEAR_KWS_CRYPTO; }

  let score = 0, totalWeight = 0;
  for (const p of posts) {
    const text = p.title.toLowerCase();
    let ps = 0;
    bullKws.forEach(kw => { if (text.includes(kw)) ps += 1; });
    bearKws.forEach(kw => { if (text.includes(kw)) ps -= 1; });
    score       += ps * p.weight;
    totalWeight += p.weight;
  }
  const normalized  = totalWeight > 0 ? score / totalWeight : 0;
  const confidence  = Math.min(Math.abs(normalized) / 2, 0.6);
  const signal      = normalized > 0.3 ? ACTIONS.BUY : normalized < -0.3 ? ACTIONS.SELL : ACTIONS.HOLD;
  return { signal, confidence, reasoning: `키워드 감성 (점수: ${normalized.toFixed(2)}, ${posts.length}건)` };
}

// ─── LLM 프롬프트 ────────────────────────────────────────────────────

const PROMPTS = {
  binance: `당신은 암호화폐 커뮤니티 감성분석가입니다. Reddit/DCInside/CryptoPanic 데이터를 분석합니다.
응답 (JSON만): {"action":"BUY"|"SELL"|"HOLD","confidence":0.0~1.0,"reasoning":"근거 (한국어)","sentiment":"극도의 낙관"|"낙관"|"중립"|"비관"|"극도의 비관"}
규칙: FOMO → BUY (과도하면 역설적 SELL). FUD → SELL (과도하면 역설적 BUY). confidence 0.5 미만 → HOLD.`,

  kis_overseas: `당신은 미국 주식 커뮤니티 감성분석가입니다. Reddit r/stocks, r/investing, r/wallstreetbets 분석.
응답 (JSON만): {"action":"BUY"|"SELL"|"HOLD","confidence":0.0~1.0,"reasoning":"근거 (한국어)","sentiment":"극도의 낙관"|"낙관"|"중립"|"비관"|"극도의 비관"}
규칙: WSB YOLO → 역발상. 극도의 낙관 → HOLD/SELL. confidence 0.5 미만 → HOLD.`,

  kis: `당신은 국내주식 커뮤니티 감성분석가입니다. 네이버 증권 종목토론실 게시글을 분석합니다.
응답 (JSON만): {"action":"BUY"|"SELL"|"HOLD","confidence":0.0~1.0,"reasoning":"근거 (한국어)","sentiment":"극도의 낙관"|"낙관"|"중립"|"비관"|"극도의 비관"}
규칙: 근거 없는 급등 기대 → 역발상. 시세조종 의혹 글 무시. 공식 공시/실적 언급 → 비중 높임. confidence 0.5 미만 → HOLD.`,
};

// ─── 메인 분석 ──────────────────────────────────────────────────────

/**
 * 커뮤니티 감성 분석 + DB 저장
 * @param {string} symbol
 * @param {string} exchange  'binance' | 'kis_overseas' | 'kis'
 */
export async function analyzeSentiment(symbol = 'BTC/USDT', exchange = 'binance') {
  const label = exchange === 'kis_overseas' ? '미국주식' : exchange === 'kis' ? '국내주식' : '암호화폐';
  const now = Date.now();
  cleanupSentCache(now);
  const scoutIntel = await loadLatestScoutIntel();
  const scoutSignal = getScoutSignalForSymbol(scoutIntel, symbol);

  // 5분 캐시 확인
  const cacheKey = `${exchange}:${symbol}`;
  const cached   = _sentCache.get(cacheKey);
  if (cached && (now - cached.ts) < SENT_TTL) {
    console.log(`  💾 [소피아] 캐시 히트 (${symbol} ${label})`);
    return cached.data;
  }

  console.log(`\n💬 [소피아] ${symbol}(${label}) 커뮤니티 수집 중...`);

  let posts;
  let cpPostsRef = [];  // CryptoPanic 참조 (binance 전용, 뉴스 감성 계산용)
  let fearGreed  = null;

  if (exchange === 'kis_overseas') {
    const subreddits    = [...DEFAULT_REDDIT_US, ...(REDDIT_SOURCES_US[symbol] || [])];
    const redditResults = await Promise.all(subreddits.map(sub => fetchReddit(sub)));
    const allReddit     = redditResults.flat();
    posts               = filterAndRankUS(allReddit, symbol);
    console.log(`  Reddit: ${allReddit.length}건 → 관련: ${posts.length}건`);

  } else if (exchange === 'kis') {
    const stockName  = NAVER_DISC_NAMES[symbol] || symbol;
    const naverPosts = await fetchNaverDiscussion(symbol);
    console.log(`  네이버 토론 (${stockName}): ${naverPosts.length}건`);
    posts = naverPosts;

  } else {
    const subreddits = REDDIT_SOURCES_CRYPTO[symbol] || DEFAULT_REDDIT_CRYPTO;
    const dcGallIds  = DC_SOURCES_CRYPTO[symbol] || [];

    const [redditResults, dcResults, cpPosts, fg] = await Promise.all([
      Promise.all(subreddits.map(sub => fetchReddit(sub))),
      Promise.all(dcGallIds.map(id => fetchDCinside(id))),
      fetchCryptoPanic(symbol),
      fetchFearGreedIndex(),
    ]);
    cpPostsRef = cpPosts;
    fearGreed  = fg;
    const allReddit = redditResults.flat();
    const allDC     = dcResults.flat();
    console.log(`  Reddit: ${allReddit.length}건 | DC: ${allDC.length}건 | CryptoPanic: ${cpPosts.length}건`);
    posts = filterAndRankCrypto(allReddit, allDC, cpPosts, symbol);
    console.log(`  관련 게시물: ${posts.length}건`);
  }

  if (posts.length < 3) {
    await db.insertAnalysis({ symbol, analyst: ANALYST_TYPES.SENTIMENT, signal: ACTIONS.HOLD,
      confidence: 0.1, reasoning: '[감성] 게시물 부족 → HOLD', metadata: { filteredCount: posts.length, exchange }, exchange });
    return { symbol, signal: ACTIONS.HOLD, confidence: 0.1, reasoning: '게시물 부족' };
  }

  const postList = posts.slice(0, 15).map((p, i) => `${i + 1}. [${p.source}] ${p.title}`).join('\n');
  const systemPrompt = PROMPTS[exchange] || PROMPTS.binance;
  const userMsg = [
    `심볼: ${symbol} (${label})`,
    scoutSignal
      ? `스카우트 힌트: ${scoutSignal.source} / score=${scoutSignal.score} / ${scoutSignal.evidence || scoutSignal.label}`
      : null,
    `커뮤니티 게시물 (${posts.length}건):\n${postList}`,
  ].filter(Boolean).join('\n');
  const responseText = await callLLM('sophia', systemPrompt, userMsg, 300, { symbol });
  const parsed       = parseJSON(responseText);

  let signal, confidence, reasoning, sentiment = '중립';
  if (parsed?.action) {
    signal = parsed.action; confidence = parsed.confidence; reasoning = parsed.reasoning; sentiment = parsed.sentiment || '중립';
  } else {
    ({ signal, confidence, reasoning } = keywordFallback(posts, exchange));
  }

  console.log(`  → [소피아] ${signal} (${(confidence * 100).toFixed(0)}%) | ${sentiment}`);
  posts.slice(0, 2).forEach(p => console.log(`  • [${p.source}] ${p.title.slice(0, 60)}`));

  // 암호화폐: 다중 소스 감성 통합 (커뮤니티 + Fear & Greed + CryptoPanic 뉴스)
  let combinedScore = null;
  if (exchange === 'binance') {
    const communityScore = signal === ACTIONS.BUY ? confidence : signal === ACTIONS.SELL ? -confidence : 0;
    const totalVotes     = cpPostsRef.reduce((s, p) => s + Math.abs(p.score), 0);
    const newsScore      = totalVotes > 0
      ? Math.max(-1, Math.min(1, cpPostsRef.reduce((s, p) => s + p.score, 0) / totalVotes))
      : null;
    const { combined, fgNorm, label: sentLabel } = combineSentiment(communityScore, fearGreed, newsScore);
    combinedScore = combined;
    console.log(`  📊 [소피아] 통합감성: ${combined.toFixed(2)} (커뮤니티: ${communityScore.toFixed(2)}, F&G: ${fgNorm?.toFixed(2) ?? 'N/A'}, 뉴스: ${newsScore?.toFixed(2) ?? 'N/A'}) → ${sentLabel}`);
  }

  await db.insertAnalysis({
    symbol, analyst: ANALYST_TYPES.SENTIMENT, signal, confidence,
    reasoning: `[감성] ${reasoning}`,
    metadata:  { filteredCount: posts.length, sentiment, exchange, combinedScore,
                 scoutSignal: scoutSignal ? {
                   source: scoutSignal.source,
                   score: scoutSignal.score,
                   label: scoutSignal.label,
                 } : null,
                 topPosts: posts.slice(0, 5).map(p => `[${p.source}] ${p.title.slice(0, 80)}`) },
    exchange,
  });
  console.log(`  ✅ [소피아] DB 저장 완료`);

  const result = { symbol, signal, confidence, reasoning, sentiment, combinedScore };
  _sentCache.set(cacheKey, { data: result, ts: now });
  return result;
}

// CLI 실행
if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: () => db.initSchema(),
    run: async () => {
      const args     = process.argv.slice(2);
      const symbol   = args.find(a => a.startsWith('--symbol='))?.split('=')[1]   || 'BTC/USDT';
      const exchange = args.find(a => a.startsWith('--exchange='))?.split('=')[1] || 'binance';
      return analyzeSentiment(symbol, exchange);
    },
    onSuccess: async (result) => {
      console.log('\n결과:', JSON.stringify(result, null, 2));
    },
    errorPrefix: '❌ 소피아 오류:',
  });
}
