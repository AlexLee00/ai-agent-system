'use strict';

/**
 * lib/groq.js — 무료 LLM API 클라이언트 (멀티 프로바이더)
 *
 * 지원 프로바이더 (모두 OpenAI 호환, 무료 플랜):
 *   groq      — api.groq.com        (secrets: groq_api_key)
 *   cerebras  — api.cerebras.ai     (secrets: cerebras_api_key)
 *   sambanova — api.sambanova.ai    (secrets: sambanova_api_key)
 *
 * 분석가별 프로바이더 분산 (일일 쿼타 초과 방지):
 *   뉴스분석가  → groq     / llama-3.1-8b-instant      (500k TPD)
 *   온체인분석가→ cerebras / llama3.1-8b               (1M TPD)
 *   감성분석가  → sambanova/ Meta-Llama-3.3-70B-Instruct
 *   시그널집계  → anthropic/ claude-haiku-4-5 (별도 callClaudeAPI)
 *
 * 키 미설정 시 groq → 규칙 기반 fallback 순으로 강등
 */

const https = require('https');
const fs    = require('fs');
const os    = require('os');
const path  = require('path');
const { loadSecrets } = require('./secrets');
const { logUsage }    = require('./api-usage');

// 속도 테스트 결과 파일 (speed-test --luna --apply 로 갱신)
const LUNA_BEST_FILE = path.join(os.homedir(), '.openclaw', 'luna-llm-best.json');

/** speed-test 결과 기반 분석가별 최적 모델 조회 */
function getLunaBestModel(caller) {
  try {
    const data = JSON.parse(fs.readFileSync(LUNA_BEST_FILE, 'utf-8'));
    return data.best?.[caller] || null; // { provider, model, ttft }
  } catch { return null; }
}

// OpenAI 호환 엔드포인트
const PROVIDERS = {
  groq:      { host: 'api.groq.com',       path: '/openai/v1/chat/completions',  secretKey: 'groq_api_key',      envKey: 'GROQ_API_KEY' },
  cerebras:  { host: 'api.cerebras.ai',    path: '/v1/chat/completions',          secretKey: 'cerebras_api_key',  envKey: 'CEREBRAS_API_KEY' },
  sambanova: { host: 'api.sambanova.ai',   path: '/v1/chat/completions',          secretKey: 'sambanova_api_key', envKey: 'SAMBANOVA_API_KEY' },
};

// 프로바이더별 기본 모델
const DEFAULT_MODELS = {
  groq:      'llama-3.1-8b-instant',
  cerebras:  'llama3.1-8b',
  sambanova: 'Meta-Llama-3.3-70B-Instruct',
};

/**
 * API 키 조회 (secrets.json → env → null 순)
 */
function getApiKey(provider) {
  const cfg = PROVIDERS[provider];
  if (!cfg) return null;
  const secrets = loadSecrets();
  return secrets[cfg.secretKey] || process.env[cfg.envKey] || null;
}

/**
 * OpenAI 호환 API 호출 (내부 공통 함수)
 */
function callOpenAICompat({ provider, model, systemPrompt, userMessage, caller }) {
  const cfg    = PROVIDERS[provider];
  const apiKey = getApiKey(provider);

  if (!apiKey) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({
      model,
      max_tokens:  256,
      temperature: 0.1,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMessage },
      ],
    }));

    const start = Date.now();

    const req = https.request({
      hostname: cfg.host,
      path:     cfg.path,
      method:   'POST',
      headers: {
        'Authorization':  `Bearer ${apiKey}`,
        'Content-Type':   'application/json',
        'Content-Length': body.length,
      },
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        const latencyMs = Date.now() - start;
        try {
          const parsed = JSON.parse(raw);
          if (parsed.error) {
            console.error(`⚠️ ${provider} API 오류:`, parsed.error.message);
            logUsage({ provider, model, latencyMs, caller, success: false });
            resolve(null);
          } else {
            const usage = parsed.usage || {};
            logUsage({
              provider,
              model,
              promptTokens:     usage.prompt_tokens     || 0,
              completionTokens: usage.completion_tokens || 0,
              totalTokens:      usage.total_tokens      || 0,
              latencyMs,
              caller,
              success: true,
            });
            resolve(parsed.choices?.[0]?.message?.content || null);
          }
        } catch (e) { reject(e); }
      });
    });

    req.on('error', (e) => {
      logUsage({ provider, model, latencyMs: Date.now() - start, caller, success: false });
      reject(e);
    });
    req.setTimeout(15000, () => {
      req.destroy();
      logUsage({ provider, model, latencyMs: 15000, caller, success: false });
      reject(new Error(`${provider} API 타임아웃`));
    });
    req.write(body);
    req.end();
  });
}

/**
 * 무료 LLM API 호출 (프로바이더 지정 + 키 없으면 groq 자동 fallback)
 *
 * @param {string} systemPrompt  시스템 프롬프트
 * @param {string} userMessage   사용자 메시지
 * @param {string} model         모델 ID (생략 시 프로바이더 기본값)
 * @param {string} caller        호출 모듈명 (사용량 로그용)
 * @param {string} provider      프로바이더 ('groq'|'cerebras'|'sambanova')
 * @returns {Promise<string|null>}
 */
async function callGroqAPI(
  systemPrompt,
  userMessage,
  model    = 'llama-3.1-8b-instant',
  caller   = '',
  provider = 'groq',
) {
  // speed-test 결과 기반 최적 모델 우선 적용
  const lunasBest = getLunaBestModel(caller);
  if (lunasBest) {
    provider = lunasBest.provider;
    model    = lunasBest.model;
  }

  // 요청 프로바이더 시도
  if (PROVIDERS[provider]) {
    const key = getApiKey(provider);
    if (key) {
      const m = model || DEFAULT_MODELS[provider];
      const result = await callOpenAICompat({ provider, model: m, systemPrompt, userMessage, caller });
      if (result !== null) return result;
      console.warn(`  ⚠️ ${provider} 응답 없음 — groq fallback`);
    } else {
      console.warn(`  ⚠️ ${provider} API 키 없음 — groq fallback`);
    }
  }

  // groq fallback
  if (provider !== 'groq') {
    const groqKey = getApiKey('groq');
    if (groqKey) {
      const fallbackModel = DEFAULT_MODELS.groq;
      console.warn(`  ↩️  groq/${fallbackModel} 으로 대체`);
      return callOpenAICompat({
        provider: 'groq', model: fallbackModel,
        systemPrompt, userMessage, caller: `${caller}[groq-fallback]`,
      });
    }
  }

  console.warn('⚠️ 무료 LLM API 키 없음 — 규칙 기반 판단으로 대체');
  return null;
}

module.exports = { callGroqAPI, getApiKey, PROVIDERS, DEFAULT_MODELS };
