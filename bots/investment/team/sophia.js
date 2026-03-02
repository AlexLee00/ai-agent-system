'use strict';

/**
 * team/sophia.js — 소피아 (커뮤니티 감성 + xAI X Search)
 *
 * 역할: 커뮤니티 감성 분석 (3시장)
 * LLM: SambaNova 70B → Groq fallback / xAI x_search (30분 주기)
 *
 * 소스:
 *   암호화폐: Reddit + DCInside + alternative.me F&G + CryptoPanic + xAI X (30분)
 *   미국주식:  Reddit + Alpha Vantage (없으면 스킵) + xAI X (30분, 장중)
 *   국내주식:  네이버 증권 종목토론실 (비공식) + DART (없으면 스킵)
 *             → X 검색 스킵 (한국 커뮤니티 비중 높음)
 *
 * xAI 비용 제어:
 *   암호화폐: 30분 1회 → 4심볼 × 48calls/day = $0.96/day
 *   미국주식: 30분 1회, 장중만 → 3심볼 × 13calls = $0.20/day
 *   국내주식: X 검색 스킵
 *
 * bots/invest/src/analysts/sentiment-analyst.js v2 + xAI 통합
 *
 * 실행: node team/sophia.js --symbol=BTC/USDT --exchange=binance
 */

const https = require('https');
const db    = require('../shared/db');
const { callFreeLLM, callXAI, parseJSON } = require('../shared/llm');
const { loadSecrets, isKisOverseasMarketOpen } = require('../shared/secrets');
const { ANALYST_TYPES, ACTIONS } = require('../shared/signal');

// ─── xAI 호출 간격 제어 (30분) ──────────────────────────────────────

const XAI_INTERVAL_MS = 30 * 60 * 1000; // 30분
const _lastXAICall    = {};              // symbol → timestamp

function canCallXAI(symbol) {
  const last = _lastXAICall[symbol] || 0;
  return Date.now() - last >= XAI_INTERVAL_MS;
}

function markXAICall(symbol) {
  _lastXAICall[symbol] = Date.now();
}

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
      const row       = m[0];
      const titleMatch = /class="gall_tit[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i.exec(row);
      const title     = titleMatch?.[1]?.replace(/<[^>]+>/g, '').trim() || '';
      const recMatch  = /class="gall_recommend"[^>]*>([\d]+)<\/td>/i.exec(row);
      const recommend = parseInt(recMatch?.[1] || '0', 10);
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

function keywordFallback(posts, exchange) {
  const bullKws = exchange === 'kis_overseas' ? BULL_KWS_US : BULL_KWS_CRYPTO;
  const bearKws = exchange === 'kis_overseas' ? BEAR_KWS_US : BEAR_KWS_CRYPTO;
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
};

const XAI_PROMPT = `당신은 X(구 Twitter) 시장 감성 분석가입니다.
최신 X 게시물과 트렌드를 분석해 해당 자산에 대한 시장 감성을 판단합니다.
응답 (JSON만): {"action":"BUY"|"SELL"|"HOLD","confidence":0.0~1.0,"reasoning":"X 감성 근거 (한국어)","sentiment":"낙관"|"중립"|"비관"}
규칙: confidence 0.5 미만 → HOLD.`;

// ─── 메인 분석 ──────────────────────────────────────────────────────

/**
 * 커뮤니티 감성 분석 + DB 저장
 * @param {string} symbol
 * @param {string} exchange  'binance' | 'kis_overseas'
 */
async function analyzeSentiment(symbol = 'BTC/USDT', exchange = 'binance') {
  const label = exchange === 'kis_overseas' ? '미국주식' : '암호화폐';
  console.log(`\n💬 [소피아] ${symbol}(${label}) 커뮤니티 수집 중...`);

  let posts;

  if (exchange === 'kis_overseas') {
    const subreddits    = [...DEFAULT_REDDIT_US, ...(REDDIT_SOURCES_US[symbol] || [])];
    const redditResults = await Promise.all(subreddits.map(sub => fetchReddit(sub)));
    const allReddit     = redditResults.flat();
    posts               = filterAndRankUS(allReddit, symbol);
    console.log(`  Reddit: ${allReddit.length}건 → 관련: ${posts.length}건`);
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

  // 기본 감성 분석 (SambaNova → Groq fallback)
  const postList     = posts.slice(0, 15).map((p, i) => `${i + 1}. [${p.source}] ${p.title}`).join('\n');
  const systemPrompt = PROMPTS[exchange] || PROMPTS.binance;
  const userMsg      = `심볼: ${symbol} (${label})\n커뮤니티 게시물 (${posts.length}건):\n${postList}`;
  const responseText = await callFreeLLM(systemPrompt, userMsg, 'Meta-Llama-3.3-70B-Instruct', 'sophia', 'sambanova');
  const parsed       = parseJSON(responseText);

  let signal, confidence, reasoning, sentiment = '중립';
  if (parsed?.action) {
    signal = parsed.action; confidence = parsed.confidence; reasoning = parsed.reasoning; sentiment = parsed.sentiment || '중립';
  } else {
    ({ signal, confidence, reasoning } = keywordFallback(posts, exchange));
  }

  // xAI X Search (30분 주기, 국내주식 스킵)
  let xaiSignal = null;
  if (exchange !== 'kis' && canCallXAI(symbol)) {
    const shouldCallXAI = exchange === 'binance' || (exchange === 'kis_overseas' && isKisOverseasMarketOpen());
    if (shouldCallXAI) {
      const ticker  = exchange === 'binance' ? `$${symbol.split('/')[0]} ${symbol.split('/')[0].toLowerCase()}` : `$${symbol} ${symbol} stock`;
      const xaiMsg  = `최근 ${ticker} 관련 X(Twitter)의 시장 감성을 분석해주세요. 주요 트렌드와 개인투자자 심리를 파악합니다.`;
      const xaiText = await callXAI(XAI_PROMPT, xaiMsg, `sophia-xai-${symbol}`);
      xaiSignal     = parseJSON(xaiText);
      if (xaiSignal?.action) {
        markXAICall(symbol);
        console.log(`  [소피아 xAI] ${xaiSignal.action} (${(xaiSignal.confidence * 100).toFixed(0)}%) | ${xaiSignal.sentiment || ''}`);
        await db.insertAnalysis({ symbol, analyst: ANALYST_TYPES.X_SEARCH,
          signal: xaiSignal.action, confidence: xaiSignal.confidence,
          reasoning: `[X검색] ${xaiSignal.reasoning}`,
          metadata: { sentiment: xaiSignal.sentiment, exchange }, exchange,
        });
      }
    }
  }

  console.log(`  → [소피아] ${signal} (${(confidence * 100).toFixed(0)}%) | ${sentiment}`);
  posts.slice(0, 2).forEach(p => console.log(`  • [${p.source}] ${p.title.slice(0, 60)}`));

  await db.insertAnalysis({
    symbol, analyst: ANALYST_TYPES.SENTIMENT, signal, confidence,
    reasoning: `[감성] ${reasoning}`,
    metadata:  { filteredCount: posts.length, sentiment, exchange,
                 topPosts: posts.slice(0, 5).map(p => `[${p.source}] ${p.title.slice(0, 80)}`),
                 xaiSentiment: xaiSignal?.sentiment },
    exchange,
  });
  console.log(`  ✅ [소피아] DB 저장 완료`);

  return { symbol, signal, confidence, reasoning, sentiment, xaiSignal };
}

// CLI 실행
if (require.main === module) {
  const args     = process.argv.slice(2);
  const symbol   = args.find(a => a.startsWith('--symbol='))?.split('=')[1]   || 'BTC/USDT';
  const exchange = args.find(a => a.startsWith('--exchange='))?.split('=')[1] || 'binance';

  db.initSchema()
    .then(() => analyzeSentiment(symbol, exchange))
    .then(r => { console.log('\n결과:', JSON.stringify(r, null, 2)); process.exit(0); })
    .catch(e => { console.error('❌ 소피아 오류:', e.message); process.exit(1); });
}

module.exports = { analyzeSentiment };
