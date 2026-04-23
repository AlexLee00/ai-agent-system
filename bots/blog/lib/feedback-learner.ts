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

async function aggregateMasterFeedbackPatterns(days = 30) {
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
      source: 'master_feedback',
    }));
  } catch {
    return [];
  }
}

function detectTitlePatternLocal(title = '') {
  const text = String(title || '').trim();
  if (!text) return 'unknown';
  if (/\d+가지|\d+개|체크리스트/.test(text)) return 'checklist';
  if (/왜|이유/.test(text)) return 'why';
  if (/방법|전략|가이드/.test(text)) return 'guide';
  if (/후기|경험|회고/.test(text)) return 'experience';
  return 'default';
}

function normalizeOperationalAutonomyLane(rawLane = null) {
  const lane = String(rawLane || '').trim();
  if (!lane) return null;
  if (lane === 'master_review') return 'auto_publish_guarded';
  return lane;
}

async function aggregateOperationalPatterns(days = 30) {
  try {
    const rows = await pgPool.query('blog', `
      SELECT
        title,
        category,
        status,
        post_type,
        publish_date,
        created_at,
        metadata
      FROM blog.posts
      WHERE status IN ('ready', 'published')
        AND post_type = 'general'
        AND COALESCE(category, '') <> ''
        AND COALESCE(publish_date, created_at, NOW()) >= NOW() - ($1::text || ' days')::interval
      ORDER BY COALESCE(publish_date, created_at) DESC
      LIMIT 20
    `, [days]);

    if (!Array.isArray(rows) || rows.length === 0) return [];

    const categoryCounts = new Map();
    const patternCounts = new Map();
    const alignmentHints = new Map();
    const autonomyLaneCounts = new Map();
    const summaries = [];

    for (const row of rows) {
      const category = String(row.category || '').trim();
      const pattern = detectTitlePatternLocal(row.title || '');
      const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
      const titleAlignment = metadata.title_alignment && typeof metadata.title_alignment === 'object'
        ? metadata.title_alignment
        : null;
      const autonomy = metadata.autonomy && typeof metadata.autonomy === 'object'
        ? metadata.autonomy
        : null;
      const publishMoment = row.publish_date || row.created_at || null;
      const alignmentHint = titleAlignment?.category_aligned === false
        ? `category_drift:${titleAlignment.preview_category || category || 'unknown'}`
        : titleAlignment?.pattern_aligned === true
          ? `pattern_ok:${titleAlignment.preview_pattern || pattern}`
          : null;
      const autonomyLane = normalizeOperationalAutonomyLane(autonomy?.executionLane || autonomy?.decision || null);
      if (category) categoryCounts.set(category, Number(categoryCounts.get(category) || 0) + 1);
      patternCounts.set(pattern, Number(patternCounts.get(pattern) || 0) + 1);
      if (alignmentHint) alignmentHints.set(alignmentHint, Number(alignmentHints.get(alignmentHint) || 0) + 1);
      if (autonomyLane) autonomyLaneCounts.set(String(autonomyLane), Number(autonomyLaneCounts.get(String(autonomyLane)) || 0) + 1);
      if (summaries.length < 3) {
        const parts = [
          category,
          pattern,
          row.status || 'unknown',
          publishMoment ? new Date(publishMoment).toISOString().slice(0, 10) : null,
          autonomyLane ? `lane ${autonomyLane}` : null,
          alignmentHint,
        ].filter(Boolean);
        summaries.push(parts.join(' / '));
      }
    }

    const topCategory = [...categoryCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    const topPattern = [...patternCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    const topAlignmentHint = [...alignmentHints.entries()].sort((a, b) => b[1] - a[1])[0];
    const topAutonomyLane = [...autonomyLaneCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    const patterns = [];

    if (topCategory) {
      patterns.push({
        type: 'ops_high_performance_category',
        count: Number(topCategory[1] || 0),
        recentSummaries: [`최근 운영 포스트에서 ${topCategory[0]} 카테고리 비중이 높습니다.`, ...summaries.slice(0, 2)],
        source: 'operational_feedback',
      });
    }

    if (topPattern) {
      patterns.push({
        type: 'ops_high_performance_title_pattern',
        count: Number(topPattern[1] || 0),
        recentSummaries: [`최근 운영 포스트에서 ${topPattern[0]} 제목 패턴 비중이 높습니다.`, ...summaries.slice(0, 2)],
        source: 'operational_feedback',
      });
    }

    if (topAlignmentHint) {
      patterns.push({
        type: 'ops_alignment_signal',
        count: Number(topAlignmentHint[1] || 0),
        recentSummaries: [`최근 운영 포스트 정렬 신호는 ${topAlignmentHint[0]} 쪽에 모여 있습니다.`, ...summaries.slice(0, 2)],
        source: 'operational_feedback',
      });
    }

    if (topAutonomyLane) {
      patterns.push({
        type: 'ops_autonomy_lane',
        count: Number(topAutonomyLane[1] || 0),
        recentSummaries: [`최근 운영 포스트는 ${topAutonomyLane[0]} 레인 비중이 높습니다.`, ...summaries.slice(0, 2)],
        source: 'operational_feedback',
      });
    }

    return patterns;
  } catch {
    return [];
  }
}

/**
 * 최근 N일 피드백 패턴 집계
 */
async function aggregatePatterns(days = 30) {
  const [masterPatterns, operationalPatterns] = await Promise.all([
    aggregateMasterFeedbackPatterns(days),
    aggregateOperationalPatterns(days),
  ]);

  return [...masterPatterns, ...operationalPatterns]
    .sort((a, b) => Number(b.count || 0) - Number(a.count || 0));
}

/**
 * 피드백 패턴 → writer 프롬프트 삽입용 텍스트 생성
 */
async function buildFeedbackPromptInsert() {
  const patterns = await aggregatePatterns(30);
  if (!patterns.length) return '';

  const lines = ['[블로팀 최근 학습 패턴 — 운영 데이터 + 피드백 반영 결과]'];
  for (const p of patterns.slice(0, 5)) {
    const sourceLabel = p.source === 'operational_feedback' ? '운영' : '피드백';
    lines.push(`- ${sourceLabel}/${p.type} (${p.count}회): ${p.recentSummaries[0] || ''}`);
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

// ─── 고성과 패턴 자동 학습 ────────────────────────────────────────────────────

/**
 * 최근 30일 고성과 포스트(조회수/공감 상위 20%)에서 카테고리별 성과 가중치 산출.
 * topic-planner.ts가 카테고리 선택 시 이 가중치를 반영.
 */
async function loadCategoryPerformanceWeights() {
  try {
    const rows = await pgPool.query('blog', `
      SELECT
        category,
        ROUND(AVG(COALESCE(view_count, 0))::numeric, 1) AS avg_views,
        COUNT(*) AS post_count
      FROM blog.posts
      WHERE type = 'general'
        AND status = 'published'
        AND publish_date >= CURRENT_DATE - INTERVAL '30 days'
        AND category IS NOT NULL
      GROUP BY category
      HAVING COUNT(*) >= 2
      ORDER BY avg_views DESC
    `);

    if (!rows || rows.length === 0) return {};

    const maxViews = Math.max(...rows.map(r => Number(r.avg_views) || 0));
    if (maxViews === 0) return {};

    const weights = {};
    for (const row of rows) {
      const ratio = (Number(row.avg_views) || 0) / maxViews;
      // 0.8~1.3 범위 가중치 (너무 극단적이지 않게)
      weights[row.category] = Math.round((0.8 + ratio * 0.5) * 100) / 100;
    }
    return weights;
  } catch {
    return {};
  }
}

/**
 * 고성과 패턴을 Hub 대도서관(RAG 메모리)에 저장.
 * 주 1회 호출 — "화요일 최신IT트렌드 평균 조회수 +25%" 같은 패턴 저장.
 */
async function saveHighPerfPatternToMemory(pattern) {
  try {
    const env = require('../../../packages/core/lib/env');
    if (!env.HUB_BASE_URL || !env.HUB_AUTH_TOKEN) return null;

    const res = await fetch(`${env.HUB_BASE_URL}/hub/memory/remember`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.HUB_AUTH_TOKEN}`,
      },
      body: JSON.stringify({
        agentId: 'blog.feedback-learner',
        team: 'blog',
        content: pattern.content,
        type: 'semantic',
        keywords: pattern.keywords || [],
        importance: pattern.importance || 0.7,
        metadata: pattern.metadata || {},
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.ok ? data.memoryId : null;
  } catch {
    return null;
  }
}

/**
 * Hub 대도서관에서 성과 패턴 조회.
 * topic-planner.ts가 "내일 카테고리 선택 근거" 조회 시 사용.
 */
async function recallPerfPatternFromMemory(query) {
  try {
    const env = require('../../../packages/core/lib/env');
    if (!env.HUB_BASE_URL || !env.HUB_AUTH_TOKEN) return [];

    const res = await fetch(`${env.HUB_BASE_URL}/hub/memory/recall`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.HUB_AUTH_TOKEN}`,
      },
      body: JSON.stringify({
        agentId: 'blog.feedback-learner',
        team: 'blog',
        query,
        type: 'semantic',
        limit: 3,
        threshold: 0.5,
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.memories) ? data.memories : [];
  } catch {
    return [];
  }
}

/**
 * 주간 고성과 패턴 학습 + 메모리 저장 (매주 월요일 실행 권장).
 * topic-planner의 카테고리 선택 정확도를 점진적으로 개선.
 */
async function learnHighPerformancePatterns() {
  const weights = await loadCategoryPerformanceWeights();
  if (!Object.keys(weights).length) return { learned: 0, weights };

  let learned = 0;
  for (const [category, weight] of Object.entries(weights)) {
    const numericWeight = Number(weight || 0);
    if (numericWeight <= 1.0) continue;  // 평균 이하는 저장 불필요
    const boost = Math.round((numericWeight - 1.0) * 100);
    const content = `블로그 카테고리 [${category}] 최근 30일 조회수 평균 +${boost}% 우세. 주제 선정 시 우선 고려 권장.`;
    await saveHighPerfPatternToMemory({
      content,
      keywords: [category, '고성과', '카테고리', '조회수'],
      importance: Math.min(0.5 + boost / 200, 0.95),
      metadata: { category, weight: numericWeight, source: 'performance_analysis' },
    });
    learned++;
  }

  return { learned, weights };
}

module.exports = {
  recordFeedback,
  aggregatePatterns,
  aggregateMasterFeedbackPatterns,
  aggregateOperationalPatterns,
  buildFeedbackPromptInsert,
  calculateAccuracy,
  loadCategoryPerformanceWeights,
  learnHighPerformancePatterns,
  saveHighPerfPatternToMemory,
  recallPerfPatternFromMemory,
};
