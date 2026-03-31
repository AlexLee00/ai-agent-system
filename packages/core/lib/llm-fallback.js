'use strict';

/**
 * packages/core/lib/llm-fallback.js — 공통 LLM 폴백 체인 실행기
 *
 * 여러 provider를 순서대로 시도하여 첫 번째 성공 응답을 반환.
 * 실패 시 다음 provider로 자동 넘어감.
 *
 * 지원 provider:
 *   anthropic — claude-sonnet-4-6 등 (Anthropic SDK)
 *   openai    — gpt-4o
 *   groq      — llama-4-scout 등 (Groq SDK / OpenAI-compat)
 *   gemini    — gemini-2.5-flash (Google Generative AI SDK)
 *
 * 사용법:
 *   const { callWithFallback } = require('../../../packages/core/lib/llm-fallback');
 *   const result = await callWithFallback({
 *     chain: [
 *       { provider: 'anthropic', model: 'claude-sonnet-4-6', maxTokens: 300, temperature: 0.1 },
 *       { provider: 'openai',    model: 'gpt-4o',            maxTokens: 300 },
 *       { provider: 'groq',      model: 'openai/gpt-oss-20b', maxTokens: 300 },
 *     ],
 *     systemPrompt,
 *     userPrompt,
 *     logMeta: { team: 'claude', bot: 'lead-brain', requestType: 'system_issue_triage' },
 *   });
 *   // result: { text: string, provider, model, attempt }
 */

const { getAnthropicKey, getOpenAIKey, getGeminiKey, getGroqAccounts } = require('./llm-keys');
const { logLLMCall } = require('./llm-logger');
const billingGuard = require('./billing-guard');
const { trackTokens } = require('./token-tracker');

// ── 그루크 계정 라운드로빈 인덱스 ────────────────────────────────────
let _groqIdx = 0;

// ── 응답 텍스트 정규화 ────────────────────────────────────────────────
function _extractText(resp, provider) {
  if (provider === 'anthropic') {
    return resp?.content?.[0]?.text?.trim() || '';
  }
  if (provider === 'openai' || provider === 'groq') {
    return resp?.choices?.[0]?.message?.content?.trim() || '';
  }
  if (provider === 'gemini') {
    // SDK v0.21+ 응답 구조: resp.response.text()
    return resp?.response?.text?.()?.trim()
      || resp?.text?.()?.trim()
      || resp?.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
      || '';
  }
  return '';
}

// ── provider별 단건 호출 ─────────────────────────────────────────────

async function _callAnthropic({ model, maxTokens, temperature = 0.1, systemPrompt, userPrompt }) {
  const apiKey = getAnthropicKey();
  if (!apiKey) throw new Error('Anthropic API 키 없음');
  const Anthropic = require('@anthropic-ai/sdk');
  const { getTimeout } = require('./llm-timeouts');
  const client = new Anthropic({ apiKey, timeout: getTimeout(model), maxRetries: 1 });
  return client.messages.create({
    model,
    max_tokens:  maxTokens,
    temperature,
    system:      systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });
}

async function _callOpenAI({ model, maxTokens, temperature = 0.1, systemPrompt, userPrompt, baseURL }) {
  const apiKey = getOpenAIKey();
  if (!apiKey) throw new Error('OpenAI API 키 없음');
  const OpenAI = require('openai');
  const opts = { apiKey };
  if (baseURL) opts.baseURL = baseURL;
  const client = new OpenAI(opts);
  return client.chat.completions.create({
    model,
    max_tokens:  maxTokens,
    temperature,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ],
  });
}

async function _groqSingleCall(apiKey, groqModel, maxTokens, temperature, systemPrompt, userPrompt) {
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey, baseURL: 'https://api.groq.com/openai/v1' });
  // gpt-oss-20b는 추론(reasoning) 모델 — reasoning_effort:low로 내부 추론 토큰 최소화
  const isReasoning = groqModel.includes('gpt-oss-20b');
  const params = {
    model:      groqModel,
    max_tokens: maxTokens,
    temperature,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ],
  };
  if (isReasoning) params.reasoning_effort = 'low';
  return client.chat.completions.create(params);
}

async function _callGroq({ model, maxTokens, temperature = 0.1, systemPrompt, userPrompt }) {
  // groq/ 외부 네임스페이스만 제거
  const groqModel  = model.replace(/^groq\//, '');
  const accounts   = getGroqAccounts();

  // 계정 목록 없으면 환경변수 키로 1회 시도
  if (!accounts.length) {
    const envKey = process.env.GROQ_API_KEY;
    if (!envKey) throw new Error('Groq API 키 없음');
    return _groqSingleCall(envKey, groqModel, maxTokens, temperature, systemPrompt, userPrompt);
  }

  // 최대 3개 키 순회하며 429 retry
  const maxRetry = Math.min(accounts.length, 3);
  let lastError;

  for (let i = 0; i < maxRetry; i++) {
    const apiKey = accounts[(_groqIdx + i) % accounts.length]?.api_key;
    if (!apiKey) continue;
    try {
      const result = await _groqSingleCall(apiKey, groqModel, maxTokens, temperature, systemPrompt, userPrompt);
      _groqIdx = (_groqIdx + i + 1) % accounts.length;  // 성공 키 다음부터 시작
      return result;
    } catch (e) {
      lastError = e;
      const is429 = e.status === 429 || e.message?.includes('429') || e.message?.includes('rate_limit');
      if (is429) {
        console.warn(`  ⚠️ [Groq] 429 rate limit → 키 ${i + 1}/${maxRetry} 실패, 다음 키 시도...`);
        continue;
      }
      throw e;  // 429 외 오류는 즉시 throw
    }
  }

  throw lastError || new Error('Groq 전체 키 소진 (429)');
}

async function _callGemini({ model, maxTokens, temperature = 0.1, systemPrompt, userPrompt }) {
  const apiKey = getGeminiKey();
  if (!apiKey) throw new Error('Gemini API 키 없음');
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genai  = new GoogleGenerativeAI(apiKey);
  const gemini = genai.getGenerativeModel({
    model: model.replace(/^google-gemini-cli\//, ''),
    systemInstruction: systemPrompt,
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature,
      thinkingConfig: { thinkingBudget: 0 },  // thinking 비활성 (단순 생성 태스크)
    },
  });
  return gemini.generateContent(userPrompt);
}

// ── provider 디스패처 ─────────────────────────────────────────────────

async function _callProvider(cfg, systemPrompt, userPrompt) {
  const { provider, model, maxTokens, temperature } = cfg;
  const opts = { model, maxTokens, temperature, systemPrompt, userPrompt };

  switch (provider) {
    case 'anthropic': {
      const resp = await _callAnthropic(opts);
      return { raw: resp, text: _extractText(resp, 'anthropic'), usage: resp.usage };
    }
    case 'openai': {
      const resp = await _callOpenAI(opts);
      return { raw: resp, text: _extractText(resp, 'openai'), usage: resp.usage };
    }
    case 'groq': {
      const resp = await _callGroq(opts);
      return { raw: resp, text: _extractText(resp, 'groq'), usage: resp.usage };
    }
    case 'gemini': {
      const resp = await _callGemini(opts);
      return { raw: resp, text: _extractText(resp, 'gemini'), usage: null };
    }
    case 'local': {
      const localLLM = require('./local-llm-client');
      const result = await localLLM.callLocalLLM(model, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ], { maxTokens, temperature });
      if (!result) throw new Error('로컬 LLM 응답 없음');
      return { raw: null, text: result.trim(), usage: null };
    }
    default:
      throw new Error(`알 수 없는 provider: ${provider}`);
  }
}

// ── 메인 폴백 체인 실행 ───────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {Array<{provider, model, maxTokens, temperature}>} opts.chain
 * @param {string}   opts.systemPrompt
 * @param {string}   opts.userPrompt
 * @param {object}   [opts.logMeta]  { team, bot, requestType }
 * @returns {Promise<{text, provider, model, attempt}>}
 * @throws 모든 체인 실패 시 마지막 오류를 throw
 */
async function callWithFallback({ chain, systemPrompt, userPrompt, logMeta = {} }) {
  // ★ 긴급 차단 체크
  const guardScope = logMeta.team || 'global';
  if (billingGuard.isBlocked(guardScope)) {
    const r = billingGuard.getBlockReason(guardScope);
    throw new Error(`🚨 LLM 긴급 차단 중: ${r?.reason || '알 수 없음'} — 마스터 해제 필요`);
  }
  if (!chain || chain.length === 0) throw new Error('폴백 체인이 비어 있음');

  let lastError;
  for (let i = 0; i < chain.length; i++) {
    const cfg     = chain[i];
    const t0      = Date.now();
    const attempt = i + 1;
    try {
      const { text, usage } = await _callProvider(cfg, systemPrompt, userPrompt);
      const latencyMs = Date.now() - t0;

      // LLM 사용 로깅
      if (logMeta.team) {
        const tokensIn  = usage?.input_tokens  || usage?.prompt_tokens     || 0;
        const tokensOut = usage?.output_tokens || usage?.completion_tokens || 0;
        try {
          logLLMCall({
            team:         logMeta.team,
            bot:          logMeta.bot  || logMeta.team,
            model:        cfg.model,
            requestType:  logMeta.requestType,
            inputTokens:  tokensIn,
            outputTokens: tokensOut,
            latencyMs,
            success: true,
          });
        } catch { /* 로깅 실패 무시 */ }
        // 토큰 트래커 (비용 통계)
        trackTokens({
          bot:       logMeta.bot  || logMeta.team,
          team:      logMeta.team,
          model:     cfg.model,
          provider:  cfg.provider,
          taskType:  logMeta.requestType || 'unknown',
          tokensIn,
          tokensOut,
          durationMs: latencyMs,
        }).catch(() => {});
      }

      if (i > 0) {
        console.log(`  ↳ [폴백] ${cfg.provider}/${cfg.model} (시도 ${attempt}) 성공`);
      }

      return { text, provider: cfg.provider, model: cfg.model, attempt };

    } catch (e) {
      lastError = e;
      const latencyMs = Date.now() - t0;

      if (logMeta.team) {
        try {
          logLLMCall({
            team:        logMeta.team,
            bot:         logMeta.bot || logMeta.team,
            model:       cfg.model,
            requestType: logMeta.requestType,
            latencyMs,
            success:     false,
            errorMsg:    e.message?.slice(0, 200),
          });
        } catch { /* 로깅 실패 무시 */ }
      }

      const isLast = i === chain.length - 1;
      console.warn(`  ⚠️ [폴백] ${cfg.provider}/${cfg.model} (시도 ${attempt}) 실패: ${e.message?.slice(0, 80)}${isLast ? ' — 모든 폴백 소진' : ' → 다음 시도...'}`);
    }
  }

  throw lastError;
}

module.exports = { callWithFallback };
