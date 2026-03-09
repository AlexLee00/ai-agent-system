'use strict';

/**
 * packages/core/lib/chunked-llm.js — 분할 생성 유틸리티
 *
 * 무료 LLM API(Gemini Flash)로 장문 콘텐츠를 생성하기 위한 청크 호출 래퍼.
 * 섹션 그룹별로 나눠서 호출하고, 이전 맥락(마지막 N자)을 전달하여 연결성 유지.
 *
 * 지원 모델:
 *   gemini — google/gemini-2.5-flash (무료, 기본)
 *   gpt4o  — openai/gpt-4o (유료, 폴백)
 */

const https = require('https');
const { getOpenAIKey, getGeminiKey } = require('./llm-keys');

// ─── Gemini Flash 호출 ──────────────────────────────────────────────

async function callGemini(systemPrompt, userPrompt, maxTokens = 4096) {
  const apiKey = getGeminiKey();
  if (!apiKey) throw new Error('GEMINI_API_KEY 없음 (환경변수 또는 config.yaml 확인)');

  const body = JSON.stringify({
    contents: [{ parts: [{ text: userPrompt }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.75 },
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path:     `/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${apiKey}`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json' },
      timeout:  90000,
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json   = JSON.parse(data);
          const text   = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
          const usage  = json?.usageMetadata || {};
          if (!text) {
            const reason = json?.candidates?.[0]?.finishReason || JSON.stringify(json).slice(0, 200);
            reject(new Error(`Gemini 빈 응답: ${reason}`));
          } else {
            resolve({
              text,
              inputTokens:  usage.promptTokenCount    || 0,
              outputTokens: usage.candidatesTokenCount || 0,
            });
          }
        } catch (e) { reject(new Error('Gemini 응답 파싱 실패: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Gemini 타임아웃(90s)')); });
    req.write(body);
    req.end();
  });
}

// ─── GPT-4o 폴백 호출 ──────────────────────────────────────────────

async function callGpt4o(systemPrompt, userPrompt, maxTokens = 4096) {
  const OpenAI = require('openai');
  const openai = new OpenAI({ apiKey: getOpenAIKey() });
  const res    = await openai.chat.completions.create({
    model: 'gpt-4o', max_tokens: maxTokens, temperature: 0.75,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt   },
    ],
  });
  return {
    text:         res.choices[0]?.message?.content || '',
    inputTokens:  res.usage?.prompt_tokens         || 0,
    outputTokens: res.usage?.completion_tokens     || 0,
  };
}

// ─── 분할 생성 실행 ─────────────────────────────────────────────────

/**
 * 여러 청크를 순차 호출하고 합쳐서 하나의 콘텐츠 반환
 *
 * @param {string} systemPrompt — 전체 공유 시스템 프롬프트
 * @param {Array<{ id, prompt, minChars }>} chunks
 * @param {object} [options]
 *   - model: 'gemini' | 'gpt4o' (기본 'gemini')
 *   - contextCarry: 이전 청크 마지막 N자 전달 (기본 200)
 *   - maxRetries: 청크별 재시도 (기본 1)
 *   - onChunkComplete: ({ id, charCount, index }) => void
 * @returns {{ content, charCount, chunks, totalTokens }}
 */
async function chunkedGenerate(systemPrompt, chunks, options = {}) {
  const {
    model          = 'gemini',
    contextCarry   = 200,
    maxRetries     = 1,
    onChunkComplete,
  } = options;

  const results    = [];
  let previousTail = '';
  let totalInput   = 0;
  let totalOutput  = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    // 이전 청크 마지막 N자를 맥락으로 전달
    const contextPrefix = previousTail
      ? `\n[이전 섹션의 마지막 부분 — 자연스럽게 이어서 작성하라]\n...${previousTail}\n\n`
      : '';
    const fullPrompt = contextPrefix + chunk.prompt;

    let bestResult = null;
    let attempts   = 0;

    while (attempts <= maxRetries) {
      try {
        console.log(`[분할생성] 청크 ${chunk.id} (${i + 1}/${chunks.length})${attempts > 0 ? ` 재시도${attempts}` : ''}`);

        const result = model === 'gpt4o'
          ? await callGpt4o(systemPrompt, fullPrompt, 4096)
          : await callGemini(systemPrompt, fullPrompt, 4096);

        const charCount = result.text.length;
        console.log(`[분할생성] 청크 ${chunk.id}: ${charCount}자`);

        if (chunk.minChars && charCount < chunk.minChars && attempts < maxRetries) {
          console.log(`[분할생성] 청크 ${chunk.id}: ${charCount}자 < 최소 ${chunk.minChars}자 — 재시도`);
          attempts++;
          continue;
        }

        bestResult = result;
        break;
      } catch (e) {
        console.warn(`[분할생성] 청크 ${chunk.id} 실패: ${e.message}`);
        if (attempts >= maxRetries) throw e;
        attempts++;
      }
    }

    if (!bestResult) throw new Error(`청크 ${chunk.id} 생성 실패`);

    totalInput  += bestResult.inputTokens;
    totalOutput += bestResult.outputTokens;

    results.push({ id: chunk.id, content: bestResult.text, charCount: bestResult.text.length, model });
    previousTail = bestResult.text.slice(-contextCarry);

    if (onChunkComplete) onChunkComplete({ id: chunk.id, charCount: bestResult.text.length, index: i });
  }

  const fullContent = results.map(r => r.content).join('\n\n━━━━━━━━━━━━━━━━━━━━━\n\n');

  return {
    content:     fullContent,
    charCount:   fullContent.length,
    chunks:      results,
    totalTokens: { input: totalInput, output: totalOutput },
  };
}

module.exports = { chunkedGenerate, callGemini, callGpt4o };
