'use strict';

/**
 * packages/core/lib/chunked-llm.js — 분할 생성 유틸리티
 *
 * 장문 콘텐츠를 섹션 그룹별로 나눠 호출하고,
 * 이전 청크 마지막 일부를 다음 청크 입력에 넘겨 연결성을 유지한다.
 * 실제 LLM 호출은 공용 llm-fallback 체인을 사용한다.
 */

const { callWithFallback } = require('./llm-fallback');
const { selectLLMChain } = require('./llm-model-selector');

function _buildChain(model, maxTokens) {
  if (Array.isArray(model)) return model;

  if (model === 'gpt4o') {
    return selectLLMChain('core.chunked.gpt4o', { maxTokens });
  }

  return selectLLMChain('core.chunked.default', { maxTokens });
}

async function chunkedGenerate(systemPrompt, chunks, options = {}) {
  const {
    model = 'gemini',
    contextCarry = 200,
    maxRetries = 1,
    timeoutMs,
    onChunkComplete,
    logMeta = {},
  } = options;

  const results = [];
  let previousTail = '';

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const contextPrefix = previousTail
      ? `\n[이전 섹션의 마지막 부분 — 자연스럽게 이어서 작성하라]\n...${previousTail}\n\n`
      : '';
    const fullPrompt = contextPrefix + chunk.prompt;

    let bestResult = null;
    let attempts = 0;

    while (attempts <= maxRetries) {
      try {
        console.log(`[분할생성] 청크 ${chunk.id} (${i + 1}/${chunks.length})${attempts > 0 ? ` 재시도${attempts}` : ''}`);

        const result = await callWithFallback({
          chain: _buildChain(model, 4096),
          systemPrompt,
          userPrompt: fullPrompt,
          timeoutMs,
          logMeta: {
            ...logMeta,
            requestType: `${logMeta.requestType || 'chunked_generate'}:${chunk.id}`,
          },
        });

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

    results.push({
      id: chunk.id,
      content: bestResult.text,
      charCount: bestResult.text.length,
      model: `${bestResult.provider}/${bestResult.model}`,
    });
    previousTail = bestResult.text.slice(-contextCarry);

    if (onChunkComplete) {
      onChunkComplete({ id: chunk.id, charCount: bestResult.text.length, index: i });
    }
  }

  const fullContent = results.map(r => r.content).join('\n\n━━━━━━━━━━━━━━━━━━━━━\n\n');

  return {
    content: fullContent,
    charCount: fullContent.length,
    chunks: results,
    totalTokens: { input: 0, output: 0 },
  };
}

module.exports = { chunkedGenerate };
