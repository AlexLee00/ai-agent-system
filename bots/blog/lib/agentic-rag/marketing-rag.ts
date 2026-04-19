'use strict';

/**
 * bots/blog/lib/agentic-rag/marketing-rag.ts
 * Marketing Agentic RAG — 4 모듈 마케팅 지식 검색 + 액션 종합
 *
 * Phase 6: QueryPlanner → MultiSourceRetriever → QualityEvaluator → ResponseSynthesizer
 * Kill Switch: BLOG_MARKETING_RAG_ENABLED=true
 */

const pgPool = require('../../../../packages/core/lib/pg-pool');

function isEnabled() {
  return process.env.BLOG_MARKETING_RAG_ENABLED === 'true';
}

// ─── Module 1: QueryPlanner ────────────────────────────────────────────────

/**
 * 마케팅 의도를 서브 쿼리로 분해
 */
function planMarketingQuery(intent) {
  const subqueries = [];

  // 비수기/성수기 맥락 감지
  if (/비수기|부진|침체|낮|저조/.test(intent)) {
    subqueries.push({ q: '비수기 스터디카페 유입 전략', priority: 1 });
    subqueries.push({ q: '과거 비수기 성공 포스팅', priority: 2 });
  }
  // 신규 유입 맥락
  if (/신규|새로운|처음|유입/.test(intent)) {
    subqueries.push({ q: '신규 방문자 유도 콘텐츠', priority: 1 });
    subqueries.push({ q: '첫 방문 전환율 높은 주제', priority: 2 });
  }
  // 재방문/충성 맥락
  if (/재방문|충성|단골|리텐션/.test(intent)) {
    subqueries.push({ q: '재방문 고객 유지 전략', priority: 1 });
    subqueries.push({ q: '커뮤니티 형성 콘텐츠', priority: 2 });
  }
  // 경쟁사 맥락
  if (/경쟁|대응|벤치마킹/.test(intent)) {
    subqueries.push({ q: '경쟁사 분석', priority: 1 });
    subqueries.push({ q: '차별화 포인트 강조 콘텐츠', priority: 2 });
  }
  // 기본 쿼리 (항상 포함)
  subqueries.push({ q: '최근 30일 성공 포스팅 패턴', priority: 3 });
  subqueries.push({ q: '스터디카페 마케팅 트렌드', priority: 3 });

  // 우선순위 정렬
  return subqueries.sort((a, b) => a.priority - b.priority);
}

// ─── Module 2: MultiSourceRetriever ───────────────────────────────────────

/**
 * 자사 성공 패턴 검색
 */
async function searchOwnSuccessPatterns(subqueries) {
  try {
    const keywords = subqueries.map((s) => s.q).join(' ').split(' ').slice(0, 5);
    const rows = await pgPool.query('blog', `
      SELECT
        p.title,
        p.category,
        COALESCE(pf.total_views_7d, 0) AS views,
        COALESCE(pf.engagement_rate, 0) AS eng_rate,
        p.created_at
      FROM blog.posts p
      LEFT JOIN blog.post_performance pf ON pf.post_id::text = p.id::text
      WHERE p.status = 'published'
        AND p.created_at > NOW() - INTERVAL '90 days'
        AND COALESCE(pf.engagement_rate, 0) > 0.02
      ORDER BY COALESCE(pf.total_views_7d, 0) DESC
      LIMIT 10
    `, []);
    return (rows || []).map((r) => ({
      source: 'own_success',
      title: r.title,
      category: r.category,
      relevance: 0.8,
      snippet: `조회 ${r.views} | 참여율 ${(Number(r.eng_rate) * 100).toFixed(1)}%`,
    }));
  } catch {
    return [];
  }
}

/**
 * DPO 선호 쌍 기반 학습 결과 검색
 */
async function searchDpoLearnings(subqueries) {
  if (process.env.BLOG_DPO_ENABLED !== 'true') return [];
  try {
    const rows = await pgPool.query('blog', `
      SELECT
        features->>'hook_type_a' AS best_hook,
        features->>'category' AS category,
        features->>'key_insight' AS insight,
        COUNT(*) AS pair_count
      FROM blog.dpo_preference_pairs
      WHERE inserted_at > NOW() - INTERVAL '60 days'
      GROUP BY features->>'hook_type_a', features->>'category', features->>'key_insight'
      ORDER BY pair_count DESC
      LIMIT 5
    `, []);
    return (rows || []).map((r) => ({
      source: 'dpo_learning',
      hook_type: r.best_hook,
      category: r.category,
      relevance: 0.9,
      snippet: r.insight || `${r.category}에서 ${r.best_hook} 스타일 우세 (${r.pair_count}쌍)`,
    }));
  } catch {
    return [];
  }
}

/**
 * 경쟁사 벤치마크 검색
 */
async function searchCompetitorBenchmarks() {
  try {
    const rows = await pgPool.query('blog', `
      SELECT keyword, trend_score, growth_rate_week, collected_at
      FROM blog.keyword_trends
      WHERE collected_at > NOW() - INTERVAL '14 days'
      ORDER BY growth_rate_week DESC
      LIMIT 5
    `, []);
    return (rows || []).map((r) => ({
      source: 'trend_signal',
      keyword: r.keyword,
      trend_score: r.trend_score,
      growth_rate: r.growth_rate_week,
      relevance: 0.7,
      snippet: `트렌드 키워드: ${r.keyword} (주간 성장 ${Number(r.growth_rate_week || 0).toFixed(1)}%)`,
    }));
  } catch {
    return [];
  }
}

/**
 * 성공 패턴 라이브러리 검색
 */
async function searchSuccessPatternLibrary() {
  try {
    const rows = await pgPool.query('blog', `
      SELECT pattern_type, pattern_template, platform, avg_performance, usage_count
      FROM blog.success_pattern_library
      WHERE avg_performance > 50
        AND last_used_at > NOW() - INTERVAL '30 days'
      ORDER BY avg_performance DESC
      LIMIT 8
    `, []);
    return (rows || []).map((r) => ({
      source: 'success_library',
      pattern_type: r.pattern_type,
      template: r.pattern_template,
      platform: r.platform,
      relevance: 0.85,
      snippet: `[${r.platform}] ${r.pattern_template} (성과 ${r.avg_performance})`,
    }));
  } catch {
    return [];
  }
}

/**
 * 다중 소스 통합 검색
 */
async function retrieveMarketingKnowledge(subqueries) {
  const [ownPatterns, dpoLearnings, competitorData, successLibrary] = await Promise.allSettled([
    searchOwnSuccessPatterns(subqueries),
    searchDpoLearnings(subqueries),
    searchCompetitorBenchmarks(),
    searchSuccessPatternLibrary(),
  ]);

  const consolidate = (result) => (result.status === 'fulfilled' ? result.value : []);

  return [
    ...consolidate(ownPatterns),
    ...consolidate(dpoLearnings),
    ...consolidate(competitorData),
    ...consolidate(successLibrary),
  ];
}

// ─── Module 3: QualityEvaluator ───────────────────────────────────────────

/**
 * 검색 결과 품질 평가 + 재검색 필요 여부 판단
 */
function evaluateRetrievalQuality(results, subqueries) {
  if (!results || results.length === 0) {
    return { needs_retry: true, quality_score: 0, broader_queries: ['마케팅 콘텐츠 전략', '스터디카페 블로그'] };
  }

  const avgRelevance = results.reduce((s, r) => s + (r.relevance || 0.5), 0) / results.length;
  const sourceVariety = new Set(results.map((r) => r.source)).size;

  const qualityScore = avgRelevance * 0.6 + Math.min(sourceVariety / 4, 1) * 0.4;

  if (qualityScore < 0.5) {
    // 쿼리 확장
    const broaderQueries = subqueries.map((s) => s.q.split(' ').slice(0, 2).join(' '));
    return { needs_retry: true, quality_score: qualityScore, broader_queries: broaderQueries };
  }

  return { needs_retry: false, quality_score: qualityScore, results };
}

// ─── Module 4: ResponseSynthesizer ────────────────────────────────────────

/**
 * 검색 결과를 마케팅 액션 플랜으로 종합
 * LLM 호출 실패 시 규칙 기반 fallback
 */
async function synthesizeMarketingResponse(retrieved, intent) {
  // 규칙 기반 합성 (LLM fallback용)
  const topPatterns = retrieved.filter((r) => r.source === 'success_library').slice(0, 3);
  const topPosts = retrieved.filter((r) => r.source === 'own_success').slice(0, 3);
  const dpoInsights = retrieved.filter((r) => r.source === 'dpo_learning').slice(0, 2);
  const trends = retrieved.filter((r) => r.source === 'trend_signal').slice(0, 2);

  const contentCalendar = [];
  const days = [1, 2, 3, 4, 5];
  const platforms = ['naver', 'instagram', 'facebook', 'naver', 'naver'];

  for (let i = 0; i < days.length; i++) {
    const pattern = topPatterns[i % topPatterns.length] || null;
    const post = topPosts[i % topPosts.length] || null;
    const topic = post?.title || pattern?.template || '스터디카페 활용 팁';

    contentCalendar.push({
      day: days[i],
      platform: platforms[i],
      topic,
      hook: dpoInsights[0]?.hook_type ? `${dpoInsights[0].hook_type} 스타일` : 'list',
      cta: platforms[i] === 'naver' ? '예약 링크 삽입' : '프로필 링크 클릭 유도',
    });
  }

  // LLM 보강 시도
  try {
    const { callLocalFast } = require('../../../../packages/core/lib/local-llm-client');
    const contextText = retrieved.slice(0, 5).map((r) => `- ${r.snippet}`).join('\n');
    const prompt = `마케팅 의도: "${intent}"\n\n참고 데이터:\n${contextText}\n\n5일 콘텐츠 전략을 JSON으로 간결하게:\n{"primary_strategy":"...","expected_views_uplift":"...%","key_insight":"..."}`;

    const resp = await callLocalFast(prompt, { maxTokens: 200 });
    const text = (resp?.text || resp || '').trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const llmResult = JSON.parse(match[0]);
      return { ...llmResult, content_calendar: contentCalendar, source_count: retrieved.length };
    }
  } catch {
    // fallback
  }

  // 규칙 기반 결과
  const trendKeywords = trends.map((t) => t.keyword).join(', ') || '스터디카페, 집중력, 학습';
  return {
    primary_strategy: `${dpoInsights[0]?.snippet || '성공 패턴 기반'} 콘텐츠 전략`,
    expected_views_uplift: '+15~25%',
    key_insight: dpoInsights[0]?.snippet || '고성과 후킹 스타일 우선 사용',
    trending_keywords: trendKeywords,
    content_calendar: contentCalendar,
    source_count: retrieved.length,
  };
}

// ─── 메인 실행 ────────────────────────────────────────────────────────────────

/**
 * Marketing RAG 전체 파이프라인 실행
 */
async function runMarketingRag(intent) {
  if (!isEnabled()) {
    return { skipped: true };
  }

  console.log(`[marketing-rag] 의도: "${intent}"`);

  // Module 1: 쿼리 분해
  const subqueries = planMarketingQuery(intent);
  console.log(`[marketing-rag] 서브쿼리 ${subqueries.length}개 생성`);

  // Module 2: 다중 소스 검색
  let retrieved = await retrieveMarketingKnowledge(subqueries);
  console.log(`[marketing-rag] ${retrieved.length}개 결과 검색`);

  // Module 3: 품질 평가
  const quality = evaluateRetrievalQuality(retrieved, subqueries);
  if (quality.needs_retry && quality.broader_queries?.length) {
    console.log('[marketing-rag] 품질 미달 — 쿼리 확장 재검색');
    const broaderSubqueries = quality.broader_queries.map((q) => ({ q, priority: 1 }));
    const retryResults = await retrieveMarketingKnowledge(broaderSubqueries);
    retrieved = [...retrieved, ...retryResults];
  }

  // Module 4: 액션 플랜 합성
  const response = await synthesizeMarketingResponse(retrieved, intent);
  console.log('[marketing-rag] 액션 플랜 합성 완료');

  return {
    intent,
    subqueries_count: subqueries.length,
    retrieved_count: retrieved.length,
    quality_score: quality.quality_score,
    response,
  };
}

module.exports = {
  isEnabled,
  planMarketingQuery,
  retrieveMarketingKnowledge,
  evaluateRetrievalQuality,
  synthesizeMarketingResponse,
  runMarketingRag,
  searchOwnSuccessPatterns,
  searchDpoLearnings,
  searchCompetitorBenchmarks,
  searchSuccessPatternLibrary,
};
