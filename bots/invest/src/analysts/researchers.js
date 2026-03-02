'use strict';

/**
 * src/analysts/researchers.js — 강세/약세 리서처 (HedgeAgents 패턴)
 *
 * 참고: HedgeAgents (arXiv:2502.13165) — 토론 기반 멀티 에이전트 투자 판단
 *
 * 강세 리서처: 매수 관점 근거 + 목표가 제시
 * 약세 리서처: 매도 관점 근거 + 손절가 제시
 * → 두 의견을 최종 LLM(제이슨)에 전달 → 균형 잡힌 판단 유도
 *
 * 암호화폐 + 국내주식(KIS) 공통 지원
 */

const https = require('https');
const { logUsage } = require('../../lib/api-usage');
const { loadSecrets } = require('../../lib/secrets');

const MODEL = 'claude-haiku-4-5-20251001';

// ─── LLM 호출 ────────────────────────────────────────────────────────

function callResearcherLLM(systemPrompt, userMessage) {
  const secrets = loadSecrets();
  const apiKey  = secrets.anthropic_api_key || process.env.ANTHROPIC_API_KEY;

  if (!apiKey) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({
      model:       MODEL,
      max_tokens:  512,
      temperature: 0.2,
      system:      systemPrompt,
      messages:    [{ role: 'user', content: userMessage }],
    }));

    const start = Date.now();
    const req = https.request({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
        'content-length':    body.length,
      },
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        const latencyMs = Date.now() - start;
        try {
          const parsed = JSON.parse(raw);
          const usage  = parsed.usage || {};
          logUsage({
            provider:         'anthropic',
            model:            MODEL,
            promptTokens:     usage.input_tokens  || 0,
            completionTokens: usage.output_tokens || 0,
            latencyMs,
            caller:           'researchers',
            success:          !!parsed.content?.[0]?.text,
          });
          resolve(parsed.content?.[0]?.text || null);
        } catch (e) { reject(e); }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('리서처 API 타임아웃')); });
    req.write(body);
    req.end();
  });
}

// ─── 시스템 프롬프트 ─────────────────────────────────────────────────

const BULL_PROMPT_CRYPTO = `당신은 암호화폐 강세(Bullish) 리서처입니다.
주어진 시장 분석 데이터를 바탕으로 매수 관점의 근거를 제시하세요.
데이터에 근거해야 하며, 억지 낙관론은 금지입니다.

응답 형식 (JSON만, 마크다운 없음):
{"target_price":숫자,"stop_loss":숫자,"upside_pct":숫자,"reasoning":"매수 근거 2문장 (한국어)","key_catalysts":["촉매1","촉매2"]}`;

const BEAR_PROMPT_CRYPTO = `당신은 암호화폐 약세(Bearish) 리서처입니다.
주어진 시장 분석 데이터를 바탕으로 매도/관망 관점의 근거를 제시하세요.
데이터에 근거해야 하며, 억지 비관론은 금지입니다.

응답 형식 (JSON만, 마크다운 없음):
{"target_price":숫자,"stop_loss":숫자,"downside_pct":숫자,"reasoning":"매도 근거 2문장 (한국어)","key_risks":["리스크1","리스크2"]}`;

const BULL_PROMPT_KIS = `당신은 한국 주식시장 강세(Bullish) 리서처입니다.
주어진 기술지표 분석 데이터를 바탕으로 매수 관점의 근거를 제시하세요.
데이터에 근거해야 하며, 억지 낙관론은 금지입니다.

응답 형식 (JSON만, 마크다운 없음):
{"target_price":숫자,"stop_loss":숫자,"upside_pct":숫자,"reasoning":"매수 근거 2문장 (한국어)","key_catalysts":["촉매1","촉매2"]}

주의: target_price·stop_loss는 KRW 단위, 가격제한폭 ±30% 고려`;

const BEAR_PROMPT_KIS = `당신은 한국 주식시장 약세(Bearish) 리서처입니다.
주어진 기술지표 분석 데이터를 바탕으로 매도/관망 관점의 근거를 제시하세요.
데이터에 근거해야 하며, 억지 비관론은 금지입니다.

응답 형식 (JSON만, 마크다운 없음):
{"target_price":숫자,"stop_loss":숫자,"downside_pct":숫자,"reasoning":"매도 근거 2문장 (한국어)","key_risks":["리스크1","리스크2"]}

주의: target_price·stop_loss는 KRW 단위, 가격제한폭 ±30% 고려`;

// ─── 파싱 ────────────────────────────────────────────────────────────

function parseResponse(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw.replace(/```json?\n?|\n?```/g, '').trim());
  } catch {
    return null;
  }
}

// ─── 강세 리서처 ─────────────────────────────────────────────────────

/**
 * 강세 리서처 — 매수 근거 + 목표가 제시
 * @param {string} symbol
 * @param {string} analysisSummary   TA+온체인+뉴스+감성 요약 텍스트
 * @param {number|null} currentPrice
 * @param {string} exchange          'binance' | 'kis'
 * @returns {Promise<{targetPrice,stopLoss,upsidePct,reasoning,keyCatalysts}|null>}
 */
async function runBullResearcher(symbol, analysisSummary, currentPrice, exchange = 'binance') {
  const marketLabel  = exchange === 'kis' ? '국내주식' : '암호화폐';
  const priceUnit    = exchange === 'kis' ? 'KRW' : 'USD';
  const systemPrompt = exchange === 'kis' ? BULL_PROMPT_KIS : BULL_PROMPT_CRYPTO;

  const priceStr = currentPrice ? `${currentPrice.toLocaleString()} ${priceUnit}` : '정보 없음';
  const userMsg  = `심볼: ${symbol} (${marketLabel}) | 현재가: ${priceStr}\n\n시장 분석 데이터:\n${analysisSummary}\n\n강세 관점 투자 의견을 제시하세요.`;

  const raw    = await callResearcherLLM(systemPrompt, userMsg);
  const parsed = parseResponse(raw);
  if (!parsed) return null;

  return {
    targetPrice:  parsed.target_price,
    stopLoss:     parsed.stop_loss,
    upsidePct:    parsed.upside_pct,
    reasoning:    parsed.reasoning,
    keyCatalysts: parsed.key_catalysts || [],
  };
}

// ─── 약세 리서처 ─────────────────────────────────────────────────────

/**
 * 약세 리서처 — 매도 근거 + 손절가 제시
 * @param {string} symbol
 * @param {string} analysisSummary
 * @param {number|null} currentPrice
 * @param {string} exchange
 * @returns {Promise<{targetPrice,stopLoss,downsidePct,reasoning,keyRisks}|null>}
 */
async function runBearResearcher(symbol, analysisSummary, currentPrice, exchange = 'binance') {
  const marketLabel  = exchange === 'kis' ? '국내주식' : '암호화폐';
  const priceUnit    = exchange === 'kis' ? 'KRW' : 'USD';
  const systemPrompt = exchange === 'kis' ? BEAR_PROMPT_KIS : BEAR_PROMPT_CRYPTO;

  const priceStr = currentPrice ? `${currentPrice.toLocaleString()} ${priceUnit}` : '정보 없음';
  const userMsg  = `심볼: ${symbol} (${marketLabel}) | 현재가: ${priceStr}\n\n시장 분석 데이터:\n${analysisSummary}\n\n약세 관점 투자 의견을 제시하세요.`;

  const raw    = await callResearcherLLM(systemPrompt, userMsg);
  const parsed = parseResponse(raw);
  if (!parsed) return null;

  return {
    targetPrice: parsed.target_price,
    stopLoss:    parsed.stop_loss,
    downsidePct: parsed.downside_pct,
    reasoning:   parsed.reasoning,
    keyRisks:    parsed.key_risks || [],
  };
}

module.exports = { runBullResearcher, runBearResearcher };
