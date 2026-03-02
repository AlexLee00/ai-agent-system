'use strict';

/**
 * src/analysts/sentiment-analyst.js — 커뮤니티 감성분석가
 *
 * 수집 소스 (무료, 인증 불필요):
 *   1. Reddit JSON API (r/CryptoCurrency, r/Bitcoin, r/ethereum 등)
 *   2. DCInside 게시판 (비트코인갤, 이더리움갤 — HTML 파싱)
 *
 * LLM: SambaNova Meta-Llama-3.3-70B-Instruct (70B 고성능) → Groq fallback
 *   SambaNova/Groq 키 없으면 키워드 점수 기반 fallback
 *
 * 실행: node src/analysts/sentiment-analyst.js [--symbol=BTC/USDT]
 */

const https  = require('https');
const db     = require('../../lib/db');
const { callGroqAPI }            = require('../../lib/groq');
const { ANALYST_TYPES, ACTIONS } = require('../../lib/signal');

// ─── 데이터 소스 정의 ──────────────────────────────────────────────

// 심볼별 Reddit 서브레딧
const REDDIT_SOURCES = {
  'BTC/USDT': ['Bitcoin', 'CryptoCurrency'],
  'ETH/USDT': ['ethereum', 'CryptoCurrency'],
  'SOL/USDT': ['solana',   'CryptoCurrency'],
  'BNB/USDT': ['binance',  'CryptoCurrency'],
};
const DEFAULT_REDDIT = ['CryptoCurrency'];

// 심볼별 DCInside 갤러리
const DC_SOURCES = {
  'BTC/USDT': ['bitcoingall'],
  'ETH/USDT': ['ethereum'],
  'SOL/USDT': ['solana'],
};

// 심볼별 키워드 (제목 필터링)
const SYMBOL_KEYWORDS = {
  'BTC/USDT': ['bitcoin', 'btc', '비트코인', '비트'],
  'ETH/USDT': ['ethereum', 'eth', '이더리움', '이더'],
  'SOL/USDT': ['solana',   'sol', '솔라나'],
  'BNB/USDT': ['binance',  'bnb', '바이낸스'],
};
const COMMON_KEYWORDS = ['crypto', 'cryptocurrency', '코인', '암호화폐', 'market', 'bull', 'bear', '시장'];

// ─── Reddit JSON API ────────────────────────────────────────────────

function httpsGet(hostname, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname,
      path,
      method:  'GET',
      headers: {
        'User-Agent': 'CryptoSentimentBot/1.0 (Investment Analysis)',
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
    // 게시물 행 추출 (ub-content 클래스)
    const rowRegex = /class="ub-content[^"]*"[\s\S]*?<\/tr>/g;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(body)) !== null) {
      const row = rowMatch[0];
      // 제목 추출 (gall_tit 셀의 첫 <a> 태그 텍스트)
      const titleMatch = /class="gall_tit[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i.exec(row);
      const title = titleMatch?.[1]?.replace(/<[^>]+>/g, '').trim() || '';
      // 추천수 추출 (gall_recommend 셀)
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

// ─── 게시물 필터링 ──────────────────────────────────────────────────

/**
 * 심볼 관련 게시물만 필터링 (최대 15개)
 * Reddit은 upvote 가중치, DCInside는 추천 가중치 적용
 */
function filterAndRank(redditPosts, dcPosts, symbol) {
  const symbolKws = SYMBOL_KEYWORDS[symbol] || [symbol.split('/')[0].toLowerCase()];
  const allKws    = [...symbolKws, ...COMMON_KEYWORDS];

  // Reddit: 심볼 관련 필터 + score 기준 정렬
  const filteredReddit = redditPosts
    .filter(p => allKws.some(kw => p.title.toLowerCase().includes(kw)))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map(p => ({ source: 'reddit', title: p.title, weight: Math.min(p.score / 1000, 3) + 1 }));

  // DCInside: 한국어 키워드만 사용
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

// ─── 키워드 Fallback ────────────────────────────────────────────────

const BULLISH_KWS = ['moon', 'bullish', 'pump', 'ath', 'buy', 'hodl', 'surge', '상승', '매수', '급등', '강세', '불장'];
const BEARISH_KWS = ['crash', 'bearish', 'dump', 'sell', 'fear', 'panic', 'rekt', '하락', '매도', '급락', '약세', '폭락'];

function keywordFallback(posts) {
  let score = 0;
  let totalWeight = 0;
  for (const p of posts) {
    const text = p.title.toLowerCase();
    let postScore = 0;
    BULLISH_KWS.forEach(kw => { if (text.includes(kw)) postScore += 1; });
    BEARISH_KWS.forEach(kw => { if (text.includes(kw)) postScore -= 1; });
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

const SYSTEM_PROMPT = `당신은 암호화폐 커뮤니티 감성분석 전문가입니다.
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

// ─── 메인 분석 ────────────────────────────────────────────────────

/**
 * Reddit + DCInside 커뮤니티 감성 분석 + DB 저장
 * @param {string} symbol ex) 'BTC/USDT'
 */
async function analyzeSentiment(symbol = 'BTC/USDT') {
  console.log(`\n💬 [감성] ${symbol} 커뮤니티 데이터 수집 중...`);

  const subreddits = REDDIT_SOURCES[symbol] || DEFAULT_REDDIT;
  const dcGallIds  = DC_SOURCES[symbol]     || [];

  // 병렬 수집
  const [redditResults, dcResults] = await Promise.all([
    Promise.all(subreddits.map(sub => fetchReddit(sub))),
    Promise.all(dcGallIds.map(id => fetchDCinside(id))),
  ]);

  const allReddit = redditResults.flat();
  const allDC     = dcResults.flat();

  console.log(`  Reddit: ${allReddit.length}건 / DCInside: ${allDC.length}건`);

  // 필터링 + 랭킹
  const posts = filterAndRank(allReddit, allDC, symbol);
  console.log(`  관련 게시물: ${posts.length}건 (Reddit: ${posts.filter(p => p.source === 'reddit').length}, DC: ${posts.filter(p => p.source === 'dcinside').length})`);

  if (posts.length < 3) {
    console.log(`  → 게시물 부족 — HOLD`);
    await db.insertAnalysis({
      symbol,
      analyst:    ANALYST_TYPES.SENTIMENT,
      signal:     ACTIONS.HOLD,
      confidence: 0.1,
      reasoning:  '[감성] 게시물 부족 → HOLD',
      metadata:   { redditCount: allReddit.length, dcCount: allDC.length, filteredCount: posts.length },
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

  const userMsg = `심볼: ${symbol}\n커뮤니티 게시물 (${posts.length}건):\n${postList}`;
  const responseText = await callGroqAPI(SYSTEM_PROMPT, userMsg, 'Meta-Llama-3.3-70B-Instruct', 'sentiment-analyst', 'sambanova');

  if (responseText) {
    try {
      const parsed = JSON.parse(responseText.replace(/```json?\n?|\n?```/g, '').trim());
      signal     = parsed.action;
      confidence = parsed.confidence;
      reasoning  = parsed.reasoning;
      sentiment  = parsed.sentiment || '중립';
    } catch (e) {
      console.warn(`  ⚠️ Groq 응답 파싱 실패 — 키워드 fallback`);
      ({ signal, confidence, reasoning } = keywordFallback(posts));
    }
  } else {
    ({ signal, confidence, reasoning } = keywordFallback(posts));
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
      redditCount:   allReddit.length,
      dcCount:       allDC.length,
      filteredCount: posts.length,
      sentiment,
      topPosts:      posts.slice(0, 5).map(p => `[${p.source}] ${p.title.slice(0, 80)}`),
    },
  });
  console.log(`  ✅ DB 저장 완료`);

  return { symbol, signal, confidence, reasoning, sentiment };
}

// CLI 실행
if (require.main === module) {
  const args   = process.argv.slice(2);
  const symbol = args.find(a => a.startsWith('--symbol='))?.split('=')[1] || 'BTC/USDT';

  analyzeSentiment(symbol)
    .then(() => process.exit(0))
    .catch(e => { console.error('❌ 감성 분석 실패:', e.message); process.exit(1); });
}

module.exports = { analyzeSentiment };
