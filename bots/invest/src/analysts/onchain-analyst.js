'use strict';

/**
 * src/analysts/onchain-analyst.js — 온체인분석가
 *
 * 수집 데이터 (모두 무료 공개 API):
 *   1. 공포탐욕지수 (alternative.me)
 *   2. 펀딩비 (Binance 선물 공개 API)
 *   3. Long/Short 비율 (Binance 선물 공개 API)
 *   4. 미결제약정 (Binance 선물 공개 API)
 *
 * LLM: Cerebras llama3.1-8b (무료, 1M TPD) → Groq fallback
 * Cerebras/Groq API 키 없으면 → 규칙 기반 판단으로 자동 대체
 *
 * 실행: node src/analysts/onchain-analyst.js [--symbol=BTC/USDT]
 */

const https  = require('https');
const db     = require('../../lib/db');
const { callGroqAPI }  = require('../../lib/groq');
const { ANALYST_TYPES, ACTIONS } = require('../../lib/signal');

// ─── 공개 API 데이터 수집 ──────────────────────────────────────────

function httpsGet(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET' }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error(`JSON 파싱 실패: ${raw.slice(0, 100)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('HTTP 타임아웃')); });
    req.end();
  });
}

/**
 * 공포탐욕지수 조회 (alternative.me, 인증 불필요)
 * @returns {{ value: number, classification: string, timestamp: string }|null}
 */
async function fetchFearGreed() {
  try {
    const data = await httpsGet('api.alternative.me', '/fng/?limit=1');
    const item = data?.data?.[0];
    if (!item) return null;
    return {
      value:          parseInt(item.value, 10),
      classification: item.value_classification, // 'Extreme Fear'~'Extreme Greed'
      timestamp:      item.timestamp,
    };
  } catch (e) {
    console.warn(`  ⚠️ 공포탐욕지수 조회 실패: ${e.message}`);
    return null;
  }
}

/**
 * 펀딩비 조회 (Binance 선물 공개 API)
 * @param {string} symbol ex) 'BTCUSDT'
 * @returns {{ symbol, fundingRate: number, fundingTime: string }|null}
 */
async function fetchFundingRate(symbol) {
  try {
    const data = await httpsGet('fapi.binance.com', `/fapi/v1/fundingRate?symbol=${symbol}&limit=1`);
    const item = Array.isArray(data) ? data[0] : null;
    if (!item) return null;
    return {
      symbol:      item.symbol,
      fundingRate: parseFloat(item.fundingRate),
      fundingTime: new Date(item.fundingTime).toISOString(),
    };
  } catch (e) {
    console.warn(`  ⚠️ 펀딩비 조회 실패 (${symbol}): ${e.message}`);
    return null;
  }
}

/**
 * Long/Short 비율 조회 (Binance 선물 공개 API)
 * @param {string} symbol ex) 'BTCUSDT'
 * @returns {{ longShortRatio: number, longAccount: number, shortAccount: number }|null}
 */
async function fetchLongShortRatio(symbol) {
  try {
    const data = await httpsGet(
      'fapi.binance.com',
      `/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=1`,
    );
    const item = Array.isArray(data) ? data[0] : null;
    if (!item) return null;
    return {
      longShortRatio: parseFloat(item.longShortRatio),
      longAccount:    parseFloat(item.longAccount),
      shortAccount:   parseFloat(item.shortAccount),
    };
  } catch (e) {
    console.warn(`  ⚠️ Long/Short 비율 조회 실패 (${symbol}): ${e.message}`);
    return null;
  }
}

/**
 * 미결제약정 조회 (Binance 선물 공개 API)
 * @param {string} symbol ex) 'BTCUSDT'
 * @returns {{ openInterest: number }|null}
 */
async function fetchOpenInterest(symbol) {
  try {
    const data = await httpsGet('fapi.binance.com', `/fapi/v1/openInterest?symbol=${symbol}`);
    if (!data?.openInterest) return null;
    return { openInterest: parseFloat(data.openInterest) };
  } catch (e) {
    console.warn(`  ⚠️ 미결제약정 조회 실패 (${symbol}): ${e.message}`);
    return null;
  }
}

// ─── 규칙 기반 신호 판단 (LLM 없을 때 대체) ───────────────────────

function ruleBasedSignal(fearGreed, funding, lsRatio) {
  let score = 0;
  const factors = [];

  // 공포탐욕지수
  if (fearGreed) {
    if (fearGreed.value <= 20) {
      score += 1.5;
      factors.push(`극도의 공포 (${fearGreed.value} — 역추세 매수 기회)`);
    } else if (fearGreed.value >= 80) {
      score -= 1.5;
      factors.push(`극도의 탐욕 (${fearGreed.value} — 과열 주의)`);
    } else if (fearGreed.value <= 40) {
      score += 0.5;
      factors.push(`공포 구간 (${fearGreed.value})`);
    } else if (fearGreed.value >= 60) {
      score -= 0.5;
      factors.push(`탐욕 구간 (${fearGreed.value})`);
    } else {
      factors.push(`중립 (${fearGreed.value})`);
    }
  }

  // 펀딩비: 양수 높음 → 과열(SELL), 음수 → 공매도 과도(BUY)
  if (funding) {
    const fPct = funding.fundingRate * 100;
    if (fPct > 0.05) {
      score -= 1.0;
      factors.push(`펀딩비 과열 (+${fPct.toFixed(4)}% — 롱 과도)`);
    } else if (fPct < -0.01) {
      score += 1.0;
      factors.push(`펀딩비 음수 (${fPct.toFixed(4)}% — 숏 과도)`);
    } else {
      factors.push(`펀딩비 중립 (${fPct.toFixed(4)}%)`);
    }
  }

  // Long/Short 비율: 과도한 롱 → SELL, 과도한 숏 → BUY
  if (lsRatio) {
    if (lsRatio.longShortRatio > 1.8) {
      score -= 0.5;
      factors.push(`롱 과도 (L/S ${lsRatio.longShortRatio.toFixed(2)})`);
    } else if (lsRatio.longShortRatio < 0.8) {
      score += 0.5;
      factors.push(`숏 과도 (L/S ${lsRatio.longShortRatio.toFixed(2)})`);
    } else {
      factors.push(`L/S 균형 (${lsRatio.longShortRatio.toFixed(2)})`);
    }
  }

  const maxScore   = 3.0;
  const confidence = Math.min(Math.abs(score) / maxScore, 1);
  let signal;
  if (score >= 1.0)      signal = ACTIONS.BUY;
  else if (score <= -1.0) signal = ACTIONS.SELL;
  else                    signal = ACTIONS.HOLD;

  return { signal, confidence, reasoning: factors.join(' | '), score };
}

// ─── LLM 프롬프트 ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `당신은 암호화폐 온체인·파생상품 시장 분석 전문가입니다.
공포탐욕지수, 펀딩비, Long/Short 비율, 미결제약정 데이터를 분석해 매매 신호를 판단합니다.

응답 형식 (JSON만, 마크다운 없음):
{"action":"BUY"|"SELL"|"HOLD","confidence":0.0~1.0,"reasoning":"근거 1~2문장 (한국어)"}

규칙:
- 극도의 공포(지수≤20) → 역발상 BUY 고려
- 극도의 탐욕(지수≥80) → SELL 또는 HOLD 고려
- 펀딩비 과열(>0.05%) → 롱 청산 위험, SELL/HOLD
- 복합 신호 불일치 시 HOLD
- confidence 0.5 미만이면 반드시 HOLD`;

// ─── 메인 분석 실행 ────────────────────────────────────────────────

/**
 * 온체인 데이터 수집 + 신호 생성 + DB 저장
 * @param {string} symbol ex) 'BTC/USDT'
 */
async function analyzeOnchain(symbol = 'BTC/USDT') {
  // CCXT 심볼 → Binance 선물 심볼 변환 (BTC/USDT → BTCUSDT)
  const futureSymbol = symbol.replace('/', '');

  console.log(`\n🔗 [온체인] ${symbol} 데이터 수집 중...`);

  // 데이터 병렬 수집
  const [fearGreed, funding, lsRatio, openInterest] = await Promise.all([
    fetchFearGreed(),
    fetchFundingRate(futureSymbol),
    fetchLongShortRatio(futureSymbol),
    fetchOpenInterest(futureSymbol),
  ]);

  // 로그 출력
  console.log(`  공포탐욕지수: ${fearGreed ? `${fearGreed.value} (${fearGreed.classification})` : 'N/A'}`);
  console.log(`  펀딩비:       ${funding ? `${(funding.fundingRate * 100).toFixed(4)}%` : 'N/A'}`);
  console.log(`  Long/Short:   ${lsRatio ? `${lsRatio.longShortRatio.toFixed(2)} (롱 ${(lsRatio.longAccount * 100).toFixed(1)}%)` : 'N/A'}`);
  console.log(`  미결제약정:   ${openInterest ? `${parseFloat(openInterest.openInterest).toLocaleString()} ${futureSymbol.replace('USDT', '')}` : 'N/A'}`);

  // LLM 판단 또는 규칙 기반 대체
  let signal, confidence, reasoning;

  const userMsg = [
    `심볼: ${symbol}`,
    fearGreed    ? `공포탐욕지수: ${fearGreed.value} (${fearGreed.classification})` : '',
    funding      ? `펀딩비: ${(funding.fundingRate * 100).toFixed(4)}% (${funding.fundingRate > 0 ? '롱 과도' : '숏 과도'})` : '',
    lsRatio      ? `Long/Short 비율: ${lsRatio.longShortRatio.toFixed(2)} (롱 ${(lsRatio.longAccount * 100).toFixed(1)}% / 숏 ${(lsRatio.shortAccount * 100).toFixed(1)}%)` : '',
    openInterest ? `미결제약정: ${parseFloat(openInterest.openInterest).toLocaleString()} ${futureSymbol.replace('USDT', '')}` : '',
  ].filter(Boolean).join('\n');

  const responseText = await callGroqAPI(SYSTEM_PROMPT, userMsg, 'llama3.1-8b', 'onchain-analyst', 'cerebras');

  if (responseText) {
    try {
      const parsed = JSON.parse(responseText.replace(/```json?\n?|\n?```/g, '').trim());
      signal     = parsed.action;
      confidence = parsed.confidence;
      reasoning  = parsed.reasoning;
    } catch (e) {
      console.warn(`  ⚠️ Groq 응답 파싱 실패 — 규칙 기반 대체`);
      ({ signal, confidence, reasoning } = ruleBasedSignal(fearGreed, funding, lsRatio));
    }
  } else {
    ({ signal, confidence, reasoning } = ruleBasedSignal(fearGreed, funding, lsRatio));
  }

  console.log(`  → 신호: ${signal} (확신도 ${(confidence * 100).toFixed(0)}%)`);
  console.log(`  근거: ${reasoning}`);

  // DB 저장
  await db.insertAnalysis({
    symbol,
    analyst:   ANALYST_TYPES.ONCHAIN,
    signal,
    confidence,
    reasoning: `[온체인] ${reasoning}`,
    metadata:  {
      fearGreed:    fearGreed?.value,
      fgClass:      fearGreed?.classification,
      fundingRate:  funding?.fundingRate,
      longShortRatio: lsRatio?.longShortRatio,
      openInterest:   openInterest?.openInterest,
    },
  });
  console.log(`  ✅ DB 저장 완료`);

  return { symbol, signal, confidence, reasoning };
}

// CLI 실행
if (require.main === module) {
  const args   = process.argv.slice(2);
  const symbol = args.find(a => a.startsWith('--symbol='))?.split('=')[1] || 'BTC/USDT';

  analyzeOnchain(symbol)
    .then(() => process.exit(0))
    .catch(e => { console.error('❌ 온체인 분석 실패:', e.message); process.exit(1); });
}

module.exports = { analyzeOnchain, fetchFearGreed, fetchFundingRate, fetchLongShortRatio };
