/**
 * team/argos.js — 아르고스 (외부 전략 수집봇)
 *
 * 역할: Reddit r/algotrading + r/CryptoCurrency 인기 포스트 수집
 *       → LLM 품질 평가 → strategy_pool DB 저장 → 텔레그램 리포트
 * LLM: Groq Scout (무료, 항상)
 * 주기: 6시간 (launchd: ai.investment.argos)
 *
 * 실행: node team/argos.js
 */

import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import https from 'https';
import ccxt from 'ccxt';
import yaml from 'js-yaml';
import * as db from '../shared/db.js';
import { callLLM, parseJSON } from '../shared/llm-client.js';
import { publishToMainBot } from '../shared/mainbot-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── 코어 종목 (항상 포함, 절대 제외 안됨) ──────────────────────────

export const CORE_CRYPTO   = ['BTC/USDT', 'ETH/USDT'];
export const CORE_KIS      = ['005930'];
export const CORE_OVERSEAS = ['AAPL'];

// ─── config.yaml 스크리닝 설정 로드 ─────────────────────────────────

let _screeningCfg = {};
try {
  const cfg = yaml.load(readFileSync(join(__dirname, '..', 'config.yaml'), 'utf8'));
  _screeningCfg = cfg?.screening || {};
} catch { /* config 없으면 기본값 사용 */ }

function _screenCfg(market, key, def) {
  return _screeningCfg?.[market]?.[key] ?? def;
}

const SUBREDDITS = [
  { name: 'algotrading',    market: 'all',    limit: 10 },
  { name: 'CryptoCurrency', market: 'crypto', limit: 8 },
  { name: 'stocks',         market: 'stocks', limit: 6 },
];

const MIN_QUALITY_SCORE = 0.5;  // 이 이상만 DB 저장

// ─── 시스템 프롬프트 ────────────────────────────────────────────────

const ARGOS_SYSTEM = `당신은 아르고스(Argos), 루나팀의 전략 수집봇이다.
Reddit 인기 트레이딩 포스트에서 실제 매매에 활용할 수 있는 전략을 추출하고 평가한다.

평가 기준:
- 구체적인 진입/청산 조건이 있는가? (기본 0~0.4점)
- 리스크 관리 방법이 명시되어 있는가? (+0.2)
- 실거래 적용 가능성이 높은가? (+0.2)
- 최신 시장 상황에 맞는가? (+0.2)

응답 형식 (JSON만, 다른 텍스트 없이):
{
  "strategy_name": "전략 이름 (영어, 30자 이내)",
  "entry_condition": "진입 조건 (한국어, 100자 이내)",
  "exit_condition": "청산 조건 (한국어, 100자 이내)",
  "risk_management": "리스크 관리 (한국어, 80자 이내)",
  "applicable_timeframe": "1h|4h|1d|all",
  "quality_score": 0.0~1.0,
  "summary": "한줄 요약 (한국어, 80자 이내)",
  "applicable_now": true|false
}

전략이 아닌 잡담·뉴스·홍보 포스트이면 quality_score를 0으로 설정.`.trim();

// ─── Reddit 수집 ────────────────────────────────────────────────────

async function fetchRedditPosts(subreddit, limit = 10) {
  const url = `https://www.reddit.com/r/${subreddit}/top.json?limit=${limit}&t=day`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'luna-argos/1.0 (investment bot)' },
      signal:  AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data?.data?.children || [])
      .map(c => c.data)
      .filter(p => p.score >= 20 && !p.stickied);
  } catch (e) {
    console.warn(`  ⚠️ [아르고스] r/${subreddit} 수집 실패: ${e.message}`);
    return [];
  }
}

// ─── LLM 품질 평가 ──────────────────────────────────────────────────

async function evaluatePost(post, market) {
  const userMsg = [
    `제목: ${post.title}`,
    `내용: ${(post.selftext || '').slice(0, 800)}`,
    `좋아요: ${post.score} | 댓글: ${post.num_comments}`,
    ``,
    `이 포스트에서 트레이딩 전략을 추출하고 평가하시오.`,
  ].join('\n');

  const raw    = await callLLM('argos', ARGOS_SYSTEM, userMsg, 300);
  const parsed = parseJSON(raw);
  if (!parsed?.strategy_name) return null;

  return {
    ...parsed,
    market,
    source:     'reddit',
    source_url: `https://reddit.com${post.permalink}`,
  };
}

// ─── 메인 수집 함수 ──────────────────────────────────────────────────

export async function collectStrategies() {
  console.log('\n👁️ [아르고스] 외부 전략 수집 시작');

  let saved     = 0;
  const summary = [];

  for (const { name, market, limit } of SUBREDDITS) {
    console.log(`  📡 r/${name} 수집 중...`);
    const posts = await fetchRedditPosts(name, limit);
    console.log(`  → ${posts.length}개 포스트 (score≥20)`);

    for (const post of posts.slice(0, 5)) {
      try {
        const strategy = await evaluatePost(post, market);
        if (!strategy || strategy.quality_score < MIN_QUALITY_SCORE) continue;

        await db.upsertStrategy(strategy);
        saved++;
        summary.push(`• [${(strategy.quality_score * 10).toFixed(0)}점] ${strategy.strategy_name}: ${strategy.summary}`);
        console.log(`  ✅ 저장: ${strategy.strategy_name} (점수: ${strategy.quality_score.toFixed(2)})`);
      } catch (e) {
        console.warn(`  ⚠️ [아르고스] 평가 실패: ${e.message}`);
      }
    }
  }

  console.log(`\n✅ [아르고스] ${saved}개 전략 저장 완료`);

  if (saved > 0) {
    const msg = [
      `👁️ *아르고스 전략 수집 완료*`,
      `수집: ${saved}개 (품질 ${MIN_QUALITY_SCORE} 이상)`,
      '',
      ...summary.slice(0, 5),
    ].join('\n');
    publishToMainBot({ from_bot: 'luna', event_type: 'report', alert_level: 1, message: msg });
  }

  return saved;
}

export async function recommendStrategy(symbol, exchange = 'binance') {
  const market     = exchange === 'binance' ? 'crypto' : exchange === 'kis' ? 'stocks' : 'all';
  const strategies = await db.getActiveStrategies(market, 3);
  if (strategies.length === 0) return null;
  console.log(`  👁️ [아르고스] ${symbol} 추천 전략: ${strategies[0].strategy_name}`);
  return strategies[0];
}

// ─── 암호화폐 종목 스크리닝 (바이낸스 API) ──────────────────────────

/**
 * 바이낸스 24h 데이터 기반 동적 암호화폐 종목 선정
 * 볼륨 상위 30 필터 + 모멘텀 점수 기반 상위 N개 반환
 * @param {number} [maxDynamic] — 동적 종목 수 (기본: config.yaml 또는 3)
 */
export async function screenCryptoSymbols(maxDynamic) {
  const max = maxDynamic ?? _screenCfg('crypto', 'max_dynamic', 3);
  const minVol = _screenCfg('crypto', 'min_volume_usdt', 1_000_000);
  const exchange = new ccxt.binance({ enableRateLimit: true });

  try {
    const tickers = await exchange.fetchTickers();

    const STABLECOINS = new Set(['USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'FDUSD', 'PYUSD', 'USDP']);
    const coreBase    = new Set(CORE_CRYPTO.map(s => s.split('/')[0]));

    const candidates = Object.entries(tickers)
      .filter(([sym]) => sym.endsWith('/USDT'))
      .filter(([sym]) => {
        const base = sym.split('/')[0];
        if (STABLECOINS.has(base)) return false;
        if (/UP$|DOWN$|BULL$|BEAR$|3[LS]$/.test(base)) return false;  // 레버리지 토큰 제외
        if (coreBase.has(base)) return false;  // 코어 종목 제외
        return true;
      })
      .map(([symbol, t]) => ({
        symbol,
        price:         t.last        || 0,
        volume24h:     t.quoteVolume || 0,
        changePercent: t.percentage  || 0,
        high24h:       t.high        || 0,
        low24h:        t.low         || 0,
      }))
      .filter(t => t.volume24h >= minVol)
      .sort((a, b) => b.volume24h - a.volume24h)
      .slice(0, 30);

    const scored = candidates.map(t => {
      const absChange = Math.abs(t.changePercent);
      const volScore  = Math.log10(Math.max(t.volume24h, 1));
      const dirWeight = t.changePercent >= 0 ? 1.2 : 0.8;
      const momentum  = absChange * volScore * dirWeight;
      const range     = t.high24h - t.low24h;
      const rangePos  = range > 0 ? (t.price - t.low24h) / range : 0.5;
      return {
        ...t,
        momentum:   Math.round(momentum * 100) / 100,
        rangePos:   Math.round(rangePos * 100) / 100,
        finalScore: Math.round((momentum * 0.7 + volScore * 0.3) * 100) / 100,
      };
    });

    const topDynamic     = scored.sort((a, b) => b.finalScore - a.finalScore).slice(0, max);
    const dynamicSymbols = topDynamic.map(t => t.symbol);

    console.log(`[아르고스] 암호화폐 스크리닝: 코어 ${CORE_CRYPTO.join(', ')} + 동적 ${dynamicSymbols.join(', ') || '없음'}`);
    topDynamic.forEach(t =>
      console.log(`  ${t.symbol}: ${t.changePercent > 0 ? '+' : ''}${t.changePercent.toFixed(1)}% | ${(t.volume24h / 1e6).toFixed(0)}M USDT | 점수 ${t.finalScore}`)
    );

    return { core: CORE_CRYPTO, dynamic: dynamicSymbols, all: [...CORE_CRYPTO, ...dynamicSymbols], screening: topDynamic };
  } catch (e) {
    console.warn(`[아르고스] 암호화폐 스크리닝 실패: ${e.message} — 코어 종목만 반환`);
    return { core: CORE_CRYPTO, dynamic: [], all: CORE_CRYPTO, screening: [], error: e.message };
  }
}

// ─── 국내주식 종목 스크리닝 (네이버 증권 거래량 상위) ────────────────

/**
 * 네이버 증권 거래량 상위 종목 → 동적 국내주식 선정
 * @param {number} [maxDynamic] — 동적 종목 수 (기본: config.yaml 또는 2)
 */
export async function screenDomesticSymbols(maxDynamic) {
  const max = maxDynamic ?? _screenCfg('domestic', 'max_dynamic', 2);

  try {
    const data = await new Promise((resolve, reject) => {
      const req = https.get(
        'https://m.stock.naver.com/api/stocks/up?page=1&pageSize=15',
        { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 },
        res => {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('타임아웃')); });
    });

    const stocks = data?.stocks || data?.result?.stocks || [];
    if (!stocks.length) throw new Error('데이터 없음');

    const coreSet    = new Set(CORE_KIS);
    const candidates = stocks
      .filter(s => s.stockCode && !coreSet.has(s.stockCode))
      .slice(0, max)
      .map(s => ({
        symbol:     s.stockCode,
        name:       s.stockName || s.name,
        price:      parseInt(s.closePrice || s.price) || 0,
        changeRate: parseFloat(s.fluctuationsRatio || s.changeRate) || 0,
        volume:     parseInt(s.accumulatedTradingVolume || s.volume) || 0,
      }));

    const dynamicSymbols = candidates.map(c => c.symbol);
    console.log(`[아르고스] 국내주식 스크리닝: 코어 ${CORE_KIS.join(', ')} + 동적 ${dynamicSymbols.join(', ') || '없음'}`);
    candidates.forEach(c =>
      console.log(`  ${c.symbol}(${c.name}): ${c.changeRate > 0 ? '+' : ''}${c.changeRate}%`)
    );

    return { core: CORE_KIS, dynamic: dynamicSymbols, all: [...CORE_KIS, ...dynamicSymbols], screening: candidates };
  } catch (e) {
    console.warn(`[아르고스] 국내주식 스크리닝 실패: ${e.message} — 코어만 반환`);
    return { core: CORE_KIS, dynamic: [], all: CORE_KIS, screening: [], error: e.message };
  }
}

// ─── 해외주식 종목 스크리닝 (Yahoo Finance Trending) ─────────────────

/**
 * Yahoo Finance Trending Tickers → 동적 해외주식 선정
 * @param {number} [maxDynamic] — 동적 종목 수 (기본: config.yaml 또는 2)
 */
export async function screenOverseasSymbols(maxDynamic) {
  const max = maxDynamic ?? _screenCfg('overseas', 'max_dynamic', 2);

  try {
    const data = await new Promise((resolve, reject) => {
      const req = https.get(
        'https://query1.finance.yahoo.com/v1/finance/trending/US?count=20',
        { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 },
        res => {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('타임아웃')); });
    });

    const trending = data?.finance?.result?.[0]?.quotes || [];
    if (!trending.length) throw new Error('데이터 없음');

    const coreSet    = new Set(CORE_OVERSEAS);
    const candidates = trending
      .filter(q => q.symbol && !q.symbol.includes('^') && !q.symbol.includes('='))
      .filter(q => !coreSet.has(q.symbol))
      .slice(0, max)
      .map(q => ({ symbol: q.symbol, name: q.shortName || q.symbol }));

    const dynamicSymbols = candidates.map(c => c.symbol);
    console.log(`[아르고스] 해외주식 스크리닝: 코어 ${CORE_OVERSEAS.join(', ')} + 동적 ${dynamicSymbols.join(', ') || '없음'}`);
    candidates.forEach(c => console.log(`  ${c.symbol}(${c.name})`));

    return { core: CORE_OVERSEAS, dynamic: dynamicSymbols, all: [...CORE_OVERSEAS, ...dynamicSymbols], screening: candidates };
  } catch (e) {
    console.warn(`[아르고스] 해외주식 스크리닝 실패: ${e.message} — 코어만 반환`);
    return { core: CORE_OVERSEAS, dynamic: [], all: CORE_OVERSEAS, screening: [], error: e.message };
  }
}

// ─── 통합 스크리닝 ───────────────────────────────────────────────────

/**
 * 전체 마켓 종목 한 번에 스크리닝
 * @returns {Promise<{ crypto, domestic, overseas, timestamp }>}
 */
export async function screenAllMarkets() {
  if (_screeningCfg?.enabled === false) {
    console.log('[아르고스] 스크리닝 비활성화 — config.yaml screening.enabled=false');
    return {
      crypto:   { core: CORE_CRYPTO,   dynamic: [], all: CORE_CRYPTO,   screening: [] },
      domestic: { core: CORE_KIS,      dynamic: [], all: CORE_KIS,      screening: [] },
      overseas: { core: CORE_OVERSEAS, dynamic: [], all: CORE_OVERSEAS, screening: [] },
      timestamp: new Date().toISOString(),
    };
  }

  console.log('\n🔍 [아르고스] 전체 마켓 종목 스크리닝 시작...\n');

  const [cryptoRes, domesticRes, overseasRes] = await Promise.allSettled([
    screenCryptoSymbols(),
    screenDomesticSymbols(),
    screenOverseasSymbols(),
  ]);

  const result = {
    crypto:    cryptoRes.status   === 'fulfilled' ? cryptoRes.value   : { core: CORE_CRYPTO,   dynamic: [], all: CORE_CRYPTO,   screening: [] },
    domestic:  domesticRes.status === 'fulfilled' ? domesticRes.value : { core: CORE_KIS,      dynamic: [], all: CORE_KIS,      screening: [] },
    overseas:  overseasRes.status === 'fulfilled' ? overseasRes.value : { core: CORE_OVERSEAS, dynamic: [], all: CORE_OVERSEAS, screening: [] },
    timestamp: new Date().toISOString(),
  };

  // DB 스크리닝 이력 저장
  try {
    await db.run(
      `INSERT INTO screening_history (date, market, core_symbols, dynamic_symbols, screening_data)
       VALUES (CURRENT_DATE, $1, $2, $3, $4)`,
      [
        'all',
        JSON.stringify({ crypto: result.crypto.core, domestic: result.domestic.core, overseas: result.overseas.core }),
        JSON.stringify({ crypto: result.crypto.dynamic, domestic: result.domestic.dynamic, overseas: result.overseas.dynamic }),
        JSON.stringify(result),
      ]
    );
  } catch (e) {
    console.warn('[아르고스] 스크리닝 이력 저장 실패:', e.message);
  }

  const totalDynamic = result.crypto.dynamic.length + result.domestic.dynamic.length + result.overseas.dynamic.length;
  console.log(`\n🔍 [아르고스] 스크리닝 완료: 동적 ${totalDynamic}개 종목 선정`);
  console.log(`  암호화폐: ${result.crypto.all.join(', ')}`);
  console.log(`  국내주식: ${result.domestic.all.join(', ')}`);
  console.log(`  해외주식: ${result.overseas.all.join(', ')}\n`);

  return result;
}

// CLI 실행
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await db.initSchema();
  try {
    const count = await collectStrategies();
    console.log(`\n결과: ${count}개 전략`);
    process.exit(0);
  } catch (e) {
    console.error('❌ 아르고스 오류:', e.message);
    process.exit(1);
  }
}
