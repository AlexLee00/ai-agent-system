'use strict';

/**
 * src/analysts/sentiment-analyst.js — 커뮤니티 감성분석가 v2
 *
 * 3시장 분기:
 *   암호화폐: Reddit (r/CryptoCurrency, r/Bitcoin 등) + DCInside (비트코인갤 등)
 *   미국주식:  Reddit (r/stocks, r/investing, r/wallstreetbets) — 심볼 키워드 필터
 *   국내주식:  (내일 구현 예정)
 *
 * LLM: SambaNova Meta-Llama-3.3-70B-Instruct (70B 고성능) → Groq fallback
 *   SambaNova/Groq 키 없으면 키워드 점수 기반 fallback
 *
 * 실행: node src/analysts/sentiment-analyst.js [--symbol=BTC/USDT] [--exchange=binance]
 */

const https  = require('https');
const db     = require('../../lib/db');
const { callGroqAPI }            = require('../../lib/groq');
const { ANALYST_TYPES, ACTIONS } = require('../../lib/signal');

// ─── 데이터 소스 — 암호화폐 ─────────────────────────────────────

const REDDIT_SOURCES_CRYPTO = {
  'BTC/USDT': ['Bitcoin', 'CryptoCurrency'],
  'ETH/USDT': ['ethereum', 'CryptoCurrency'],
  'SOL/USDT': ['solana',   'CryptoCurrency'],
  'BNB/USDT': ['binance',  'CryptoCurrency'],
};
const DEFAULT_REDDIT_CRYPTO = ['CryptoCurrency'];

const DC_SOURCES_CRYPTO = {
  'BTC/USDT': ['bitcoingall'],
  'ETH/USDT': ['ethereum'],
  'SOL/USDT': ['solana'],
};

const SYMBOL_KEYWORDS_CRYPTO = {
  'BTC/USDT': ['bitcoin', 'btc', '비트코인', '비트'],
  'ETH/USDT': ['ethereum', 'eth', '이더리움', '이더'],
  'SOL/USDT': ['solana',   'sol', '솔라나'],
  'BNB/USDT': ['binance',  'bnb', '바이낸스'],
};
const COMMON_KEYWORDS_CRYPTO = ['crypto', 'cryptocurrency', '코인', '암호화폐', 'market', 'bull', 'bear', '시장'];

// ─── 데이터 소스 — 미국 주식 ─────────────────────────────────────

// 미국 주식 기본 서브레딧 (항상 수집)
const DEFAULT_REDDIT_US = ['stocks', 'investing', 'wallstreetbets'];

// 심볼별 추가 서브레딧
const REDDIT_SOURCES_US = {
  'AAPL':  ['apple', 'iphone'],
  'TSLA':  ['teslamotors', 'TeslaInvestorsClub'],
  'NVDA':  ['nvidia'],
  'MSFT':  ['microsoft'],
  'GOOGL': ['google'],
  'AMZN':  ['amazon'],
  'META':  ['facebook'],
};

// 미국 주식 심볼 키워드 (소문자 비교)
const SYMBOL_KEYWORDS_US = {
  'AAPL':  ['apple', 'aapl', '$aapl', 'iphone', 'mac', 'ios'],
  'TSLA':  ['tesla', 'tsla', '$tsla', 'elon', 'cybertruck', 'ev', 'electric'],
  'NVDA':  ['nvidia', 'nvda', '$nvda', 'gpu', 'cuda', 'jensen', 'blackwell'],
  'MSFT':  ['microsoft', 'msft', '$msft', 'azure', 'windows', 'copilot'],
  'GOOGL': ['google', 'alphabet', 'googl', '$googl', 'gemini', 'youtube'],
  'AMZN':  ['amazon', 'amzn', '$amzn', 'aws', 'prime', 'kindle'],
  'META':  ['meta', 'facebook', '$meta', 'instagram', 'whatsapp', 'zuckerberg'],
  'JPM':   ['jpmorgan', 'jpm', '$jpm', 'chase', 'dimon'],
  'BAC':   ['bank of america', 'bac', '$bac', 'bofa'],
};
const COMMON_KEYWORDS_US = ['stock', 'market', 'nasdaq', 'nyse', 'sp500', 'earnings', 'revenue', 'fed', 'rate', 'bull', 'bear', 'rally', 'selloff', 'ipo', 'ai', 'tariff', 'wall street'];

// ─── Reddit JSON API ────────────────────────────────────────────────

function httpsGet(hostname, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname,
      path,
      method:  'GET',
      headers: {
        'User-Agent': 'InvestmentSentimentBot/1.0 (Investment Analysis)',
        ...headers,
      },
    }, (res) => {
      // Reddit: 302 redirect 처리
      if (res.statusCode === 302 || res.statusCode === 301) {
        const loc = res.headers.location;
        if (loc) {
          const u = new URL(loc);
          return httpsGet(u.hostname, u.pathname + u.search, headers)
            .then(resolve).catch(reject);
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

/**
 * Reddit 서브레딧 hot 게시물 수집
 * @returns {{ title, score, numComments, subreddit }[]}
 */
async function fetchReddit(subreddit) {
  try {
    const { status, body } = await httpsGet(
      'www.reddit.com',
      `/r/${subreddit}/hot.json?limit=25`,
    );
    if (status !== 200) return [];

    const data  = JSON.parse(body);
    const posts = data?.data?.children ?? [];
    return posts
      .filter(p => !p.data.stickied)
      .map(p => ({
        title:       p.data.title,
        score:       p.data.score || 0,
        numComments: p.data.num_comments || 0,
        subreddit:   p.data.subreddit,
      }));
  } catch (e) {
    console.warn(`  ⚠️ Reddit r/${subreddit} 수집 실패: ${e.message}`);
    return [];
  }
}

// ─── DCInside HTML 파싱 ─────────────────────────────────────────────

/**
 * DCInside 갤러리 게시물 제목 + 추천수 수집
 * @returns {{ title, recommend }[]}
 */
async function fetchDCinside(gallId) {
  try {
    const { status, body } = await httpsGet(
      'gall.dcinside.com',
      `/board/lists/?id=${gallId}`,
      {
        'Referer':        'https://gall.dcinside.com/',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
    );
    if (status !== 200) return [];

    const posts = [];
    const rowRegex = /class="ub-content[^"]*"[\s\S]*?<\/tr>/g;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(body)) !== null) {
      const row = rowMatch[0];
      const titleMatch = /class="gall_tit[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i.exec(row);
      const title = titleMatch?.[1]?.replace(/<[^>]+>/g, '').trim() || '';
      const recMatch = /class="gall_recommend"[^>]*>([\d]+)<\/td>/i.exec(row);
      const recommend = parseInt(recMatch?.[1] || '0', 10);
      if (title && title.length > 2) posts.push({ title, recommend });
    }
    return posts;
  } catch (e) {
    console.warn(`  ⚠️ DCInside ${gallId} 수집 실패: ${e.message}`);
    return [];
  }
}

// ─── 게시물 필터링 — 암호화폐 ────────────────────────────────────

function filterAndRankCrypto(redditPosts, dcPosts, symbol) {
  const symbolKws = SYMBOL_KEYWORDS_CRYPTO[symbol] || [symbol.split('/')[0].toLowerCase()];
  const allKws    = [...symbolKws, ...COMMON_KEYWORDS_CRYPTO];

  const filteredReddit = redditPosts
    .filter(p => allKws.some(kw => p.title.toLowerCase().includes(kw)))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map(p => ({ source: 'reddit', title: p.title, weight: Math.min(p.score / 1000, 3) + 1 }));

  const krKws = symbolKws.filter(kw => /[가-힣]/.test(kw));
  const filteredDC = dcPosts
    .filter(p => {
      const t = p.title.toLowerCase();
      return allKws.some(kw => t.includes(kw)) ||
             (krKws.length > 0 && krKws.some(kw => p.title.includes(kw)));
    })
    .sort((a, b) => b.recommend - a.recommend)
    .slice(0, 5)
    .map(p => ({ source: 'dcinside', title: p.title, weight: Math.min(p.recommend / 10, 2) + 0.5 }));

  return [...filteredReddit, ...filteredDC];
}

// ─── 게시물 필터링 — 미국 주식 ───────────────────────────────────

function filterAndRankUS(redditPosts, symbol) {
  const symbolKws = SYMBOL_KEYWORDS_US[symbol] || [symbol.toLowerCase(), `$${symbol.toLowerCase()}`];
  const allKws    = [...symbolKws, ...COMMON_KEYWORDS_US];

  return redditPosts
    .filter(p => allKws.some(kw => p.title.toLowerCase().includes(kw)))
    .sort((a, b) => b.score - a.score)
    .slice(0, 15)
    .map(p => ({ source: 'reddit', title: p.title, weight: Math.min(p.score / 1000, 3) + 1 }));
}

// ─── 키워드 Fallback ────────────────────────────────────────────────

const BULLISH_KWS_CRYPTO = ['moon', 'bullish', 'pump', 'ath', 'buy', 'hodl', 'surge', '상승', '매수', '급등', '강세', '불장'];
const BEARISH_KWS_CRYPTO = ['crash', 'bearish', 'dump', 'sell', 'fear', 'panic', 'rekt', '하락', '매도', '급락', '약세', '폭락'];

const BULLISH_KWS_US = ['buy', 'bullish', 'surge', 'beat', 'outperform', 'upgrade', 'moon', 'calls', 'long', 'undervalued', 'dip', 'earnings beat', 'growth'];
const BEARISH_KWS_US = ['sell', 'bearish', 'crash', 'miss', 'downgrade', 'puts', 'short', 'overvalued', 'lawsuit', 'fraud', 'layoff', 'decline', 'earnings miss'];

function keywordFallback(posts, exchange) {
  const bullKws = exchange === 'kis_overseas' ? BULLISH_KWS_US : BULLISH_KWS_CRYPTO;
  const bearKws = exchange === 'kis_overseas' ? BEARISH_KWS_US : BEARISH_KWS_CRYPTO;

  let score = 0;
  let totalWeight = 0;
  for (const p of posts) {
    const text = p.title.toLowerCase();
    let postScore = 0;
    bullKws.forEach(kw => { if (text.includes(kw)) postScore += 1; });
    bearKws.forEach(kw => { if (text.includes(kw)) postScore -= 1; });
    score       += postScore * p.weight;
    totalWeight += p.weight;
  }

  const normalized  = totalWeight > 0 ? score / totalWeight : 0;
  const confidence  = Math.min(Math.abs(normalized) / 2, 0.6);
  const signal      = normalized > 0.3 ? ACTIONS.BUY : normalized < -0.3 ? ACTIONS.SELL : ACTIONS.HOLD;
  const reasoning   = `키워드 감성 (점수: ${normalized.toFixed(2)}, 게시물 ${posts.length}건)`;
  return { signal, confidence, reasoning };
}

// ─── Groq LLM 프롬프트 ─────────────────────────────────────────────

const SYSTEM_PROMPT_CRYPTO = `당신은 암호화폐 커뮤니티 감성분석 전문가입니다.
Reddit/DCInside 커뮤니티 게시물 제목을 분석해 시장 참여자들의 감성을 판단합니다.

응답 형식 (JSON만, 마크다운 없음):
{"action":"BUY"|"SELL"|"HOLD","confidence":0.0~1.0,"reasoning":"근거 1~2문장 (한국어)","sentiment":"극도의 낙관"|"낙관"|"중립"|"비관"|"극도의 비관"}

규칙:
- FOMO(Fear Of Missing Out) → BUY 신호 (과도하면 역설적 SELL)
- FUD(Fear, Uncertainty, Doubt) → SELL 신호 (과도하면 역설적 BUY)
- 극도의 낙관 (모두가 강세) → 역발상 SELL/HOLD 고려
- 극도의 비관 (모두가 약세) → 역발상 BUY 고려
- confidence 0.5 미만이면 반드시 HOLD
- 게시물 수 부족하면 HOLD`;

const SYSTEM_PROMPT_US_STOCK = `당신은 미국 주식 커뮤니티 감성분석 전문가입니다.
Reddit(r/stocks, r/investing, r/wallstreetbets) 게시물 제목을 분석해 해당 종목의 개인투자자 감성을 판단합니다.

응답 형식 (JSON만, 마크다운 없음):
{"action":"BUY"|"SELL"|"HOLD","confidence":0.0~1.0,"reasoning":"근거 1~2문장 (한국어)","sentiment":"극도의 낙관"|"낙관"|"중립"|"비관"|"극도의 비관"}

규칙:
- WSB(wallstreetbets) YOLO 언급 → 역발상 신호로 해석
- 기관투자자 매수/매도 언급 → 참고
- 극도의 낙관(모두가 강세) → 역발상 SELL/HOLD 고려
- 극도의 비관(모두가 약세) → 역발상 BUY 고려
- 어닝 시즌 기대감/실망 반영
- confidence 0.5 미만이면 반드시 HOLD
- 게시물 수 부족하면 HOLD`;

// ─── 메인 분석 ────────────────────────────────────────────────────

/**
 * Reddit + 커뮤니티 감성 분석 + DB 저장
 * @param {string} symbol   ex) 'BTC/USDT' | 'AAPL'
 * @param {string} exchange 'binance' | 'kis_overseas' | 'kis'
 */
async function analyzeSentiment(symbol = 'BTC/USDT', exchange = 'binance') {
  const marketLabel = exchange === 'kis_overseas' ? '미국주식' : exchange === 'kis' ? '국내주식' : '암호화폐';
  console.log(`\n💬 [감성] ${symbol}(${marketLabel}) 커뮤니티 데이터 수집 중...`);

  let posts;

  if (exchange === 'kis_overseas') {
    // ─── 미국 주식 소스 ────────────────────────────────────────
    const subreddits = [
      ...DEFAULT_REDDIT_US,
      ...(REDDIT_SOURCES_US[symbol] || []),
    ];

    const redditResults = await Promise.all(subreddits.map(sub => fetchReddit(sub)));
    const allReddit = redditResults.flat();
    console.log(`  Reddit: ${allReddit.length}건`);

    posts = filterAndRankUS(allReddit, symbol);
    console.log(`  관련 게시물: ${posts.length}건`);

  } else {
    // ─── 암호화폐 소스 ─────────────────────────────────────────
    const subreddits = REDDIT_SOURCES_CRYPTO[symbol] || DEFAULT_REDDIT_CRYPTO;
    const dcGallIds  = DC_SOURCES_CRYPTO[symbol] || [];

    const [redditResults, dcResults] = await Promise.all([
      Promise.all(subreddits.map(sub => fetchReddit(sub))),
      Promise.all(dcGallIds.map(id => fetchDCinside(id))),
    ]);

    const allReddit = redditResults.flat();
    const allDC     = dcResults.flat();
    console.log(`  Reddit: ${allReddit.length}건 / DCInside: ${allDC.length}건`);

    posts = filterAndRankCrypto(allReddit, allDC, symbol);
    console.log(`  관련 게시물: ${posts.length}건 (Reddit: ${posts.filter(p => p.source === 'reddit').length}, DC: ${posts.filter(p => p.source === 'dcinside').length})`);
  }

  if (posts.length < 3) {
    console.log(`  → 게시물 부족 — HOLD`);
    await db.insertAnalysis({
      symbol,
      analyst:    ANALYST_TYPES.SENTIMENT,
      signal:     ACTIONS.HOLD,
      confidence: 0.1,
      reasoning:  '[감성] 게시물 부족 → HOLD',
      metadata:   { filteredCount: posts.length, exchange },
      ...(exchange !== 'binance' && { exchange }),
    });
    return { symbol, signal: ACTIONS.HOLD, confidence: 0.1, reasoning: '게시물 부족' };
  }

  // LLM 또는 fallback
  let signal, confidence, reasoning, sentiment = '중립';

  const postList = posts
    .slice(0, 15)
    .map((p, i) => `${i + 1}. [${p.source === 'reddit' ? 'Reddit' : 'DCInside'}] ${p.title}`)
    .join('\n');

  console.log(`  게시물 샘플:`);
  posts.slice(0, 3).forEach(p => console.log(`    • [${p.source}] ${p.title.slice(0, 60)}`));

  const systemPrompt = exchange === 'kis_overseas' ? SYSTEM_PROMPT_US_STOCK : SYSTEM_PROMPT_CRYPTO;
  const userMsg = `심볼: ${symbol} (${marketLabel})\n커뮤니티 게시물 (${posts.length}건):\n${postList}`;
  const responseText = await callGroqAPI(systemPrompt, userMsg, 'Meta-Llama-3.3-70B-Instruct', 'sentiment-analyst', 'sambanova');

  if (responseText) {
    try {
      const parsed = JSON.parse(responseText.replace(/```json?\n?|\n?```/g, '').trim());
      signal     = parsed.action;
      confidence = parsed.confidence;
      reasoning  = parsed.reasoning;
      sentiment  = parsed.sentiment || '중립';
    } catch (e) {
      console.warn(`  ⚠️ Groq 응답 파싱 실패 — 키워드 fallback`);
      ({ signal, confidence, reasoning } = keywordFallback(posts, exchange));
    }
  } else {
    ({ signal, confidence, reasoning } = keywordFallback(posts, exchange));
  }

  console.log(`  → 신호: ${signal} (확신도 ${(confidence * 100).toFixed(0)}%) | 감성: ${sentiment}`);
  console.log(`  근거: ${reasoning}`);

  await db.insertAnalysis({
    symbol,
    analyst:    ANALYST_TYPES.SENTIMENT,
    signal,
    confidence,
    reasoning:  `[감성] ${reasoning}`,
    metadata:   {
      filteredCount: posts.length,
      sentiment,
      exchange,
      topPosts: posts.slice(0, 5).map(p => `[${p.source}] ${p.title.slice(0, 80)}`),
    },
    ...(exchange !== 'binance' && { exchange }),
  });
  console.log(`  ✅ DB 저장 완료`);

  return { symbol, signal, confidence, reasoning, sentiment };
}

// CLI 실행
if (require.main === module) {
  const args     = process.argv.slice(2);
  const symbol   = args.find(a => a.startsWith('--symbol='))?.split('=')[1]   || 'BTC/USDT';
  const exchange = args.find(a => a.startsWith('--exchange='))?.split('=')[1] || 'binance';

  analyzeSentiment(symbol, exchange)
    .then(() => process.exit(0))
    .catch(e => { console.error('❌ 감성 분석 실패:', e.message); process.exit(1); });
}

module.exports = { analyzeSentiment };
