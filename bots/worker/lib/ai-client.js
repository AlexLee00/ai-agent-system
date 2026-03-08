'use strict';

/**
 * bots/worker/lib/ai-client.js — 워커팀 LLM 호출 클라이언트
 *
 * llm-router.js가 선택한 모델에 따라 Groq 또는 Anthropic API 호출
 */

const https = require('https');

function httpsPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const data    = JSON.stringify(body);
    const urlObj  = new URL(url);
    const req     = https.request({
      hostname: urlObj.hostname,
      path:     urlObj.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
    }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(out) }); }
        catch { resolve({ status: res.statusCode, body: out }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * LLM 호출
 * @param {string} model   llm-router가 반환한 모델 ID ('groq/...' 또는 'claude-...')
 * @param {string} system  시스템 프롬프트
 * @param {string} user    사용자 프롬프트
 * @param {number} [maxTokens=1024]
 * @returns {Promise<string>}
 */
async function callLLM(model, system, user, maxTokens = 1024) {
  if (model.startsWith('groq/')) {
    const groqModel = model.replace('groq/', '');
    const apiKey    = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error('GROQ_API_KEY 환경변수 없음');
    const res = await httpsPost(
      'https://api.groq.com/openai/v1/chat/completions',
      { Authorization: `Bearer ${apiKey}` },
      {
        model:    groqModel,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        max_tokens: maxTokens,
      }
    );
    const text = res.body?.choices?.[0]?.message?.content;
    if (!text) throw new Error(`Groq 응답 없음 (status ${res.status})`);
    return text;
  } else {
    // Anthropic (claude-*)
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY 환경변수 없음');
    const res = await httpsPost(
      'https://api.anthropic.com/v1/messages',
      { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      {
        model,
        system,
        messages:   [{ role: 'user', content: user }],
        max_tokens: maxTokens,
      }
    );
    const text = res.body?.content?.[0]?.text;
    if (!text) throw new Error(`Anthropic 응답 없음 (status ${res.status}): ${JSON.stringify(res.body)}`);
    return text;
  }
}

/**
 * Groq 우선 → Haiku 폴백 LLM 호출
 * @param {string} groqModel  Groq 모델 ID (prefix 없이)
 * @param {string} system
 * @param {string} user
 * @param {number} [maxTokens=1024]
 * @returns {Promise<{ text: string, model: string }>}
 */
async function callLLMWithFallback(groqModel, system, user, maxTokens = 1024) {
  // 1차: Groq
  try {
    const text = await callLLM(`groq/${groqModel}`, system, user, maxTokens);
    return { text, model: `groq/${groqModel}` };
  } catch (e) {
    console.warn(`[ai-client] Groq 실패, Haiku 폴백: ${e.message}`);
  }
  // 2차: Claude Haiku
  const text = await callLLM('claude-haiku-4-5-20251001', system, user, maxTokens);
  return { text, model: 'claude-haiku-4-5-20251001' };
}

module.exports = { callLLM, callLLMWithFallback };
