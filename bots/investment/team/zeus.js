/**
 * team/zeus.js — 제우스 (강세 리서처)
 *
 * 역할: 매수 관점 근거 + 목표가 제시
 * LLM: Groq Scout (paper) / Groq Scout (live) — 비용 무료
 *
 * 실행: node team/zeus.js (단독 실행 불가 — luna.js에서 호출)
 */

import { callLLM, parseJSON } from '../shared/llm-client.js';

const PROMPTS = {
  binance: `당신은 암호화폐 강세(Bullish) 리서처입니다.
주어진 시장 분석 데이터를 바탕으로 매수 관점의 근거를 제시하세요.
데이터에 근거해야 하며, 억지 낙관론은 금지입니다.

응답 형식 (JSON만, 마크다운 없음):
{"target_price":숫자,"stop_loss":숫자,"upside_pct":숫자,"reasoning":"매수 근거 2문장 (한국어)","key_catalysts":["촉매1","촉매2"]}`,

  kis_overseas: `당신은 미국 주식시장 강세(Bullish) 리서처입니다.
주어진 기술지표 분석 데이터를 바탕으로 매수 관점의 근거를 제시하세요.
데이터에 근거해야 하며, 억지 낙관론은 금지입니다.

응답 형식 (JSON만, 마크다운 없음):
{"target_price":숫자,"stop_loss":숫자,"upside_pct":숫자,"reasoning":"매수 근거 2문장 (한국어)","key_catalysts":["촉매1","촉매2"]}

주의: target_price·stop_loss는 USD 단위 (소수점 2자리). S&P500·나스닥 추세 고려.`,

  kis: `당신은 한국 주식시장 강세(Bullish) 리서처입니다.
주어진 기술지표 분석 데이터를 바탕으로 매수 관점의 근거를 제시하세요.
데이터에 근거해야 하며, 억지 낙관론은 금지입니다.

응답 형식 (JSON만, 마크다운 없음):
{"target_price":숫자,"stop_loss":숫자,"upside_pct":숫자,"reasoning":"매수 근거 2문장 (한국어)","key_catalysts":["촉매1","촉매2"]}

주의: target_price·stop_loss는 KRW 단위, 가격제한폭 ±30% 고려.`,
};

/**
 * 강세 리서처 — 매수 근거 + 목표가
 * @param {string} symbol
 * @param {string} analysisSummary
 * @param {number|null} currentPrice
 * @param {string} exchange  'binance' | 'kis_overseas' | 'kis'
 */
export async function runBullResearcher(symbol, analysisSummary, currentPrice, exchange = 'binance') {
  const label    = exchange === 'kis' ? '국내주식' : exchange === 'kis_overseas' ? '미국주식' : '암호화폐';
  const unit     = exchange === 'kis' ? 'KRW' : 'USD';
  const priceStr = currentPrice ? `${currentPrice.toLocaleString()} ${unit}` : '정보 없음';
  const prompt   = PROMPTS[exchange] || PROMPTS.binance;
  const userMsg  = `심볼: ${symbol} (${label}) | 현재가: ${priceStr}\n\n시장 분석:\n${analysisSummary}\n\n강세 관점 투자 의견을 제시하세요.`;

  const raw    = await callLLM('zeus', prompt, userMsg, 512);
  const parsed = parseJSON(raw);
  if (!parsed) return null;

  return {
    targetPrice:  parsed.target_price,
    stopLoss:     parsed.stop_loss,
    upsidePct:    parsed.upside_pct,
    reasoning:    parsed.reasoning,
    keyCatalysts: parsed.key_catalysts || [],
  };
}
