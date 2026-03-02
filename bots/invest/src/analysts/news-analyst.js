'use strict';

/**
 * src/analysts/news-analyst.js — 뉴스분석가
 *
 * RSS 크롤링 (인증 불필요):
 *   - CoinDesk:      https://www.coindesk.com/arc/outboundfeeds/rss/
 *   - CoinTelegraph: https://cointelegraph.com/rss
 *
 * LLM: Groq llama-3.1-8b-instant (필수 — 자연어 감성 이해)
 *   Groq API 키 없으면 키워드 점수 기반 fallback
 *
 * 실행: node src/analysts/news-analyst.js [--symbol=BTC/USDT]
 */

const https  = require('https');
const db     = require('../../lib/db');
const { callGroqAPI }         = require('../../lib/groq');
const { ANALYST_TYPES, ACTIONS } = require('../../lib/signal');

// ─── RSS 소스 ─────────────────────────────────────────────────────

const RSS_SOURCES = [
  { name: 'CoinDesk',      hostname: 'www.coindesk.com',      path: '/arc/outboundfeeds/rss/' },
  { name: 'CoinTelegraph', hostname: 'cointelegraph.com',     path: '/rss' },
];

// 심볼별 관련 키워드 (대문자로 비교)
const SYMBOL_KEYWORDS = {
  'BTC/USDT': ['BITCOIN', 'BTC', '비트코인'],
  'ETH/USDT': ['ETHEREUM', 'ETH', '이더리움', 'ETHER'],
  'SOL/USDT': ['SOLANA', 'SOL'],
  'BNB/USDT': ['BINANCE', 'BNB'],
};
const COMMON_KEYWORDS = ['CRYPTO', 'CRYPTOCURRENCY', 'MARKET', 'BULL', 'BEAR', 'SEC', 'FED', 'ETF', 'REGULATION'];

// ─── RSS 파싱 ─────────────────────────────────────────────────────

function httpsGet(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname,
      path,
      method:  'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LunaBot/1.0)' },
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => resolve(raw));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('RSS 타임아웃')); });
    req.end();
  });
}

/**
 * RSS XML에서 기사 목록 파싱
 * @returns {{ title, description, pubDate }[]}
 */
function parseRSS(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title       = (/<title[^>]*><!\[CDATA\[(.*?)\]\]><\/title>/.exec(block) ||
                         /<title[^>]*>(.*?)<\/title>/.exec(block))?.[1]?.trim() || '';
    const description = (/<description[^>]*><!\[CDATA\[(.*?)\]\]><\/description>/.exec(block) ||
                         /<description[^>]*>(.*?)<\/description>/.exec(block))?.[1]
                          ?.replace(/<[^>]+>/g, '').trim() || '';
    const pubDate     = (/<pubDate>(.*?)<\/pubDate>/.exec(block))?.[1]?.trim() || '';
    if (title) items.push({ title, description: description.slice(0, 200), pubDate });
  }
  return items;
}

/**
 * 심볼 관련 기사 필터링
 * @param {object[]} items
 * @param {string} symbol
 * @returns {object[]} 관련 기사 (최대 10개)
 */
function filterRelevant(items, symbol) {
  const symbolKws  = SYMBOL_KEYWORDS[symbol] || [symbol.split('/')[0]];
  const allKws     = [...symbolKws, ...COMMON_KEYWORDS];

  return items
    .filter(item => {
      const text = `${item.title} ${item.description}`.toUpperCase();
      return allKws.some(kw => text.includes(kw));
    })
    .slice(0, 10);
}

// ─── 키워드 기반 fallback (Groq 없을 때) ──────────────────────────

const BULLISH_KWS  = ['SURGE', 'RALLY', 'BULL', 'ATH', 'BREAKOUT', 'ADOPTION', 'APPROVAL', 'ETF', 'INSTITUTIONAL', 'BUY', 'RECOVERY'];
const BEARISH_KWS  = ['CRASH', 'DUMP', 'BEAR', 'HACK', 'SCAM', 'BAN', 'REGULATION', 'LAWSUIT', 'SELL', 'COLLAPSE', 'FEAR'];

function keywordFallback(articles) {
  let score = 0;
  for (const a of articles) {
    const text = `${a.title} ${a.description}`.toUpperCase();
    BULLISH_KWS.forEach(kw => { if (text.includes(kw)) score += 1; });
    BEARISH_KWS.forEach(kw => { if (text.includes(kw)) score -= 1; });
  }

  const maxScore  = articles.length * 2;
  const confidence = maxScore > 0 ? Math.min(Math.abs(score) / maxScore, 0.6) : 0.1;
  const signal     = score > 1 ? ACTIONS.BUY : score < -1 ? ACTIONS.SELL : ACTIONS.HOLD;
  const reasoning  = `키워드 분석 (점수: ${score > 0 ? '+' : ''}${score}, 기사 ${articles.length}건)`;
  return { signal, confidence, reasoning };
}

// ─── Groq LLM 프롬프트 ─────────────────────────────────────────────

const SYSTEM_PROMPT = `당신은 암호화폐 뉴스 감성분석 전문가입니다.
제공된 최신 뉴스 헤드라인을 분석해 해당 암호화폐의 단기(24~48시간) 시장 영향을 판단합니다.

응답 형식 (JSON만, 마크다운 없음):
{"action":"BUY"|"SELL"|"HOLD","confidence":0.0~1.0,"reasoning":"근거 1~2문장 (한국어)","sentiment":"강세"|"약세"|"중립"}

규칙:
- 규제 강화, 해킹, 거래소 파산 → SELL
- ETF 승인, 기관 매입, 긍정적 규제 → BUY
- 혼재된 뉴스 → HOLD
- confidence 0.5 미만이면 반드시 HOLD
- 뉴스가 없거나 관련성 낮으면 HOLD`;

// ─── 메인 분석 ────────────────────────────────────────────────────

/**
 * 뉴스 크롤링 + 감성 분석 + DB 저장
 * @param {string} symbol ex) 'BTC/USDT'
 */
async function analyzeNews(symbol = 'BTC/USDT') {
  console.log(`\n📰 [뉴스] ${symbol} RSS 수집 중...`);

  // 모든 RSS 소스 병렬 수집
  const allItems = [];
  await Promise.all(RSS_SOURCES.map(async ({ name, hostname, path }) => {
    try {
      const xml   = await httpsGet(hostname, path);
      const items = parseRSS(xml);
      console.log(`  ${name}: ${items.length}건 파싱`);
      allItems.push(...items);
    } catch (e) {
      console.warn(`  ⚠️ ${name} 수집 실패: ${e.message}`);
    }
  }));

  // 관련 기사 필터
  const relevant = filterRelevant(allItems, symbol);
  console.log(`  관련 기사: ${relevant.length}건 / 전체 ${allItems.length}건`);

  if (relevant.length === 0) {
    console.log(`  → 관련 뉴스 없음 — HOLD`);
    await db.insertAnalysis({
      symbol,
      analyst:   ANALYST_TYPES.NEWS,
      signal:    ACTIONS.HOLD,
      confidence: 0.1,
      reasoning: '[뉴스] 관련 기사 없음 → HOLD',
      metadata:  { articleCount: 0, sources: RSS_SOURCES.map(s => s.name) },
    });
    return { symbol, signal: ACTIONS.HOLD, confidence: 0.1, reasoning: '관련 뉴스 없음' };
  }

  // 헤드라인 요약 (LLM에 전달)
  const headlines = relevant
    .map((a, i) => `${i + 1}. ${a.title}${a.description ? ` — ${a.description.slice(0, 100)}` : ''}`)
    .join('\n');

  console.log(`  헤드라인 샘플:`);
  relevant.slice(0, 3).forEach(a => console.log(`    • ${a.title}`));

  // Groq LLM 판단 또는 키워드 fallback
  let signal, confidence, reasoning, sentiment = '중립';

  const userMsg = `심볼: ${symbol}\n최신 뉴스 헤드라인 (${relevant.length}건):\n${headlines}`;
  const responseText = await callGroqAPI(SYSTEM_PROMPT, userMsg, 'llama-3.1-8b-instant', 'news-analyst');

  if (responseText) {
    try {
      const parsed = JSON.parse(responseText.replace(/```json?\n?|\n?```/g, '').trim());
      signal     = parsed.action;
      confidence = parsed.confidence;
      reasoning  = parsed.reasoning;
      sentiment  = parsed.sentiment || '중립';
    } catch (e) {
      console.warn(`  ⚠️ Groq 응답 파싱 실패 — 키워드 fallback`);
      ({ signal, confidence, reasoning } = keywordFallback(relevant));
    }
  } else {
    ({ signal, confidence, reasoning } = keywordFallback(relevant));
  }

  console.log(`  → 신호: ${signal} (확신도 ${(confidence * 100).toFixed(0)}%) | 감성: ${sentiment}`);
  console.log(`  근거: ${reasoning}`);

  // DB 저장
  await db.insertAnalysis({
    symbol,
    analyst:   ANALYST_TYPES.NEWS,
    signal,
    confidence,
    reasoning: `[뉴스] ${reasoning}`,
    metadata:  {
      articleCount: relevant.length,
      sentiment,
      headlines: relevant.slice(0, 5).map(a => a.title),
      sources:   RSS_SOURCES.map(s => s.name),
    },
  });
  console.log(`  ✅ DB 저장 완료`);

  return { symbol, signal, confidence, reasoning, sentiment };
}

// CLI 실행
if (require.main === module) {
  const args   = process.argv.slice(2);
  const symbol = args.find(a => a.startsWith('--symbol='))?.split('=')[1] || 'BTC/USDT';

  analyzeNews(symbol)
    .then(() => process.exit(0))
    .catch(e => { console.error('❌ 뉴스 분석 실패:', e.message); process.exit(1); });
}

module.exports = { analyzeNews };
