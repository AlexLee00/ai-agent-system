// @ts-nocheck
'use strict';

/**
 * bots/blog/lib/feedback-learner.ts — 마스터 피드백 학습
 *
 * 피드백 루프 LEARN 단계: 마스터 수정 이력 → 선호 스타일 학습
 */

const pgPool = require('../../../packages/core/lib/pg-pool');
const { selectLLMChain } = require('../../../packages/core/lib/llm-model-selector');
const { callWithFallback } = require('../../../packages/core/lib/llm-fallback');
const { getBlogLLMSelectorOverrides } = require('./runtime-config.ts');

async function getPostDateColumn() {
  try {
    const rows = await pgPool.query('blog', `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'blog'
        AND table_name = 'posts'
        AND column_name IN ('published_at', 'publish_date', 'created_at')
    `);
    const names = new Set((rows || []).map((row) => row.column_name));
    if (names.has('published_at')) return 'published_at';
    if (names.has('publish_date')) return 'publish_date';
    return 'created_at';
  } catch {
    return 'created_at';
  }
}

const DIFF_ANALYSIS_SYSTEM = `
당신은 편집 피드백 분석가입니다.
원본과 수정본의 차이를 분석하여 수정 유형을 분류합니다.

분류 유형:
- tone: 말투/어조 변경 (예: 딱딱→친근)
- structure: 구조/순서 변경
- keyword: 키워드/용어 변경
- aggro: 어그로 카피 변경
- length: 길이 조정 (추가/삭제)
- factual: 사실 관계 수정

응답: JSON만 출력
{ "feedback_type": "tone", "summary": "~합니다 종결을 ~해보세요로 변경" }
`.trim();

/**
 * 마스터 수정 diff 분석 + 기록
 */
async function recordFeedback(postId, originalTitle, modifiedTitle, originalContentHash, modifiedContentHash) {
  try {
    const selectorOverrides = getBlogLLMSelectorOverrides();
    const userPrompt = `
원본 제목: ${originalTitle}
수정된 제목: ${modifiedTitle}
내용 변경: ${originalContentHash !== modifiedContentHash ? '본문 수정됨' : '본문 변경 없음'}
`.trim();

    const result = await callWithFallback({
      chain: selectLLMChain('blog.feedback.analyze', {
        policyOverride: selectorOverrides['blog.feedback.analyze'] || selectorOverrides['blog.social.summarize'],
      }),
      systemPrompt: DIFF_ANALYSIS_SYSTEM,
      userPrompt,
      logMeta: { team: 'blog', purpose: 'feedback', bot: 'feedback-learner' },
    });

    let parsed = { feedback_type: 'unknown', summary: '' };
    try {
      const match = result.text.match(/\{[\s\S]*?\}/);
      if (match) parsed = JSON.parse(match[0]);
    } catch {}

    await pgPool.query('blog', `
      INSERT INTO blog.master_feedback
        (post_id, original_title, modified_title, original_content_hash, modified_content_hash, diff_summary, feedback_type)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [postId, originalTitle, modifiedTitle, originalContentHash, modifiedContentHash, parsed.summary, parsed.feedback_type]);

    return parsed;
  } catch (err) {
    console.warn('[feedback-learner] 피드백 기록 실패:', err.message);
    return null;
  }
}

/**
 * 최근 N일 피드백 패턴 집계
 */
async function aggregatePatterns(days = 30) {
  try {
    const rows = await pgPool.query('blog', `
      SELECT feedback_type, COUNT(*) as count, 
             array_agg(diff_summary ORDER BY learned_at DESC) as summaries
      FROM blog.master_feedback
      WHERE learned_at >= CURRENT_DATE - $1
      GROUP BY feedback_type
      ORDER BY count DESC
    `, [days]);

    return (rows || []).map(r => ({
      type: r.feedback_type,
      count: Number(r.count),
      recentSummaries: (r.summaries || []).slice(0, 3),
    }));
  } catch {
    return [];
  }
}

/**
 * 피드백 패턴 → writer 프롬프트 삽입용 텍스트 생성
 */
async function buildFeedbackPromptInsert() {
  const patterns = await aggregatePatterns(30);
  if (!patterns.length) return '';

  const lines = ['[마스터 선호 스타일 — 최근 피드백 학습 결과]'];
  for (const p of patterns.slice(0, 5)) {
    lines.push(`- ${p.type} (${p.count}회): ${p.recentSummaries[0] || ''}`);
  }
  return lines.join('\n');
}

/**
 * 정확도 계산 (수정 없이 통과율)
 */
async function calculateAccuracy(days = 7) {
  try {
    const dateColumn = await getPostDateColumn();
    const totalRows = await pgPool.query('blog', `
      SELECT COUNT(*) as total FROM blog.posts
      WHERE ${dateColumn} >= CURRENT_DATE - ($1::text || ' days')::interval AND status = 'published'
    `, [days]);
    const modifiedRows = await pgPool.query('blog', `
      SELECT COUNT(DISTINCT post_id) as modified FROM blog.master_feedback
      WHERE learned_at >= CURRENT_DATE - $1
    `, [days]);

    const total = Number(totalRows?.[0]?.total || 0);
    const modified = Number(modifiedRows?.[0]?.modified || 0);
    if (total === 0) return 1.0;

    return (total - modified) / total;
  } catch {
    return 0;
  }
}

module.exports = {
  recordFeedback,
  aggregatePatterns,
  buildFeedbackPromptInsert,
  calculateAccuracy,
};
