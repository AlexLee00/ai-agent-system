/**
 * team/sophia.js — 소피아 (커뮤니티 감성 분석가)
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
import { fileURLToPath } from 'url';
import * as db from '../shared/db.js';
import { callLLM, parseJSON } from '../shared/llm-client.js';
import { loadSecrets } from '../shared/secrets.js';
import { ANALYST_TYPES, ACTIONS } from '../shared/signal.js';

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
  console.log(`\n💬 [소피아] ${symbol}(${label}) 커뮤니티 수집 중...`);

  let posts;

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

    const [redditResults, dcResults, cpPosts] = await Promise.all([
      Promise.all(subreddits.map(sub => fetchReddit(sub))),
      Promise.all(dcGallIds.map(id => fetchDCinside(id))),
      fetchCryptoPanic(symbol),
    ]);
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

  const postList     = posts.slice(0, 15).map((p, i) => `${i + 1}. [${p.source}] ${p.title}`).join('\n');
  const systemPrompt = PROMPTS[exchange] || PROMPTS.binance;
  const userMsg      = `심볼: ${symbol} (${label})\n커뮤니티 게시물 (${posts.length}건):\n${postList}`;
  const responseText = await callLLM('sophia', systemPrompt, userMsg, 512);
  const parsed       = parseJSON(responseText);

  let signal, confidence, reasoning, sentiment = '중립';
  if (parsed?.action) {
    signal = parsed.action; confidence = parsed.confidence; reasoning = parsed.reasoning; sentiment = parsed.sentiment || '중립';
  } else {
    ({ signal, confidence, reasoning } = keywordFallback(posts, exchange));
  }

  console.log(`  → [소피아] ${signal} (${(confidence * 100).toFixed(0)}%) | ${sentiment}`);
  posts.slice(0, 2).forEach(p => console.log(`  • [${p.source}] ${p.title.slice(0, 60)}`));

  await db.insertAnalysis({
    symbol, analyst: ANALYST_TYPES.SENTIMENT, signal, confidence,
    reasoning: `[감성] ${reasoning}`,
    metadata:  { filteredCount: posts.length, sentiment, exchange,
                 topPosts: posts.slice(0, 5).map(p => `[${p.source}] ${p.title.slice(0, 80)}`) },
    exchange,
  });
  console.log(`  ✅ [소피아] DB 저장 완료`);

  return { symbol, signal, confidence, reasoning, sentiment };
}

// CLI 실행
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args     = process.argv.slice(2);
  const symbol   = args.find(a => a.startsWith('--symbol='))?.split('=')[1]   || 'BTC/USDT';
  const exchange = args.find(a => a.startsWith('--exchange='))?.split('=')[1] || 'binance';

  await db.initSchema();
  try {
    const r = await analyzeSentiment(symbol, exchange);
    console.log('\n결과:', JSON.stringify(r, null, 2));
    process.exit(0);
  } catch (e) {
    console.error('❌ 소피아 오류:', e.message);
    process.exit(1);
  }
}
