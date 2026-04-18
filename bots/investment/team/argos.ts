// @ts-nocheck
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

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import https from 'https';
import { execFile } from 'child_process';
import ccxt from 'ccxt';
import yaml from 'js-yaml';
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { callLLM, parseJSON } from '../shared/llm-client.ts';
import { callLLMWithHub } from '../shared/hub-llm-client.ts';
import { publishAlert } from '../shared/alert-publisher.ts';
import { search as searchRag } from '../shared/rag-client.ts';
import { getDomesticRanking, getVolumeRank } from '../shared/kis-client.ts';
import { getKisOverseasSymbols, getKisSymbols, isPaperMode } from '../shared/secrets.ts';
import { loadLatestScoutIntel, boostCandidatesWithScout } from '../shared/scout-intel.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

// ─── 기본 코어 종목 비활성화 ────────────────────────────────────────

export const CORE_CRYPTO   = [];
export const CORE_KIS      = [];
export const CORE_OVERSEAS = [];

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
const RAG_RERANK_LIMIT = 4;
const INTEL_CACHE_TTL = 6 * 3600 * 1000;
const INTEL_CACHE_MAX = 500;
const _candidateIntelCache = new Map();
const EXTERNAL_WARN_TTL = 6 * 3600 * 1000;
const _externalWarnCache = new Map();
const REDDIT_COOLDOWN_TTL_MS = 10 * 60 * 1000;
const _redditCooldownUntil = new Map();

function _num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

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

function _screeningLabel(market) {
  return market === 'crypto' ? '암호화폐' : market === 'domestic' ? '국내주식' : '해외주식';
}

function _isValidBinanceUsdtSymbol(symbol, tickerMap = null) {
  if (typeof symbol !== 'string') return false;
  const normalized = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9]+\/USDT$/.test(normalized)) return false;
  if (normalized.length <= 6) return false;
  return tickerMap ? Boolean(tickerMap[normalized]) : true;
}

function _sanitizeCryptoSymbols(symbols, tickerMap = null, logLabel = null) {
  const seen = new Set();
  const invalid = [];
  const sanitized = [];
  for (const raw of Array.isArray(symbols) ? symbols : []) {
    const symbol = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
    if (!symbol) continue;
    if (!_isValidBinanceUsdtSymbol(symbol, tickerMap)) {
      invalid.push(symbol);
      continue;
    }
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    sanitized.push(symbol);
  }
  if (logLabel && invalid.length > 0) {
    console.warn(`[아르고스] ${logLabel} 비정상 심볼 제외: ${invalid.slice(0, 10).join(', ')}`);
  }
  return sanitized;
}

function _cleanupIntelCache(now = Date.now()) {
  for (const [key, value] of _candidateIntelCache.entries()) {
    if ((now - value.ts) >= INTEL_CACHE_TTL) _candidateIntelCache.delete(key);
  }
  while (_candidateIntelCache.size > INTEL_CACHE_MAX) {
    const oldestKey = _candidateIntelCache.keys().next().value;
    if (!oldestKey) break;
    _candidateIntelCache.delete(oldestKey);
  }
}

function _warnExternalOnce(key, message, ttl = EXTERNAL_WARN_TTL) {
  const now = Date.now();
  const last = _externalWarnCache.get(key) || 0;
  if ((now - last) < ttl) return;
  _externalWarnCache.set(key, now);
  console.warn(message);
}

async function _loadRecentScreeningWeights(market) {
  try {
    const rows = await db.getRecentScreeningDynamicSymbols(market, 5);

    const weights = new Map();
    rows.forEach((row, idx) => {
      const recencyWeight = Math.max(1, 5 - idx);
      const rawSymbols = Array.isArray(row.dynamic_symbols) ? row.dynamic_symbols : [];
      const symbols = market === 'crypto'
        ? _sanitizeCryptoSymbols(rawSymbols)
        : rawSymbols;
      symbols.forEach(sym => weights.set(sym, (weights.get(sym) || 0) + recencyWeight));
    });
    return weights;
  } catch {
    return new Map();
  }
}

async function _applyCandidateIntelligence(candidates, market, max) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];

  _cleanupIntelCache(Date.now());
  const screeningWeights = await _loadRecentScreeningWeights(market);
  const topForRag = candidates.slice(0, Math.min(candidates.length, Math.max(max * 2, RAG_RERANK_LIMIT)));

  await Promise.all(topForRag.map(async (candidate) => {
    candidate.screeningWeight = screeningWeights.get(candidate.symbol) || 0;
    candidate.ragScore = 0;
    const cacheKey = `${market}:${candidate.symbol}`;
    const cached = _candidateIntelCache.get(cacheKey);
    if (cached) {
      candidate.ragScore = cached.ragScore;
    } else {
      try {
        const hits = await searchRag(
          'market_data',
          `${candidate.symbol} ${market} momentum news sentiment`,
          { limit: 2, threshold: 0.72, filter: { symbol: candidate.symbol } },
          { sourceBot: 'argos' },
        );
        candidate.ragScore = hits.reduce((sum, hit) => sum + Number(hit.similarity || 0), 0);
        _candidateIntelCache.set(cacheKey, { ragScore: candidate.ragScore, ts: Date.now() });
      } catch {
        candidate.ragScore = 0;
      }
    }

    const baseScore = Number(candidate.finalScore ?? candidate.changeRate ?? candidate.changePercent ?? candidate.volume ?? 0);
    const liquiditySource = candidate.dollarVolume ?? candidate.volume24h;
    const liquidityBase = Number(
      liquiditySource != null
        ? liquiditySource
        : ((candidate.price || 0) * (candidate.volume || 0))
    );
    const liquidityScore = liquidityBase > 0 ? Math.log10(Math.max(liquidityBase, 1)) : 0;
    const momentumBase = Number(candidate.changeRate ?? candidate.changePercent ?? 0);
    const sourceBonus = Number(candidate.sourceCount || 1) * 0.35;
    const pullbackBonus = _computePullbackScore(momentumBase, market);

    candidate.intelligenceScore = Math.round((
      baseScore
      + candidate.screeningWeight * 0.5
      + candidate.ragScore * 10
      + liquidityScore * 0.35
      + sourceBonus
      + pullbackBonus
    ) * 100) / 100;
  }));

  candidates.forEach((candidate) => {
    if (candidate.intelligenceScore == null) {
      const baseScore = Number(candidate.finalScore ?? candidate.changeRate ?? candidate.changePercent ?? candidate.volume ?? 0);
      const liquiditySource = candidate.dollarVolume ?? candidate.volume24h;
      const liquidityBase = Number(
        liquiditySource != null
          ? liquiditySource
          : ((candidate.price || 0) * (candidate.volume || 0))
      );
      const liquidityScore = liquidityBase > 0 ? Math.log10(Math.max(liquidityBase, 1)) : 0;
      const momentumBase = Number(candidate.changeRate ?? candidate.changePercent ?? 0);
      const sourceBonus = Number(candidate.sourceCount || 1) * 0.35;
      const pullbackBonus = _computePullbackScore(momentumBase, market);
      candidate.screeningWeight = screeningWeights.get(candidate.symbol) || 0;
      candidate.ragScore = 0;
      candidate.intelligenceScore = Math.round((
        baseScore
        + candidate.screeningWeight * 0.5
        + liquidityScore * 0.35
        + sourceBonus
        + pullbackBonus
      ) * 100) / 100;
    }
  });

  const sorted = candidates.sort((a, b) => (b.intelligenceScore || 0) - (a.intelligenceScore || 0));
  const selected = sorted.slice(0, max);

  console.log(`[아르고스] ${_screeningLabel(market)} 후보 우선순위화 완료: ${candidates.length} → ${selected.length}`);
  selected.forEach(c => {
    console.log(`  ${c.symbol}: intel=${(c.intelligenceScore || 0).toFixed(2)} | hist=${c.screeningWeight || 0} | rag=${(c.ragScore || 0).toFixed(2)}`);
  });

  return selected;
}

function _computePullbackScore(changePct, market) {
  const change = Number(changePct || 0);
  if (market === 'crypto') {
    if (change >= 2 && change <= 8) return 1.1;
    if (change > 12 || change < -10) return -0.8;
    return 0;
  }

  if (change >= 1 && change <= 5) return 1.2;
  if (change > 8) return -0.9;
  if (change >= -3 && change < 1) return 0.5;
  if (change < -7) return -0.7;
  return 0;
}

// ─── Fear & Greed Index ─────────────────────────────────────────────

/**
 * Alternative.me 공포탐욕지수 조회 (0=극도의 공포, 100=극도의 탐욕)
 * - 완전 무료, API 키 불필요
 * - 실패 시 50(중립)으로 폴백
 */
export async function fetchFearGreedIndex() {
  try {
    const res = await fetch('https://api.alternative.me/fng/?limit=1', {
      headers: { 'User-Agent': 'luna-argos/1.0' },
      signal:  AbortSignal.timeout(8000),
    });

    if (res.status === 429) {
      console.warn('[아르고스] FNG Rate Limit — 50(중립) 사용');
      return 50;
    }
    if (!res.ok) {
      console.warn(`[아르고스] FNG HTTP ${res.status} — 50(중립) 사용`);
      return 50;
    }

    const data = await res.json();
    const val  = parseInt(data?.data?.[0]?.value ?? '50', 10);
    const cls  = data?.data?.[0]?.value_classification || 'Neutral';
    console.log(`[아르고스] 공포탐욕지수(FNG): ${val} — ${cls}`);
    return val;
  } catch (e) {
    if (e.name !== 'TimeoutError' && e.name !== 'AbortError') {
      try {
        const raw = await execCurl(['-sS', '-m', '10', 'https://api.alternative.me/fng/?limit=1']);
        const data = JSON.parse(raw);
        const val  = parseInt(data?.data?.[0]?.value ?? '50', 10);
        const cls  = data?.data?.[0]?.value_classification || 'Neutral';
        console.log(`[아르고스] 공포탐욕지수(FNG/curl): ${val} — ${cls}`);
        return val;
      } catch (fallbackError) {
        console.warn(`[아르고스] FNG 조회 실패: ${fallbackError.message} — 50(중립) 사용`);
        return 50;
      }
    }
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      console.warn('[아르고스] FNG 타임아웃 — 50(중립) 사용');
    } else {
      console.warn(`[아르고스] FNG 조회 실패: ${e.message} — 50(중립) 사용`);
    }
    return 50;
  }
}

/**
 * FNG 값에 따라 max_dynamic 조절
 * < 25 극도공포: 절반 감소 (리스크 축소)
 * > 75 탐욕:    1.5배 증가 (기회 확대)
 * 25~75:        그대로
 */
function _adjustMaxByFNG(baseMax, fng) {
  if (fng < 25) return Math.max(1, Math.floor(baseMax * 0.5));
  if (fng > 75) return Math.ceil(baseMax * 1.5);
  return baseMax;
}

function _adjustPaperExploration(baseMax, market) {
  if (!isPaperMode()) return baseMax;
  if (market === 'domestic' || market === 'overseas') return Math.max(baseMax + 15, Math.ceil(baseMax * 2));
  if (market === 'crypto') return Math.max(baseMax + 1, Math.ceil(baseMax * 1.15));
  return baseMax;
}

// ─── CoinGecko Trending ─────────────────────────────────────────────

/**
 * CoinGecko 트렌딩 코인 (24h 검색량 상위 7개) — 무료 데모키 사용
 * 키 없어도 동작하되, 키 있으면 더 안정적
 */
async function _fetchCoinGeckoTrending() {
  try {
    const cfg   = _screeningCfg?.coingecko || {};
    const key   = cfg.api_key || '';
    const url   = 'https://api.coingecko.com/api/v3/search/trending'
                + (key ? `?x_cg_demo_api_key=${key}` : '');
    const res = await fetch(url, {
      headers: { 'User-Agent': 'luna-argos/1.0' },
      signal:  AbortSignal.timeout(10000),
    });

    if (res.status === 429) {
      const retryAfter = res.headers.get('retry-after') || '60';
      console.warn(`[아르고스] CoinGecko Rate Limit — ${retryAfter}s 후 재사용 가능, 이번 사이클 스킵`);
      return [];
    }
    if (!res.ok) {
      console.warn(`[아르고스] CoinGecko HTTP ${res.status} — 스킵`);
      return [];
    }

    const data  = await res.json();
    const invalid = [];
    const coins = (data?.coins || [])
      .map(c => `${(c.item?.symbol || '').toUpperCase()}/USDT`)
      .filter((symbol) => {
        const isValid = /^[A-Z0-9]+\/USDT$/.test(symbol) && symbol.length > 6;
        if (!isValid && symbol) invalid.push(symbol);
        return isValid;
      });
    if (invalid.length > 0) {
      console.warn(`[아르고스] CoinGecko 비정상 심볼 제외: ${invalid.slice(0, 10).join(', ')}`);
    }
    console.log(`[아르고스] CoinGecko 트렌딩: ${coins.join(', ') || '없음'}`);
    return coins;
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      console.warn(`[아르고스] CoinGecko 타임아웃 — 스킵`);
    } else {
      console.warn(`[아르고스] CoinGecko 트렌딩 실패: ${e.message}`);
    }
    return [];
  }
}

// ─── ApeWisdom (Reddit 멘션 집계) ───────────────────────────────────

/**
 * ApeWisdom Reddit 멘션 상위 종목 (완전 무료, 2h 갱신)
 * filter: 'all-crypto' | 'wallstreetbets' | 'all-stocks'
 */
async function _fetchApeWisdom(filter) {
  try {
    const res = await fetch(`https://apewisdom.io/api/v1.0/filter/${filter}/page/1`, {
      headers: { 'User-Agent': 'luna-argos/1.0' },
      signal:  AbortSignal.timeout(10000),
    });

    if (res.status === 429) {
      console.warn(`[아르고스] ApeWisdom(${filter}) Rate Limit — 스킵`);
      return [];
    }
    if (!res.ok) {
      console.warn(`[아르고스] ApeWisdom(${filter}) HTTP ${res.status} — 스킵`);
      return [];
    }

    const data    = await res.json();
    const tickers = (data?.results || []).slice(0, 15).map(r => r.ticker).filter(Boolean);
    console.log(`[아르고스] ApeWisdom(${filter}): ${tickers.slice(0,5).join(', ')}...`);
    return tickers;
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      console.warn(`[아르고스] ApeWisdom(${filter}) 타임아웃 — 스킵`);
    } else {
      console.warn(`[아르고스] ApeWisdom(${filter}) 실패: ${e.message}`);
    }
    return [];
  }
}

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
  const cooldownUntil = _redditCooldownUntil.get(subreddit) || 0;
  if (cooldownUntil > Date.now()) {
    _warnExternalOnce(
      `reddit-cooldown:${subreddit}`,
      `  ⚠️ [아르고스] r/${subreddit} rate limit 쿨다운 중 — 이번 사이클 스킵`,
      Math.min(REDDIT_COOLDOWN_TTL_MS, Math.max(1000, cooldownUntil - Date.now())),
    );
    return [];
  }

  const url = `https://www.reddit.com/r/${subreddit}/top.json?limit=${limit}&t=day`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'luna-argos/1.0 (investment bot)' },
      signal:  AbortSignal.timeout(10000),
    });
    if (res.status === 403) {
      _warnExternalOnce(`reddit403:${subreddit}`, `  ⚠️ [아르고스] r/${subreddit} 접근 거부(403) — 전략 수집 소스에서 일시 제외`);
      return [];
    }
    if (res.status === 429) {
      const retryAfterSec = Number(res.headers.get('retry-after') || 600);
      const retryMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : REDDIT_COOLDOWN_TTL_MS;
      _redditCooldownUntil.set(subreddit, Date.now() + retryMs);
      _warnExternalOnce(
        `reddit429:${subreddit}`,
        `  ⚠️ [아르고스] r/${subreddit} 수집 실패: HTTP 429 — ${Math.ceil(retryMs / 1000)}초 후 재시도`,
        retryMs,
      );
      return [];
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data?.data?.children || [])
      .map(c => c.data)
      .filter(p => p.score >= 20 && !p.stickied);
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError' || /timed out/i.test(e.message || '')) {
      _warnExternalOnce(`reddit-timeout:${subreddit}`, `  ⚠️ [아르고스] r/${subreddit} 수집 타임아웃 — 이번 사이클 스킵`);
      return [];
    }
    console.warn(`  ⚠️ [아르고스] r/${subreddit} 수집 실패: ${e.message}`);
    return [];
  }
}

// ─── LLM 품질 평가 ──────────────────────────────────────────────────

function normalizeEvaluatedStrategy(parsed, market, post) {
  if (!parsed?.strategy_name) return null;
  const qualityScore = Math.max(0, Math.min(1, _num(parsed.quality_score, 0)));

  return {
    ...parsed,
    strategy_name: String(parsed.strategy_name || '').trim(),
    entry_condition: String(parsed.entry_condition || '').trim(),
    exit_condition: String(parsed.exit_condition || '').trim(),
    risk_management: String(parsed.risk_management || '').trim(),
    applicable_timeframe: String(parsed.applicable_timeframe || 'all').trim() || 'all',
    quality_score: qualityScore,
    summary: String(parsed.summary || '').trim(),
    applicable_now: parsed.applicable_now === true,
    market,
    source: 'reddit',
    source_url: `https://reddit.com${post.permalink}`,
  };
}

function handleArgosEvaluationError(error, market) {
  if (error.name === 'TimeoutError' || error.name === 'AbortError' || /timed out/i.test(error.message || '')) {
    _warnExternalOnce(`argos-eval-timeout:${market}`, '  ⚠️ [아르고스] 전략 평가 타임아웃 — 일부 포스트 스킵');
    return true;
  }
  if ((error.message || '').includes('Groq API 키 없음')) {
    _warnExternalOnce('argos-groq-missing', '  ⚠️ [아르고스] Groq API 키 없음 — 전략 평가를 이번 사이클에서 스킵');
    return true;
  }
  if ((error.message || '').includes('OpenAI API 키 없음')) {
    _warnExternalOnce('argos-openai-missing', '  ⚠️ [아르고스] OpenAI API 키 없음 — OpenAI 폴백 없이 이번 사이클 스킵');
    return true;
  }
  return false;
}

async function evaluatePost(post, market) {
  const userMsg = [
    `제목: ${post.title}`,
    `내용: ${(post.selftext || '').slice(0, 800)}`,
    `좋아요: ${post.score} | 댓글: ${post.num_comments}`,
    ``,
    `이 포스트에서 트레이딩 전략을 추출하고 평가하시오.`,
  ].join('\n');

  const raw = await callLLMWithHub('argos', ARGOS_SYSTEM, userMsg, callLLM, 300);
  return normalizeEvaluatedStrategy(parseJSON(raw), market, post);
}

// ─── 메인 수집 함수 ──────────────────────────────────────────────────

export async function collectStrategies() {
  console.log('\n👁️ [아르고스] 외부 전략 수집 시작');

  let dbAvailable = true;
  try {
    await db.initSchema();
  } catch (error) {
    dbAvailable = false;
    console.warn(`  ⚠️ [아르고스] DB 미연결 — 전략 저장 생략: ${error.message}`);
  }

  let saved     = 0;
  const summary = [];

  for (const { name, market, limit } of SUBREDDITS) {
    console.log(`  📡 r/${name} 수집 중...`);
    const posts = await fetchRedditPosts(name, limit);
    console.log(`  → ${posts.length}개 포스트 (score≥20)`);

    for (const post of posts.slice(0, 5)) {
      try {
        const strategy = await evaluatePost(post, market);
        if (!strategy || _num(strategy.quality_score, 0) < MIN_QUALITY_SCORE) continue;

        summary.push(`• [${(_num(strategy.quality_score, 0) * 10).toFixed(0)}점] ${strategy.strategy_name}: ${strategy.summary}`);
        if (dbAvailable) {
          await db.upsertStrategy(strategy);
          saved++;
          console.log(`  ✅ 저장: ${strategy.strategy_name} (점수: ${_num(strategy.quality_score, 0).toFixed(2)})`);
        } else {
          console.log(`  ℹ️ [DB 생략] ${strategy.strategy_name} (점수: ${_num(strategy.quality_score, 0).toFixed(2)})`);
        }
      } catch (e) {
        if (handleArgosEvaluationError(e, market)) {
          continue;
        }
        console.warn(`  ⚠️ [아르고스] 평가 실패: ${e.message}`);
      }
    }
  }

  console.log(`\n✅ [아르고스] ${dbAvailable ? `${saved}개 전략 저장 완료` : `${summary.length}개 전략 평가 완료 (DB 저장 생략)`}`);

  if (summary.length > 0) {
    const msg = [
      `👁️ *아르고스 전략 수집 완료*`,
      `수집: ${dbAvailable ? saved : `${summary.length}개 평가 / DB 저장 생략`} (품질 ${MIN_QUALITY_SCORE} 이상)`,
      '',
      ...summary.slice(0, 5),
    ].join('\n');
    publishAlert({ from_bot: 'luna', event_type: 'report', alert_level: 1, message: msg });
  }

  return saved;
}

export async function recommendStrategy(symbol, exchange = 'binance') {
  const market = exchange === 'binance'
    ? 'crypto'
    : exchange === 'kis' || exchange === 'kis_overseas'
      ? 'stocks'
      : 'all';
  const strategies = await db.getActiveStrategies(market, 3);
  if (strategies.length === 0) return null;
  console.log(`  👁️ [아르고스] ${symbol} 추천 전략: ${strategies[0].strategy_name}`);
  return strategies[0];
}

// ─── 암호화폐 종목 스크리닝 (바이낸스 API) ──────────────────────────

/**
 * 바이낸스 24h 데이터 기반 동적 암호화폐 종목 선정
 * 볼륨 상위 30 필터 + 모멘텀 점수 기반 상위 N개 반환
 * @param {number} [maxDynamic] - 동적 종목 수 (기본: config.yaml 또는 3)
 */
export async function screenCryptoSymbols(maxDynamic, fng = 50) {
  const configuredMax = maxDynamic ?? _screenCfg('crypto', 'max_dynamic', 7);
  const baseMax = _adjustPaperExploration(configuredMax, 'crypto');
  const max     = _adjustMaxByFNG(baseMax, fng);
  const minVol  = _screenCfg('crypto', 'min_volume_usdt', 1_000_000);

  if (fng !== 50) console.log(`[아르고스] 크립토 FNG=${fng} → max_dynamic ${baseMax}→${max}`);
  if (isPaperMode() && baseMax !== configuredMax) console.log(`[아르고스] 크립토 PAPER 탐색 확장 ${configuredMax}→${baseMax}`);

  const exchange = new ccxt.binance({ enableRateLimit: true });

  try {
    const [tickers, cgTrending] = await Promise.allSettled([
      exchange.fetchTickers(),
      _fetchCoinGeckoTrending(),
    ]);

    const tickerMap = tickers.status === 'fulfilled' ? tickers.value : {};
    const cgSymbols = new Set(_sanitizeCryptoSymbols(cgTrending.status === 'fulfilled' ? cgTrending.value : [], tickerMap, 'CoinGecko'));
    const btcTicker = tickerMap['BTC/USDT'] || null;
    const ethTicker = tickerMap['ETH/USDT'] || null;
    const ethBtcTicker = tickerMap['ETH/BTC'] || null;
    const btcChange = Number(btcTicker?.percentage || 0);
    const ethChange = Number(ethTicker?.percentage || 0);
    const ethBtcMomentum = Number(ethBtcTicker?.percentage || 0);

    const STABLECOINS = new Set(['USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'FDUSD', 'PYUSD', 'USDP']);

    const candidates = Object.entries(tickerMap)
      .filter(([sym]) => sym.endsWith('/USDT'))
      .filter(([sym]) => {
        const base = sym.split('/')[0];
        if (STABLECOINS.has(base)) return false;
        if (/UP$|DOWN$|BULL$|BEAR$|3[LS]$/.test(base)) return false;
        return true;
      })
      .map(([symbol, t]) => ({
        symbol,
        price:         t.last        || 0,
        volume24h:     t.quoteVolume || 0,
        changePercent: t.percentage  || 0,
        high24h:       t.high        || 0,
        low24h:        t.low         || 0,
        cgTrend:       cgSymbols.has(symbol),  // CoinGecko 트렌딩 여부
      }))
      .filter(t => t.volume24h >= minVol)
      .sort((a, b) => b.volume24h - a.volume24h)
      .slice(0, 50);  // 30 → 50으로 후보 풀 확대

    const scored = candidates.map(t => {
      const absChange = Math.abs(t.changePercent);
      const volScore  = Math.log10(Math.max(t.volume24h, 1));
      const dirWeight = t.changePercent >= 0 ? 1.2 : 0.8;
      const momentum  = absChange * volScore * dirWeight;
      const range     = t.high24h - t.low24h;
      const rangePos  = range > 0 ? (t.price - t.low24h) / range : 0.5;
      const cgBonus   = t.cgTrend ? 1.2 : 1.0;  // CoinGecko 트렌딩 시 20% 보너스
      const relToBtc  = t.changePercent - btcChange;
      const relToEth  = t.changePercent - ethChange;
      const base = t.symbol.split('/')[0];
      const pullbackScore = _computeCryptoPullbackScore(t.changePercent, rangePos);
      const regimeBonus = _computeCryptoRegimeBonus({
        symbol: base,
        relToBtc,
        relToEth,
        ethBtcMomentum,
      });
      const overheatPenalty = _computeCryptoOverheatPenalty(t.changePercent, rangePos);
      return {
        ...t,
        momentum:   Math.round(momentum * 100) / 100,
        rangePos:   Math.round(rangePos * 100) / 100,
        relToBtc:   Math.round(relToBtc * 100) / 100,
        relToEth:   Math.round(relToEth * 100) / 100,
        finalScore: Math.round((
          (momentum * 0.55 + volScore * 0.25)
          + pullbackScore
          + regimeBonus
          - overheatPenalty
        ) * cgBonus * 100) / 100,
      };
    });

    const topDynamic     = await _applyCandidateIntelligence(scored.sort((a, b) => b.finalScore - a.finalScore), 'crypto', max);
    const dynamicSymbols = _sanitizeCryptoSymbols(topDynamic.map(t => t.symbol), tickerMap, '암호화폐 스크리닝');

    console.log(`[아르고스] 암호화폐 스크리닝: 동적 ${dynamicSymbols.join(', ') || '없음'}`);
    topDynamic.forEach(t =>
      console.log(
        `  ${t.symbol}${t.cgTrend ? '★' : ''}: ${t.changePercent > 0 ? '+' : ''}${t.changePercent.toFixed(1)}%`
        + ` | BTC대비 ${t.relToBtc >= 0 ? '+' : ''}${(t.relToBtc || 0).toFixed(1)}%`
        + ` | ${(t.volume24h / 1e6).toFixed(0)}M USDT`
        + ` | 점수 ${t.intelligenceScore ?? t.finalScore}`
      )
    );

    const sanitizedScreening = topDynamic.filter((item) => dynamicSymbols.includes(item.symbol));
    return { core: CORE_CRYPTO, dynamic: dynamicSymbols, all: dynamicSymbols, screening: sanitizedScreening, fng };
  } catch (e) {
    console.warn(`[아르고스] 암호화폐 스크리닝 실패: ${e.message}`);
    return { core: CORE_CRYPTO, dynamic: [], all: [], screening: [], error: e.message, fng };
  }
}

function _computeCryptoPullbackScore(changePercent, rangePos) {
  const change = Number(changePercent || 0);
  const pos = Number(rangePos || 0.5);
  if (change >= 3 && change <= 10 && pos >= 0.45 && pos <= 0.75) return 1.4;
  if (change >= 1 && change < 3 && pos >= 0.35 && pos <= 0.65) return 0.9;
  if (change <= -8 && pos < 0.25) return -0.8;
  return 0;
}

function _computeCryptoOverheatPenalty(changePercent, rangePos) {
  const change = Number(changePercent || 0);
  const pos = Number(rangePos || 0.5);
  if (change >= 18) return 1.8;
  if (change >= 12 && pos > 0.85) return 1.2;
  if (change >= 8 && pos > 0.92) return 0.7;
  return 0;
}

function _computeCryptoRegimeBonus({ symbol, relToBtc, relToEth, ethBtcMomentum }) {
  const safeSymbol = String(symbol || '').toUpperCase();
  let bonus = 0;
  if (relToBtc >= 2) bonus += 0.7;
  if (relToEth >= 1.5) bonus += 0.4;
  if (safeSymbol !== 'BTC' && safeSymbol !== 'ETH' && ethBtcMomentum > 0) bonus += 0.25;
  if (safeSymbol === 'ETH' && ethBtcMomentum > 0) bonus += 0.4;
  if (safeSymbol === 'BTC') bonus += relToEth > 0 ? 0.2 : 0;
  return Math.round(bonus * 100) / 100;
}

// ─── 국내주식 종목 스크리닝 (네이버 증권 거래량 상위) ────────────────

/**
 * 네이버 증권 거래량 상위 종목 → 동적 국내주식 선정
 * @param {number} [maxDynamic] - 동적 종목 수 (기본: config.yaml 또는 2)
 */
export async function screenDomesticSymbols(maxDynamic, fng = 50) {
  const configuredMax = maxDynamic ?? _screenCfg('domestic', 'max_dynamic', 5);
  const baseMax = _adjustPaperExploration(configuredMax, 'domestic');
  const max     = _adjustMaxByFNG(baseMax, fng);

  if (fng !== 50) console.log(`[아르고스] 국내주식 FNG=${fng} → max_dynamic ${baseMax}→${max}`);
  if (isPaperMode() && baseMax !== configuredMax) console.log(`[아르고스] 국내주식 PAPER 탐색 확장 ${configuredMax}→${baseMax}`);

  const sourceResults = await Promise.all([
    _tryKisVolumeRank(),
    _tryKisPlaceholderRank(),
    _tryNaverMobile(),
    _tryNaverSise(),
    _tryNaverRiseHtml(),
  ]);

  const merged = _mergeDomesticSourceCandidates(sourceResults);
  if (merged.length) {
    const scoutIntel = await loadLatestScoutIntel();
    const boosted = boostCandidatesWithScout(merged, scoutIntel, { market: 'domestic', boost: 1.2 });
    return _finalizeDomesticResult(boosted, max);
  }

  // 모두 실패 → 코어만 반환
  const fallbackSymbols = getKisSymbols();
  console.warn('[아르고스] 국내주식 스크리닝 전체 실패 — 기본 종목 반환');
  return {
    core: fallbackSymbols,
    dynamic: [],
    all: fallbackSymbols,
    screening: fallbackSymbols.map(symbol => ({ symbol, name: symbol, sourceNames: ['config_core'], sourceCount: 1 })),
    error: 'all_apis_failed',
  };
}

/** KIS API 거래량 순위 기반 국내주식 스크리닝 */
async function _tryKisVolumeRank() {
  try {
    const ranks = await getVolumeRank();
    if (!ranks.length) return [];
    return ranks.map(r => ({
      stockCode:                 r.stockCode,
      stockName:                 r.stockName,
      fluctuationsRatio:         r.changeRate,
      accumulatedTradingVolume:  r.volume,
      sourceName:                'kis_volume_rank',
      sourcePriority:            1.3,
    }));
  } catch (e) {
    console.warn(`[아르고스] KIS 거래량 순위 실패: ${e.message}`);
    return [];
  }
}

/**
 * 추가 KIS 순위분석 API를 붙일 자리.
 * 세부 TR/파라미터를 공식 문서에서 확정하면 여기에 같은 형태로 추가한다.
 */
async function _tryKisPlaceholderRank() {
  const specs = [];
  const results = await Promise.all(specs.map(async (spec) => {
    const rows = await getDomesticRanking(spec.endpoint, spec.trId, spec.params || {});
    return rows.map(spec.mapRow);
  }));
  return results.flat();
}

function _fetchText(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const trimmed = body.trim();
        if (!trimmed) {
          reject(new Error('빈 응답'));
          return;
        }
        resolve(trimmed);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('타임아웃')); });
  });
}

/** 공통: JSON fetch 유틸 */
function _fetchJSON(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const trimmed = body.trim();
        if (!trimmed) {
          reject(new Error('빈 응답'));
          return;
        }
        if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
          reject(new Error(`비JSON 응답(${trimmed.slice(0, 40)})`));
          return;
        }
        try {
          resolve(JSON.parse(trimmed));
        } catch {
          reject(new Error('JSON 파싱 실패'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('타임아웃')); });
  });
}

/** 공통: 결과 빌드 */
function _normalizeDomesticCandidates(stocks) {
  return stocks
    .filter(s => s.stockCode)
    .map(s => ({
      symbol:     String(s.stockCode).padStart(6, '0'),
      name:       s.stockName || s.name || '',
      price:      parseInt(s.closePrice || s.price) || 0,
      changeRate: parseFloat(s.fluctuationsRatio || s.changeRate) || 0,
      volume:     parseInt(s.accumulatedTradingVolume || s.volume) || 0,
      sourceName: s.sourceName || 'unknown',
      sourcePriority: Number(s.sourcePriority || 1),
    }));
}

function _mergeDomesticSourceCandidates(sourceResults) {
  const bucket = new Map();
  const flattened = sourceResults.flatMap(result => _normalizeDomesticCandidates(result || []));

  for (const candidate of flattened) {
    if (!candidate.symbol) continue;
    const existing = bucket.get(candidate.symbol);
    if (!existing) {
      bucket.set(candidate.symbol, {
        ...candidate,
        sourceNames: new Set([candidate.sourceName]),
        sourceVotes: candidate.sourcePriority,
        finalScore: Number(candidate.changeRate || 0) + (candidate.sourcePriority * 0.8),
      });
      continue;
    }

    existing.name ||= candidate.name;
    existing.price ||= candidate.price;
    existing.volume = Math.max(existing.volume || 0, candidate.volume || 0);
    existing.changeRate = Math.max(existing.changeRate || 0, candidate.changeRate || 0);
    existing.sourceNames.add(candidate.sourceName);
    existing.sourceVotes += candidate.sourcePriority;
    existing.finalScore = Number(existing.changeRate || 0) + (existing.sourceVotes * 0.8);
  }

  return [...bucket.values()].map(candidate => ({
    ...candidate,
    sourceNames: [...candidate.sourceNames],
    sourceCount: candidate.sourceNames.size,
  }));
}

function _finalizeDomesticResult(candidates, max) {

  if (!candidates.length) return null;

  return _applyCandidateIntelligence(candidates, 'domestic', max).then((ranked) => {
    const dynamicSymbols = ranked.map(c => c.symbol);
    console.log(`[아르고스] 국내주식 스크리닝: 동적 ${dynamicSymbols.join(', ')}`);
    ranked.forEach(c =>
      console.log(
        `  ${c.symbol}(${c.name}): ${c.changeRate > 0 ? '+' : ''}${c.changeRate}%`
        + ` | 소스 ${c.sourceCount || 1}개 (${(c.sourceNames || []).join(', ')})`
      )
    );
    return { core: CORE_KIS, dynamic: dynamicSymbols, all: dynamicSymbols, screening: ranked };
  });
}

/** 대안 1: 네이버 모바일 상승률 API (불안정) */
async function _tryNaverMobile() {
  try {
    const data = await _fetchJSON(
      'https://m.stock.naver.com/api/stocks/up?page=1&pageSize=30', 5000
    );
    // 응답 구조 자동 감지 (API 변경 대응)
    const stocks = data?.stocks
      || data?.result?.stocks
      || data?.data?.stocks
      || data?.result?.data
      || [];
    if (!stocks.length || !stocks[0]?.stockCode) return [];
    return stocks.map(stock => ({ ...stock, sourceName: 'naver_mobile_up', sourcePriority: 1.1 }));
  } catch (e) {
    console.warn(`[아르고스] 네이버 모바일 API 실패: ${e.message}`);
    return [];
  }
}

/** 대안 2: 네이버 증권 시세 API (더 안정적) */
async function _tryNaverSise() {
  try {
    // 네이버 증권 국내주식 상승률 상위
    const data = await _fetchJSON(
      'https://finance.naver.com/api/sise/siseList.nhn?sosok=0&page=1&type=up', 5000
    );
    const items = data?.result?.itemList || data?.itemList || data?.result || [];
    if (!Array.isArray(items) || !items.length) return [];

    return items.map(s => ({
      stockCode:                 s.cd   || s.itemcode || s.code,
      stockName:                 s.nm   || s.itemname || s.name,
      closePrice:                s.nv   || s.now      || s.closePrice,
      fluctuationsRatio:         s.cr   || s.changeRate,
      accumulatedTradingVolume:  s.aq   || s.quant    || s.volume,
      sourceName:                'naver_sise_up',
      sourcePriority:            1.15,
    }));
  } catch (e) {
    console.warn(`[아르고스] 네이버 시세 API 실패: ${e.message}`);
    return [];
  }
}

/** 대안 3: 네이버 상승 종목 HTML 파싱 */
async function _tryNaverRiseHtml(max = 10) {
  try {
    const html = await _fetchText('https://finance.naver.com/sise/sise_rise.naver?sosok=0', 5000);
    const matches = [...html.matchAll(/href="\/item\/main\.naver\?code=(\d{6})"[^>]*>([^<]+)<\/a>/g)];
    const seen = new Set();
    const stocks = [];

    for (const match of matches) {
      const stockCode = match[1];
      const stockName = match[2]?.trim();
      if (!stockCode || !stockName || seen.has(stockCode)) continue;
      seen.add(stockCode);
      stocks.push({ stockCode, stockName });
      if (stocks.length >= Math.max(max * 2, 20)) break;
    }

    if (!stocks.length) return [];
    return stocks.map(stock => ({ ...stock, sourceName: 'naver_rise_html', sourcePriority: 0.9 }));
  } catch (e) {
    console.warn(`[아르고스] 네이버 상승 HTML 실패: ${e.message}`);
    return [];
  }
}

// ─── 해외주식 종목 스크리닝 (Yahoo Finance Trending) ─────────────────

/**
 * Yahoo Finance Trending Tickers → 동적 해외주식 선정
 * @param {number} [maxDynamic] - 동적 종목 수 (기본: config.yaml 또는 2)
 */
export async function screenOverseasSymbols(maxDynamic, fng = 50) {
  const configuredMax = maxDynamic ?? _screenCfg('overseas', 'max_dynamic', 5);
  const baseMax = _adjustPaperExploration(configuredMax, 'overseas');
  const max     = _adjustMaxByFNG(baseMax, fng);

  if (fng !== 50) console.log(`[아르고스] 해외주식 FNG=${fng} → max_dynamic ${baseMax}→${max}`);
  if (isPaperMode() && baseMax !== configuredMax) console.log(`[아르고스] 해외주식 PAPER 탐색 확장 ${configuredMax}→${baseMax}`);

  // 두 소스 병렬 조회
  const [yahooRes, apeRes] = await Promise.allSettled([
    _fetchYahooTrending(),
    _fetchApeWisdom('wallstreetbets'),
  ]);

  const yahooTickers = yahooRes.status === 'fulfilled' ? yahooRes.value : [];
  const apeTickers   = apeRes.status   === 'fulfilled' ? apeRes.value   : [];
  const quoteUniverse = [...new Set([...yahooTickers, ...apeTickers])]
    .filter(Boolean)
    .slice(0, Math.max(max * 2, 20));
  const quoteMap = quoteUniverse.length
    ? await _fetchYahooQuoteMap(quoteUniverse)
    : new Map();
  const candidates = _mergeOverseasSourceCandidates(yahooTickers, apeTickers, quoteMap);

  const ranked = await _applyCandidateIntelligence(candidates, 'overseas', max);
  const dynamicSymbols = ranked.map(c => c.symbol);
  console.log(`[아르고스] 해외주식 스크리닝: 동적 ${dynamicSymbols.join(', ') || '없음'}`);
  ranked.forEach(c =>
    console.log(
      `  ${c.symbol}: ${c.changeRate > 0 ? '+' : ''}${(c.changeRate || 0).toFixed(2)}%`
      + ` | 거래대금 ${(c.dollarVolume || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
      + ` | 소스 ${c.sourceCount || 1}개 (${(c.sourceNames || []).join(', ')})`
    )
  );

  if (!dynamicSymbols.length && yahooTickers.length === 0) {
    const fallbackSymbols = getKisOverseasSymbols();
    return {
      core: fallbackSymbols,
      dynamic: [],
      all: fallbackSymbols,
      screening: fallbackSymbols.map(symbol => ({ symbol, name: symbol, sourceNames: ['config_core'], sourceCount: 1 })),
      error: 'all_sources_failed',
    };
  }

  return { core: CORE_OVERSEAS, dynamic: dynamicSymbols, all: dynamicSymbols, screening: ranked, fng };
}

function _mergeOverseasSourceCandidates(yahooTickers, apeTickers, quoteMap = new Map()) {
  const bucket = new Map();
  const addCandidate = (symbol, sourceName, rank, sourcePriorityBase) => {
    if (!symbol || symbol.includes('^') || symbol.includes('=') || symbol.length > 6) return;
    const normalized = symbol.toUpperCase();
    const quote = quoteMap.get(normalized) || {};
    const rankBoost = Math.max(0.2, 1 - (rank * 0.03));
    const sourcePriority = Math.round((sourcePriorityBase * rankBoost) * 100) / 100;
    const existing = bucket.get(normalized);
    if (!existing) {
      bucket.set(normalized, {
        symbol: normalized,
        name: quote.name || normalized,
        price: quote.price || 0,
        volume: quote.volume || 0,
        dollarVolume: quote.dollarVolume || 0,
        changeRate: quote.changeRate || 0,
        sourceNames: [sourceName],
        sourceCount: 1,
        sourcePriority,
        finalScore: sourcePriority,
      });
      return;
    }
    if (!existing.sourceNames.includes(sourceName)) {
      existing.sourceNames.push(sourceName);
      existing.sourceCount = existing.sourceNames.length;
    }
    existing.name ||= quote.name || normalized;
    existing.price ||= quote.price || 0;
    existing.volume = Math.max(existing.volume || 0, quote.volume || 0);
    existing.dollarVolume = Math.max(existing.dollarVolume || 0, quote.dollarVolume || 0);
    if (quote.changeRate != null) {
      const current = Number(existing.changeRate || 0);
      if (Math.abs(Number(quote.changeRate || 0)) > Math.abs(current)) {
        existing.changeRate = Number(quote.changeRate || 0);
      }
    }
    existing.sourcePriority += sourcePriority;
    existing.finalScore += sourcePriority;
  };

  yahooTickers.forEach((sym, idx) => addCandidate(sym, 'yahoo_trending', idx, 1.1));
  apeTickers.forEach((sym, idx) => addCandidate(sym, 'apewisdom', idx, 1.0));

  return [...bucket.values()];
}

/** Yahoo Finance Trending US (심볼 목록만 반환) */
async function _fetchYahooTrending() {
  return new Promise((resolve) => {
    const req = https.get(
      'https://query1.finance.yahoo.com/v1/finance/trending/US?count=40',
      { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 },
      res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try {
            const data  = JSON.parse(body);
            const syms  = (data?.finance?.result?.[0]?.quotes || [])
              .map(q => q.symbol)
              .filter(s => s && !s.includes('^') && !s.includes('='));
            resolve(syms);
          } catch { resolve([]); }
        });
      }
    );
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
  });
}

async function _fetchYahooQuoteMap(symbols) {
  return new Promise((resolve) => {
    if (!symbols.length) {
      resolve(new Map());
      return;
    }

    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(','))}`;
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 },
      res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            const results = data?.quoteResponse?.result || [];
            const map = new Map();
            results.forEach((item) => {
              const symbol = String(item?.symbol || '').toUpperCase();
              if (!symbol) return;
              const price = Number(item?.regularMarketPrice || item?.postMarketPrice || 0);
              const volume = Number(item?.regularMarketVolume || item?.averageDailyVolume3Month || 0);
              map.set(symbol, {
                name: item?.shortName || item?.longName || symbol,
                price,
                volume,
                changeRate: Number(item?.regularMarketChangePercent || 0),
                dollarVolume: price > 0 && volume > 0 ? price * volume : 0,
              });
            });
            resolve(map);
          } catch {
            resolve(new Map());
          }
        });
      },
    );
    req.on('error', () => resolve(new Map()));
    req.on('timeout', () => { req.destroy(); resolve(new Map()); });
  });
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
      crypto:   { core: CORE_CRYPTO,   dynamic: [], all: [],            screening: [] },
      domestic: { core: CORE_KIS,      dynamic: [], all: [],            screening: [] },
      overseas: { core: CORE_OVERSEAS, dynamic: [], all: [],            screening: [] },
      timestamp: new Date().toISOString(),
    };
  }

  console.log('\n🔍 [아르고스] 전체 마켓 종목 스크리닝 시작...\n');

  // FNG 한 번 조회 → 세 스크리너 공유 (API 호출 최소화)
  const fng = await fetchFearGreedIndex();

  const [cryptoRes, domesticRes, overseasRes] = await Promise.allSettled([
    screenCryptoSymbols(undefined, fng),
    screenDomesticSymbols(undefined, fng),
    screenOverseasSymbols(undefined, fng),
  ]);

  const result = {
    crypto:    cryptoRes.status   === 'fulfilled' ? cryptoRes.value   : { core: CORE_CRYPTO,   dynamic: [], all: [], screening: [] },
    domestic:  domesticRes.status === 'fulfilled' ? domesticRes.value : { core: CORE_KIS,      dynamic: [], all: [], screening: [] },
    overseas:  overseasRes.status === 'fulfilled' ? overseasRes.value : { core: CORE_OVERSEAS, dynamic: [], all: [], screening: [] },
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
  const fngLabel     = fng < 25 ? '극도의공포🔴' : fng > 75 ? '탐욕🟢' : '중립⚪';
  console.log(`\n🔍 [아르고스] 스크리닝 완료: 동적 ${totalDynamic}개 종목 선정 (FNG ${fng} ${fngLabel})`);
  console.log(`  암호화폐: ${result.crypto.all.join(', ')}`);
  console.log(`  국내주식: ${result.domestic.all.join(', ')}`);
  console.log(`  해외주식: ${result.overseas.all.join(', ')}\n`);

  return result;
}

// CLI 실행
if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: () => collectStrategies(),
    onSuccess: async (count) => {
      console.log(`\n결과: ${count}개 전략`);
    },
    errorPrefix: '❌ 아르고스 오류:',
  });
}
