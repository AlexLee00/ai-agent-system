// @ts-nocheck
/**
 * team/athena.js — 아테나 (약세 리서처)
 *
 * 역할: 매도 관점 근거 + 손절가 제시
 * LLM: Groq Scout (paper) / Groq Scout (live) — 비용 무료
 *
 * 실행: node team/athena.js (단독 실행 불가 — luna.js에서 호출)
 */

import { callLLM, parseJSON } from '../shared/llm-client.ts';

const PROMPTS = {
  binance: `당신은 암호화폐 약세(Bearish) 리서처입니다.
주어진 시장 분석 데이터를 바탕으로 매도/관망 관점의 근거를 제시하세요.
데이터에 근거해야 하며, 억지 비관론은 금지입니다.

응답 형식 (JSON만, 마크다운 없음):
{"target_price":숫자,"stop_loss":숫자,"downside_pct":숫자,"confidence":0.0~1.0,"reasoning":"매도 근거 2문장 (한국어)","key_risks":["리스크1","리스크2"]}
confidence: 0.5=중립, 0.7+=확신, 0.9+=매우 확신`,

  kis_overseas: `당신은 미국 주식시장 약세(Bearish) 리서처입니다.
주어진 기술지표 분석 데이터를 바탕으로 매도/관망 관점의 근거를 제시하세요.
데이터에 근거해야 하며, 억지 비관론은 금지입니다.

응답 형식 (JSON만, 마크다운 없음):
{"target_price":숫자,"stop_loss":숫자,"downside_pct":숫자,"confidence":0.0~1.0,"reasoning":"매도 근거 2문장 (한국어)","key_risks":["리스크1","리스크2"]}

주의: target_price·stop_loss는 USD 단위. 매크로 리스크(연준·경기침체) 우선 고려.`,

  kis: `당신은 한국 주식시장 약세(Bearish) 리서처입니다.
주어진 기술지표 분석 데이터를 바탕으로 매도/관망 관점의 근거를 제시하세요.
데이터에 근거해야 하며, 억지 비관론은 금지입니다.

응답 형식 (JSON만, 마크다운 없음):
{"target_price":숫자,"stop_loss":숫자,"downside_pct":숫자,"confidence":0.0~1.0,"reasoning":"매도 근거 2문장 (한국어)","key_risks":["리스크1","리스크2"]}

주의: target_price·stop_loss는 KRW 단위, 가격제한폭 ±30% 고려.`,
};

/**
 * 약세 리서처 — 매도 근거 + 손절가
 * @param {string} symbol
 * @param {string} analysisSummary
 * @param {number|null} currentPrice
 * @param {string} exchange  'binance' | 'kis_overseas' | 'kis'
 */
export async function runBearResearcher(symbol, analysisSummary, currentPrice, exchange = 'binance') {
  const label    = exchange === 'kis' ? '국내주식' : exchange === 'kis_overseas' ? '미국주식' : '암호화폐';
  const unit     = exchange === 'kis' ? 'KRW' : 'USD';
  const priceStr = currentPrice ? `${currentPrice.toLocaleString()} ${unit}` : '정보 없음';
  const prompt   = PROMPTS[exchange] || PROMPTS.binance;
  const userMsg  = `심볼: ${symbol} (${label}) | 현재가: ${priceStr}\n\n시장 분석:\n${analysisSummary}\n\n약세 관점 투자 의견을 제시하세요.`;

  const raw    = await callLLM('athena', prompt, userMsg, 300, { symbol });
  const parsed = parseJSON(raw);
  if (!parsed) return null;

  return {
    targetPrice: parsed.target_price,
    stopLoss:    parsed.stop_loss,
    downsidePct: parsed.downside_pct,
    confidence:  parsed.confidence ?? Math.min(Math.abs(parsed.downside_pct || 0) / 20, 0.90),
    reasoning:   parsed.reasoning,
    keyRisks:    parsed.key_risks || [],
  };
}
