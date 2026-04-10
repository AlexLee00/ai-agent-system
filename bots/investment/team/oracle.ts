// @ts-nocheck
/**
 * team/oracle.js — 오라클 (온체인·매크로 분석가)
 *
 * 역할: 온체인 + 파생상품 데이터 분석
 * LLM: Groq Scout (paper+live 모두 무료)
 * 소스: alternative.me (공포탐욕) + Binance Futures (펀딩비·L/S·OI)
 *
 * 실행: node team/oracle.js --symbol=BTC/USDT
 */

import https from 'https';
import * as db from '../shared/db.ts';
import { callLLM, parseJSON } from '../shared/llm-client.ts';
import { ANALYST_TYPES, ACTIONS } from '../shared/signal.ts';
import { fileURLToPath } from 'url';
import { getFundingRate, getOpenInterest, getLongShortRatio } from '../shared/onchain-data.ts';

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

export async function fetchFearGreed() {
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

// fetchFundingRate, fetchLongShortRatio, fetchOpenInterest → shared/onchain-data.js로 이전
export { getFundingRate as fetchFundingRate, getLongShortRatio as fetchLongShortRatio, getOpenInterest as fetchOpenInterest };

// ─── 규칙 기반 판단 (LLM fallback) ─────────────────────────────────

function ruleBasedSignal(fearGreed, funding, lsRatio) {
  let score = 0;
  const factors = [];

  if (fearGreed) {
    if (fearGreed.value <= 20)      { score += 1.5; factors.push(`극도의 공포 (${fearGreed.value})`); }
    else if (fearGreed.value >= 80) { score -= 1.5; factors.push(`극도의 탐욕 (${fearGreed.value})`); }
    else if (fearGreed.value <= 40) { score += 0.5; factors.push(`공포 (${fearGreed.value})`); }
    else if (fearGreed.value >= 60) { score -= 0.5; factors.push(`탐욕 (${fearGreed.value})`); }
    else                             { factors.push(`중립 (${fearGreed.value})`); }
  }

  if (funding) {
    const fPct = funding.fundingRate * 100;
    if (fPct > 0.05)       { score -= 1.0; factors.push(`펀딩비 과열 (+${fPct.toFixed(4)}%)`); }
    else if (fPct < -0.01) { score += 1.0; factors.push(`펀딩비 음수 (${fPct.toFixed(4)}%)`); }
    else                    { factors.push(`펀딩비 중립 (${fPct.toFixed(4)}%)`); }
  }

  if (lsRatio) {
    if (lsRatio.longShortRatio > 1.8)      { score -= 0.5; factors.push(`롱 과도 (${lsRatio.longShortRatio.toFixed(2)})`); }
    else if (lsRatio.longShortRatio < 0.8) { score += 0.5; factors.push(`숏 과도 (${lsRatio.longShortRatio.toFixed(2)})`); }
    else                                    { factors.push(`L/S 균형 (${lsRatio.longShortRatio.toFixed(2)})`); }
  }

  const maxScore   = 3.0;
  const confidence = Math.min(Math.abs(score) / maxScore, 1);
  const signal     = score >= 1.0 ? ACTIONS.BUY : score <= -1.0 ? ACTIONS.SELL : ACTIONS.HOLD;
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

export async function analyzeOnchain(symbol = 'BTC/USDT') {
  const futureSymbol = symbol.replace('/', '');
  console.log(`\n🔗 [오라클] ${symbol} 온체인 데이터 수집 중...`);

  const [fearGreed, funding, lsRatio, openInterest] = await Promise.all([
    fetchFearGreed(),
    getFundingRate(futureSymbol),
    getLongShortRatio(futureSymbol),
    getOpenInterest(futureSymbol),
  ]);

  console.log(`  공포탐욕지수: ${fearGreed ? `${fearGreed.value} (${fearGreed.classification})` : 'N/A'}`);
  console.log(`  펀딩비: ${funding ? `${(funding.fundingRate * 100).toFixed(4)}%` : 'N/A'}`);
  console.log(`  Long/Short: ${lsRatio ? `${lsRatio.longShortRatio.toFixed(2)}` : 'N/A'}`);
  console.log(`  미결제약정: ${openInterest ? `${parseFloat(openInterest.openInterest).toLocaleString()}` : 'N/A'}`);

  const userMsg = [
    `심볼: ${symbol}`,
    fearGreed    ? `공포탐욕지수: ${fearGreed.value} (${fearGreed.classification})` : '',
    funding      ? `펀딩비: ${(funding.fundingRate * 100).toFixed(4)}%` : '',
    lsRatio      ? `Long/Short 비율: ${lsRatio.longShortRatio.toFixed(2)} (롱 ${(lsRatio.longAccount * 100).toFixed(1)}%)` : '',
    openInterest ? `미결제약정: ${parseFloat(openInterest.openInterest).toLocaleString()} ${futureSymbol.replace('USDT', '')}` : '',
  ].filter(Boolean).join('\n');

  let signal, confidence, reasoning;
  const responseText = await callLLM('oracle', SYSTEM_PROMPT, userMsg, 200, { symbol });
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
    exchange:  'binance',
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
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args   = process.argv.slice(2);
  const symbol = args.find(a => a.startsWith('--symbol='))?.split('=')[1] || 'BTC/USDT';

  db.initSchema()
    .then(() => analyzeOnchain(symbol))
    .then(r => { console.log('\n결과:', JSON.stringify(r, null, 2)); process.exit(0); })
    .catch(e => { console.error('❌ 오라클 오류:', e.message); process.exit(1); });
}
