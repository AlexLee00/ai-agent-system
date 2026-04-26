/**
 * packages/core/lib/chunked-llm.ts — 분할 생성 유틸리티
 *
 * 장문 콘텐츠를 섹션 그룹별로 나눠 호출하고,
 * 이전 청크 마지막 일부를 다음 청크 입력에 넘겨 연결성을 유지한다.
 * 실제 LLM 호출은 Hub LLM 라우터를 사용한다.
 */

const { callHubLlm } = require('./hub-client');

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
  selectorKey?: string;
  callerTeam?: string;
  agent?: string;
  taskType?: string;
  contextCarry?: number;
  maxRetries?: number;
  timeoutMs?: number;
  onChunkComplete?: (payload: { id: string; charCount: number; index: number }) => void;
  logMeta?: Record<string, unknown>;
};

function _resolveSelectorKey(model: string | unknown[], selectorKey?: string): string {
  if (selectorKey) return selectorKey;
  if (typeof model === 'string' && model.startsWith('hub:')) return model.slice('hub:'.length);
  if (typeof model === 'string' && model.startsWith('selector:')) return model.slice('selector:'.length);
  if (model === 'gpt4o') {
    return 'core.chunked.gpt4o';
  }
  return 'core.chunked.default';
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
    selectorKey,
    callerTeam = String(logMeta.team || 'core'),
    agent = String(logMeta.bot || 'chunked-llm'),
    taskType = String(logMeta.requestType || 'chunked_generate'),
  } = options;
  const resolvedSelectorKey = _resolveSelectorKey(model, selectorKey);

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

        const result = await callHubLlm({
          callerTeam,
          agent,
          selectorKey: resolvedSelectorKey,
          taskType: `${taskType}:${chunk.id}`,
          systemPrompt,
          prompt: fullPrompt,
          maxTokens: 4096,
          timeoutMs,
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
      model: `${bestResult.provider || 'hub'}/${bestResult.model || resolvedSelectorKey}`,
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
