'use strict';

/**
 * team/oracle.js — 오라클 (온체인·매크로 분석가)
 *
 * 역할: 온체인 + 파생상품 데이터 분석
 * LLM: Cerebras llama3.1-8b → Groq fallback
 * 소스: alternative.me (공포탐욕) + Binance Futures (펀딩비·L/S·OI)
 *
 * bots/invest/src/analysts/onchain-analyst.js 재사용
 *
 * 실행: node team/oracle.js --symbol=BTC/USDT
 */

const https = require('https');
const db    = require('../shared/db');
const { callFreeLLM, parseJSON } = require('../shared/llm');
const { ANALYST_TYPES, ACTIONS } = require('../shared/signal');

// ─── 공개 API 수집 ──────────────────────────────────────────────────

function httpsGet(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET' }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error(`JSON 파싱 실패: ${raw.slice(0, 80)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('타임아웃')); });
    req.end();
  });
}

async function fetchFearGreed() {
  try {
    const data = await httpsGet('api.alternative.me', '/fng/?limit=1');
    const item = data?.data?.[0];
    if (!item) return null;
    return { value: parseInt(item.value, 10), classification: item.value_classification };
  } catch (e) {
    console.warn(`  ⚠️ [오라클] 공포탐욕지수 실패: ${e.message}`);
    return null;
  }
}

async function fetchFundingRate(symbol) {
  try {
    const data = await httpsGet('fapi.binance.com', `/fapi/v1/fundingRate?symbol=${symbol}&limit=1`);
    const item = Array.isArray(data) ? data[0] : null;
    if (!item) return null;
    return { symbol: item.symbol, fundingRate: parseFloat(item.fundingRate) };
  } catch (e) {
    console.warn(`  ⚠️ [오라클] 펀딩비 실패 (${symbol}): ${e.message}`);
    return null;
  }
}

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
    console.warn(`  ⚠️ [오라클] L/S 비율 실패 (${symbol}): ${e.message}`);
    return null;
  }
}

async function fetchOpenInterest(symbol) {
  try {
    const data = await httpsGet('fapi.binance.com', `/fapi/v1/openInterest?symbol=${symbol}`);
    if (!data?.openInterest) return null;
    return { openInterest: parseFloat(data.openInterest) };
  } catch (e) {
    console.warn(`  ⚠️ [오라클] 미결제약정 실패 (${symbol}): ${e.message}`);
    return null;
  }
}

// ─── 규칙 기반 판단 (LLM fallback) ─────────────────────────────────

function ruleBasedSignal(fearGreed, funding, lsRatio) {
  let score = 0;
  const factors = [];

  if (fearGreed) {
    if (fearGreed.value <= 20)       { score += 1.5; factors.push(`극도의 공포 (${fearGreed.value})`); }
    else if (fearGreed.value >= 80)  { score -= 1.5; factors.push(`극도의 탐욕 (${fearGreed.value})`); }
    else if (fearGreed.value <= 40)  { score += 0.5; factors.push(`공포 (${fearGreed.value})`); }
    else if (fearGreed.value >= 60)  { score -= 0.5; factors.push(`탐욕 (${fearGreed.value})`); }
    else                              { factors.push(`중립 (${fearGreed.value})`); }
  }

  if (funding) {
    const fPct = funding.fundingRate * 100;
    if (fPct > 0.05)       { score -= 1.0; factors.push(`펀딩비 과열 (+${fPct.toFixed(4)}%)`); }
    else if (fPct < -0.01) { score += 1.0; factors.push(`펀딩비 음수 (${fPct.toFixed(4)}%)`); }
    else                    { factors.push(`펀딩비 중립 (${fPct.toFixed(4)}%)`); }
  }

  if (lsRatio) {
    if (lsRatio.longShortRatio > 1.8)       { score -= 0.5; factors.push(`롱 과도 (${lsRatio.longShortRatio.toFixed(2)})`); }
    else if (lsRatio.longShortRatio < 0.8)  { score += 0.5; factors.push(`숏 과도 (${lsRatio.longShortRatio.toFixed(2)})`); }
    else                                     { factors.push(`L/S 균형 (${lsRatio.longShortRatio.toFixed(2)})`); }
  }

  const maxScore   = 3.0;
  const confidence = Math.min(Math.abs(score) / maxScore, 1);
  let signal;
  if (score >= 1.0)       signal = ACTIONS.BUY;
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

// ─── 메인 분석 ─────────────────────────────────────────────────────

/**
 * 온체인·파생상품 분석 + DB 저장
 * @param {string} symbol ex) 'BTC/USDT'
 */
async function analyzeOnchain(symbol = 'BTC/USDT') {
  const futureSymbol = symbol.replace('/', '');
  console.log(`\n🔗 [오라클] ${symbol} 온체인 데이터 수집 중...`);

  const [fearGreed, funding, lsRatio, openInterest] = await Promise.all([
    fetchFearGreed(),
    fetchFundingRate(futureSymbol),
    fetchLongShortRatio(futureSymbol),
    fetchOpenInterest(futureSymbol),
  ]);

  console.log(`  공포탐욕지수: ${fearGreed ? `${fearGreed.value} (${fearGreed.classification})` : 'N/A'}`);
  console.log(`  펀딩비: ${funding ? `${(funding.fundingRate * 100).toFixed(4)}%` : 'N/A'}`);
  console.log(`  Long/Short: ${lsRatio ? `${lsRatio.longShortRatio.toFixed(2)}` : 'N/A'}`);
  console.log(`  미결제약정: ${openInterest ? `${parseFloat(openInterest.openInterest).toLocaleString()}` : 'N/A'}`);

  let signal, confidence, reasoning;

  const userMsg = [
    `심볼: ${symbol}`,
    fearGreed    ? `공포탐욕지수: ${fearGreed.value} (${fearGreed.classification})` : '',
    funding      ? `펀딩비: ${(funding.fundingRate * 100).toFixed(4)}%` : '',
    lsRatio      ? `Long/Short 비율: ${lsRatio.longShortRatio.toFixed(2)} (롱 ${(lsRatio.longAccount * 100).toFixed(1)}%)` : '',
    openInterest ? `미결제약정: ${parseFloat(openInterest.openInterest).toLocaleString()} ${futureSymbol.replace('USDT', '')}` : '',
  ].filter(Boolean).join('\n');

  // cerebras 8b → Groq 8b fallback (groqModel='llama-3.1-8b-instant')
  const responseText = await callFreeLLM(SYSTEM_PROMPT, userMsg, 'llama3.1-8b', 'oracle', 'cerebras', 256, 'llama-3.1-8b-instant');
  const parsed       = parseJSON(responseText);

  if (parsed?.action) {
    signal     = parsed.action;
    confidence = parsed.confidence;
    reasoning  = parsed.reasoning;
  } else {
    ({ signal, confidence, reasoning } = ruleBasedSignal(fearGreed, funding, lsRatio));
  }

  console.log(`  → [오라클] ${signal} (${(confidence * 100).toFixed(0)}%) | ${reasoning}`);

  await db.insertAnalysis({
    symbol,
    analyst:   ANALYST_TYPES.ONCHAIN,
    signal,
    confidence,
    reasoning: `[온체인] ${reasoning}`,
    metadata:  {
      fearGreed:      fearGreed?.value,
      fgClass:        fearGreed?.classification,
      fundingRate:    funding?.fundingRate,
      longShortRatio: lsRatio?.longShortRatio,
      openInterest:   openInterest?.openInterest,
    },
  });
  console.log(`  ✅ [오라클] DB 저장 완료`);

  return { symbol, signal, confidence, reasoning, fearGreed, funding, lsRatio };
}

// CLI 실행
if (require.main === module) {
  const args   = process.argv.slice(2);
  const symbol = args.find(a => a.startsWith('--symbol='))?.split('=')[1] || 'BTC/USDT';

  db.initSchema()
    .then(() => analyzeOnchain(symbol))
    .then(r => { console.log('\n결과:', JSON.stringify(r, null, 2)); process.exit(0); })
    .catch(e => { console.error('❌ 오라클 오류:', e.message); process.exit(1); });
}

module.exports = { analyzeOnchain, fetchFearGreed, fetchFundingRate, fetchLongShortRatio, fetchOpenInterest };
