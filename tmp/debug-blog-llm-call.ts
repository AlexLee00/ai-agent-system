'use strict';

const { performance } = require('perf_hooks');
const commenter = require('../bots/blog/lib/commenter.ts');
const { callWithFallback } = require('../packages/core/lib/llm-fallback');
const { getBlogLLMSelectorOverrides } = require('../bots/blog/lib/runtime-config.ts');

const SAMPLE = {
  postTitle: 'AI 시대의 블로그 운영 팁',
  postSummary: '운영자가 댓글과 답글을 더 빠르고 안정적으로 처리하기 위한 실제 운영 팁을 정리한 글입니다.',
  commentText: '요즘 댓글 응대 자동화 고민이 많았는데 글이 정말 도움됐어요. 실제 운영 경험이 담겨 있어서 좋았습니다.',
};

function buildPrompts(sample) {
  const systemPrompt = [
    '너는 IT 블로그 운영자다.',
    '네이버 블로그 댓글에 사람이 직접 쓴 것처럼 자연스럽고 따뜻한 한국어 답글을 JSON으로만 작성한다.',
    '답글은 반드시 2~4문장으로 쓴다.',
  ].join(' ');

  const userPrompt = [
    `[글 제목] ${sample.postTitle}`,
    `[글 요약] ${sample.postSummary}`,
    `[댓글] ${sample.commentText}`,
    '',
    '규칙:',
    '- 70~160자',
    '- 반드시 2~4문장',
    '- 댓글의 구체 표현이나 핵심 의도를 반영',
    '',
    'JSON만 응답: {"reply":"답글 내용","tone":"질문형|공감형|정보형"}',
  ].join('\n');

  return { systemPrompt, userPrompt };
}

async function runSingle(entry, prompts) {
  const startedAt = performance.now();
  try {
    const result = await callWithFallback({
      chain: [entry],
      ...prompts,
      logMeta: { team: 'blog', purpose: 'commenter', bot: 'commenter', requestType: 'reply_debug_single' },
    });

    const elapsedMs = Math.round(performance.now() - startedAt);
    return {
      ok: true,
      provider: entry.provider,
      model: entry.model,
      elapsedMs,
      text: String(result?.text || '').slice(0, 300),
    };
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - startedAt);
    return {
      ok: false,
      provider: entry.provider,
      model: entry.model,
      elapsedMs,
      error: String(error && error.message ? error.message : error),
    };
  }
}

async function main() {
  const overrides = getBlogLLMSelectorOverrides();
  const chain = Array.isArray(overrides['blog.commenter.reply']?.chain)
    ? overrides['blog.commenter.reply'].chain
    : [];
  const prompts = buildPrompts(SAMPLE);

  const chainStartedAt = performance.now();
  let chainResult;
  try {
    chainResult = await commenter.generateReply(SAMPLE.postTitle, SAMPLE.postSummary, SAMPLE.commentText);
  } catch (error) {
    chainResult = { error: String(error && error.message ? error.message : error) };
  }
  const chainElapsedMs = Math.round(performance.now() - chainStartedAt);

  const singles = [];
  for (const entry of chain) {
    singles.push(await runSingle(entry, prompts));
  }

  console.log(JSON.stringify({
    chain,
    chainElapsedMs,
    chainResult,
    singles,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
