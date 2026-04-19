'use strict';

/**
 * bots/blog/lib/evolution-cycle.ts
 * 마스터 요구 핵심 루프: 활용 → 수집 → 분석 → 피드백 → 전략 → 반복
 *
 * Phase 3: 매일 23:00 KST 자동 실행
 * Kill Switch: BLOG_EVOLUTION_CYCLE_ENABLED=true
 */

const pgPool = require('../../../packages/core/lib/pg-pool');
const { runIfOps } = require('../../../packages/core/lib/mode-guard');
const { postAlarm } = require('../../../packages/core/lib/openclaw-client');

const cmf = require('./content-market-fit');
const aarrr = require('./aarrr-metrics');
const skaRevenueBridge = require('./ska-revenue-bridge');
const feedbackLearner = require('./feedback-learner');

function isEnabled() {
  return process.env.BLOG_EVOLUTION_CYCLE_ENABLED === 'true';
}

// ─── Phase 1: 활용 (Utilize) ─────────────────────────────────────────────────

async function collectUtilizeStats(lookbackDays = 1) {
  try {
    const rows = await pgPool.query('blog', `
      SELECT
        COUNT(*) AS posts_published,
        ARRAY_AGG(DISTINCT 'naver') AS platforms
      FROM blog.posts
      WHERE status = 'published'
        AND COALESCE(published_at, created_at) > NOW() - ($1::text || ' days')::interval
    `, [lookbackDays]);
    const row = rows?.[0] || {};

    // 인스타/페북 발행도 집계 (channel_performance 기반)
    const channelRows = await pgPool.query('blog', `
      SELECT DISTINCT channel
      FROM blog.channel_performance
      WHERE published_at > NOW() - ($1::text || ' days')::interval
    `, [lookbackDays]);
    const platforms = ['naver', ...((channelRows || []).map((r) => r.channel).filter(Boolean))];

    return {
      posts_published: Number(row.posts_published || 0),
      platforms: [...new Set(platforms)],
    };
  } catch {
    return { posts_published: 0, platforms: ['naver'] };
  }
}

// ─── Phase 2: 수집 (Collect) ─────────────────────────────────────────────────

async function collectAllSignals(days = 7) {
  try {
    const [platformRows, revenueRows, competitorRows] = await Promise.all([
      pgPool.query('blog', `
        SELECT channel, COUNT(*) AS cnt, SUM(reach) AS total_reach
        FROM blog.channel_performance
        WHERE published_at > NOW() - ($1::text || ' days')::interval
        GROUP BY channel
      `, [days]).catch(() => []),
      skaRevenueBridge.isEnabled()
        ? pgPool.query('blog', `
            SELECT COUNT(*) AS cnt
            FROM blog.post_revenue_attribution
            WHERE post_published_at > NOW() - ($1::text || ' days')::interval
          `, [days]).catch(() => [])
        : Promise.resolve([{ cnt: 0 }]),
      pgPool.query('blog', `
        SELECT COUNT(*) AS cnt
        FROM blog.competitor_posts
        WHERE collected_at > NOW() - ($1::text || ' days')::interval
      `, [days]).catch(() => []),
    ]);

    /** @type {Record<string, number>} */
    const platformSignals = {};
    for (const r of (platformRows || [])) {
      platformSignals[r.channel] = Number(r.cnt || 0);
    }

    return {
      total_signals: Object.values(platformSignals).reduce((a, b) => Number(a) + Number(b), 0),
      platform_signals: platformSignals,
      revenue_signals: Number(revenueRows?.[0]?.cnt || 0),
      competitor_signals: Number(competitorRows?.[0]?.cnt || 0),
    };
  } catch {
    return { total_signals: 0, platform_signals: {}, revenue_signals: 0, competitor_signals: 0 };
  }
}

// ─── Phase 3: 분석 (Analyze) ─────────────────────────────────────────────────

async function runComprehensiveAnalysis(collectStats) {
  const [cmfResult, aarrResult, roiSummary] = await Promise.all([
    cmf.getAverageCmfScore(30),
    aarrr.calculateAARRR(30),
    skaRevenueBridge.getRoiSummary(30),
  ]);

  // 상위/하위 포스팅
  const topPosts = await pgPool.query('blog', `
    SELECT post_id, post_title, overall_score AS score
    FROM blog.content_market_fit
    WHERE measured_at > NOW() - '30 days'::interval
    ORDER BY overall_score DESC
    LIMIT 5
  `).catch(() => []);

  const worstPosts = await pgPool.query('blog', `
    SELECT post_id, post_title, overall_score AS score
    FROM blog.content_market_fit
    WHERE measured_at > NOW() - '30 days'::interval
    ORDER BY overall_score ASC
    LIMIT 3
  `).catch(() => []);

  return {
    top_performing_posts: (topPosts || []).map((r) => ({
      post_id: r.post_id,
      title: r.post_title,
      score: Number(r.score || 0),
    })),
    underperforming_posts: (worstPosts || []).map((r) => ({
      post_id: r.post_id,
      title: r.post_title,
      score: Number(r.score || 0),
    })),
    content_market_fit_score: cmfResult.avg_score,
    revenue_correlation: roiSummary.enabled
      ? (roiSummary.by_platform?.[0]?.avg_uplift_krw || 0)
      : 0,
    aarrr_metrics: aarrResult,
  };
}

// ─── Phase 4: 피드백 (Feedback) ──────────────────────────────────────────────

async function applyFeedbackLearning(analyzeStats) {
  let patternsLearned = 0;
  try {
    // 고성과 패턴 학습
    const learned = await feedbackLearner.learnHighPerformancePatterns().catch(() => null);
    if (learned && learned.count) patternsLearned = learned.count;
  } catch {
    // 실패해도 사이클 계속
  }

  // 카테고리별 성과 업데이트
  await skaRevenueBridge.updateCategoryRevenuePerformance(30).catch(() => {});

  // CMF 미계산 포스팅 일괄 처리
  const cmfProcessed = await cmf.computePendingCmf(14).catch(() => 0);

  return {
    success_patterns_learned: patternsLearned,
    cmf_posts_computed: cmfProcessed,
    failure_taxonomy_updates: 0,
    persona_performance: {},
  };
}

// ─── Phase 5: 전략 (Strategy) ────────────────────────────────────────────────

async function evolveStrategyFromCycle(analyzeStats, feedbackStats) {
  try {
    const { evolveStrategy } = require('./strategy-evolver');
    const diagnosis = {
      contentMarketFitScore: analyzeStats.content_market_fit_score,
      revenueCorrelation: analyzeStats.revenue_correlation,
      topPosts: analyzeStats.top_performing_posts,
      underperformingPosts: analyzeStats.underperforming_posts,
    };
    const evolved = await evolveStrategy(diagnosis, { dryRun: false });
    return {
      topic_pool_updates: evolved?.topicsAdded || 0,
      persona_weight_changes: evolved?.personaWeightDelta || {},
      platform_allocation: { naver: 0.7, instagram: 0.2, facebook: 0.1 },
      next_cycle_hints: evolved?.nextCycleHints || [],
    };
  } catch {
    return {
      topic_pool_updates: 0,
      persona_weight_changes: {},
      platform_allocation: { naver: 0.7, instagram: 0.2, facebook: 0.1 },
      next_cycle_hints: [],
    };
  }
}

// ─── 사이클 리포트 ────────────────────────────────────────────────────────────

async function sendCycleReport(result) {
  const cmfStr = result.analyze.content_market_fit_score > 0
    ? `CMF: ${result.analyze.content_market_fit_score.toFixed(1)}점`
    : 'CMF 데이터 없음';
  const postsStr = `포스팅 ${result.utilize.posts_published}건`;
  const signalsStr = `시그널 ${result.collect.total_signals}건`;

  const msg = [
    `🔄 [블로팀] 오늘의 진화 사이클 완료`,
    ``,
    `📊 ${postsStr} | ${signalsStr} | ${cmfStr}`,
    `📈 AARRR — 도달: ${result.analyze.aarrr_metrics?.acquisition?.total_reach || 0}`,
    `🎯 패턴 학습: ${result.feedback.success_patterns_learned}건`,
    `🗂 전략 주제풀 업데이트: ${result.strategy.topic_pool_updates}건`,
  ].join('\n');

  await runIfOps(
    'blog-evolution-cycle',
    () => postAlarm({ message: msg, team: 'blog', bot: 'evolution-cycle', level: 'info' }),
    () => console.log('[DEV]', msg),
  ).catch(() => {});
}

// ─── 메인 루프 ────────────────────────────────────────────────────────────────

/**
 * 5단계 자율진화 루프 실행
 */
async function runEvolutionCycle() {
  if (!isEnabled()) {
    console.log('[evolution-cycle] BLOG_EVOLUTION_CYCLE_ENABLED=false — 건너뜀');
    return null;
  }

  const cycleId = `cycle_${Date.now()}`;
  const startedAt = new Date();
  console.log(`[evolution-cycle] 시작 — ${cycleId}`);

  // 1. 활용
  const utilize = await collectUtilizeStats(1);

  // 2. 수집
  const collect = await collectAllSignals(7);

  // 3. 분석
  const analyze = await runComprehensiveAnalysis(collect);

  // 4. 피드백
  const feedback = await applyFeedbackLearning(analyze);

  // 5. 전략 진화
  const strategy = await evolveStrategyFromCycle(analyze, feedback);

  const completedAt = new Date();
  const durationMs = completedAt.getTime() - startedAt.getTime();

  const result = {
    cycle_id: cycleId,
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: durationMs,
    utilize,
    collect,
    analyze,
    feedback,
    strategy,
  };

  // DB 저장
  try {
    await pgPool.query('blog', `
      INSERT INTO blog.evolution_cycles
        (cycle_id, started_at, completed_at, duration_ms,
         utilize_stats, collect_stats, analyze_stats, feedback_stats, strategy_changes,
         content_market_fit_avg, revenue_correlation)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (cycle_id) DO NOTHING
    `, [
      cycleId,
      startedAt.toISOString(),
      completedAt.toISOString(),
      durationMs,
      JSON.stringify(utilize),
      JSON.stringify(collect),
      JSON.stringify({ ...analyze, aarrr_metrics: null }), // aarrr는 별도 저장
      JSON.stringify(feedback),
      JSON.stringify(strategy),
      analyze.content_market_fit_score || null,
      analyze.revenue_correlation || null,
    ]);
  } catch (err) {
    console.warn('[evolution-cycle] DB 저장 실패:', err.message);
  }

  // 사이클 리포트
  await sendCycleReport(result);

  console.log(`[evolution-cycle] 완료 — ${durationMs}ms`);
  return result;
}

module.exports = {
  isEnabled,
  runEvolutionCycle,
  collectUtilizeStats,
  collectAllSignals,
  runComprehensiveAnalysis,
  applyFeedbackLearning,
  evolveStrategyFromCycle,
};
