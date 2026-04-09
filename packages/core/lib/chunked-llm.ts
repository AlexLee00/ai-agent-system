/**
 * packages/core/lib/chunked-llm.ts — 분할 생성 유틸리티
 *
 * 장문 콘텐츠를 섹션 그룹별로 나눠 호출하고,
 * 이전 청크 마지막 일부를 다음 청크 입력에 넘겨 연결성을 유지한다.
 * 실제 LLM 호출은 공용 llm-fallback 체인을 사용한다.
 */

const { callWithFallback } = require('./llm-fallback');
const { selectLLMChain } = require('./llm-model-selector');

type ChunkInput = {
  id: string;
  prompt: string;
  minChars?: number;
};

type ChunkResult = {
  id: string;
  content: string;
  charCount: number;
  model: string;
};

type GenerateOptions = {
  model?: string | unknown[];
  contextCarry?: number;
  maxRetries?: number;
  timeoutMs?: number;
  onChunkComplete?: (payload: { id: string; charCount: number; index: number }) => void;
  logMeta?: Record<string, unknown>;
};

function _buildChain(model: string | unknown[], maxTokens: number): unknown[] {
  if (Array.isArray(model)) return model;

  if (model === 'gpt4o') {
    return selectLLMChain('core.chunked.gpt4o', { maxTokens });
  }

  return selectLLMChain('core.chunked.default', { maxTokens });
}

async function chunkedGenerate(systemPrompt: string, chunks: ChunkInput[], options: GenerateOptions = {}): Promise<{
  content: string;
  charCount: number;
  chunks: ChunkResult[];
  totalTokens: { input: number; output: number };
}> {
  const {
    model = 'gemini',
    contextCarry = 200,
    maxRetries = 1,
    timeoutMs,
    onChunkComplete,
    logMeta = {},
  } = options;

  const results: ChunkResult[] = [];
  let previousTail = '';

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const contextPrefix = previousTail
      ? `\n[이전 섹션의 마지막 부분 — 자연스럽게 이어서 작성하라]\n...${previousTail}\n\n`
      : '';
    const fullPrompt = contextPrefix + chunk.prompt;

    let bestResult: { text: string; provider: string; model: string } | null = null;
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
            requestType: `${String(logMeta.requestType || 'chunked_generate')}:${chunk.id}`,
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
      } catch (error) {
        const err = error as { message?: string };
        console.warn(`[분할생성] 청크 ${chunk.id} 실패: ${String(err?.message || error)}`);
        if (attempts >= maxRetries) throw error;
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

  const fullContent = results.map((result) => result.content).join('\n\n━━━━━━━━━━━━━━━━━━━━━\n\n');

  return {
    content: fullContent,
    charCount: fullContent.length,
    chunks: results,
    totalTokens: { input: 0, output: 0 },
  };
}

export = { chunkedGenerate };
