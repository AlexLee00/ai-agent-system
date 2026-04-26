'use strict';

/**
 * bots/blog/lib/self-rewarding/marketing-dpo.ts
 * 마케팅 Self-Rewarding DPO — 성공/실패 포스팅 선호 쌍 학습
 *
 * Phase 6: DPO 선호 쌍 생성 + LLM-as-a-Judge 분석
 * Kill Switch: BLOG_DPO_ENABLED=true
 */

const pgPool = require('../../../../packages/core/lib/pg-pool');
const { runIfOps } = require('../../../../packages/core/lib/mode-guard');
const { postAlarm } = require('../../../../packages/core/lib/hub-alarm-client');

function isEnabled() {
  return process.env.BLOG_DPO_ENABLED === 'true';
}

// ─── 데이터 조회 ──────────────────────────────────────────────────────────────

/**
 * 최근 N일 포스팅과 성과 지표 조회
 */
async function fetchPostsWithMetrics(periodDays = 30) {
  try {
    const rows = await pgPool.query('blog', `
      SELECT
        p.id,
        p.title,
        p.category,
        p.persona,
        p.created_at AS published_at,
        COALESCE(LENGTH(p.content), 0) AS content_length,
        COALESCE(pv.view_count, 0) AS views,
        COALESCE(pv.like_count, 0) AS likes,
        COALESCE(pv.comment_count, 0) AS comments,
        COALESCE(pf.total_views_7d, 0) AS views_7d,
        COALESCE(pf.engagement_rate, 0) AS engagement_rate,
        COALESCE(pa.uplift_krw, 0) AS revenue_attributed_krw,
        COALESCE(pa.attribution_confidence, 0) AS attribution_confidence
      FROM blog.posts p
      LEFT JOIN blog.post_view_log pv ON pv.post_id = p.id
      LEFT JOIN blog.post_performance pf ON pf.post_id = p.id
      LEFT JOIN blog.post_revenue_attribution pa ON pa.post_id::text = p.id::text
      WHERE p.status = 'published'
        AND COALESCE(p.published_at, p.created_at) > NOW() - ($1::text || ' days')::interval
        AND p.category IS NOT NULL
        AND COALESCE(LENGTH(p.title), 0) > 0
      ORDER BY COALESCE(p.published_at, p.created_at) DESC
    `, [periodDays]);
    return rows || [];
  } catch {
    return [];
  }
}

/**
 * 포스팅 성과 종합 점수 계산 (0~100)
 * views_7d: 40%, engagement_rate: 40%, revenue_attributed: 20%
 */
function calcPostScore(post) {
  const viewScore = Math.min(Number(post.views_7d || 0) / 1000, 1) * 40;
  const engScore = Math.min(Number(post.engagement_rate || 0) * 100, 1) * 40;
  const revScore = Math.min(Number(post.revenue_attributed_krw || 0) / 100000, 1) * 20;
  return viewScore + engScore + revScore;
}

/**
 * 포스팅 제목에서 후킹 스타일 분류
 */
function classifyHookStyle(title) {
  if (!title) return 'unknown';
  if (/\d+가지|\d+개|TOP\s*\d+/i.test(title)) return 'list';
  if (/왜|이유|때문/.test(title)) return 'why';
  if (/방법|비결|전략/.test(title)) return 'how';
  if (/뭐가|무엇|어떤|어떻게/.test(title)) return 'question';
  if (/vs|비교/.test(title)) return 'comparison';
  return 'statement';
}

// ─── DPO 선호 쌍 생성 ──────────────────────────────────────────────────────────

/**
 * 같은 카테고리 내 top 20% vs bottom 20% 매칭으로 선호 쌍 생성
 */
async function buildPreferencePairs(periodDays = 30) {
  if (!isEnabled()) return [];
  const posts = await fetchPostsWithMetrics(periodDays);
  if (posts.length < 4) return [];

  const scored = posts.map((p) => ({ ...p, score: calcPostScore(p) }));

  // 카테고리별 그룹
  const byCategory = {};
  for (const post of scored) {
    const cat = post.category || 'uncategorized';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(post);
  }

  const pairs = [];
  for (const [, catPosts] of /** @type {Array<[string, any[]]>} */ (Object.entries(byCategory))) {
    // @ts-ignore Object.entries over dynamic buckets still narrows to unknown in checkJs
    if (catPosts.length < 2) continue;

    // @ts-ignore Object.entries over dynamic buckets still narrows to unknown in checkJs
    const sorted = [...catPosts].sort((a, b) => b.score - a.score);
    const cutTop = Math.max(1, Math.ceil(sorted.length * 0.2));
    const cutBot = Math.max(1, Math.ceil(sorted.length * 0.2));

    const top = sorted.slice(0, cutTop);
    const bottom = sorted.slice(-cutBot);

    for (const preferred of top) {
      for (const rejected of bottom) {
        if (preferred.id === rejected.id) continue;
        if (preferred.score <= rejected.score) continue;

        pairs.push({
          post_a_id: String(preferred.id),
          post_b_id: String(rejected.id),
          metric_winner: 'a',
          metric_type: 'engagement',
          features: {
            title_a: preferred.title,
            title_b: rejected.title,
            hook_type_a: classifyHookStyle(preferred.title),
            hook_type_b: classifyHookStyle(rejected.title),
            length_a: Number(preferred.content_length || 0),
            length_b: Number(rejected.content_length || 0),
            category: preferred.category,
            persona_a: preferred.persona || '',
            persona_b: rejected.persona || '',
            score_a: preferred.score,
            score_b: rejected.score,
          },
        });
      }
    }
  }

  return pairs;
}

// ─── LLM-as-a-Judge ──────────────────────────────────────────────────────────

/**
 * LLM으로 성공/실패 포스팅 쌍의 원인 분석
 * 실제 LLM 호출 실패 시 규칙 기반 fallback
 */
async function analyzePairWithLlm(preferred, rejected) {
  try {
    const { callLocalFast } = require('../../../../packages/core/lib/local-llm-client');
    const prompt = `마케팅 포스팅 A(성공) vs B(실패) 비교 분석.

[A - 성공] 제목: "${preferred.title}" | 카테고리: ${preferred.category} | 조회: ${preferred.views_7d}
[B - 실패] 제목: "${rejected.title}" | 카테고리: ${rejected.category} | 조회: ${rejected.views_7d}

JSON만 응답:
{"hook_difference":"...","key_insight":"...","action_hint":"..."}`;

    const resp = await callLocalFast(prompt, { maxTokens: 200 });
    const text = (resp?.text || resp || '').trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  } catch {
    // fallback
  }

  // 규칙 기반 fallback
  const hookA = classifyHookStyle(preferred.title);
  const hookB = classifyHookStyle(rejected.title);
  return {
    hook_difference: hookA !== hookB ? `A는 ${hookA} 스타일, B는 ${hookB} 스타일` : '제목 스타일 유사',
    key_insight: `카테고리 ${preferred.category}에서 ${hookA} 후킹이 더 효과적`,
    action_hint: `다음 포스팅은 ${hookA} 스타일 제목 우선 사용`,
  };
}

// ─── 저장 ─────────────────────────────────────────────────────────────────────

/**
 * DPO 선호 쌍 DB 저장 + 성공 패턴 라이브러리 업데이트
 */
async function saveDpoPairs(pairs, reasonings) {
  if (!pairs.length) return 0;

  let saved = 0;
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    const reasoning = reasonings?.[i] || null;
    try {
      await pgPool.query('blog', `
        INSERT INTO blog.dpo_preference_pairs
          (post_a_id, post_b_id, metric_winner, metric_type, reasoning, features)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT DO NOTHING
      `, [
        pair.post_a_id,
        pair.post_b_id,
        pair.metric_winner,
        pair.metric_type,
        reasoning ? JSON.stringify(reasoning) : null,
        JSON.stringify(pair.features || {}),
      ]);
      saved++;

      // 성공 패턴 라이브러리 업데이트
      if (pair.features?.hook_type_a) {
        await pgPool.query('blog', `
          INSERT INTO blog.success_pattern_library
            (pattern_type, pattern_template, platform, avg_performance, usage_count, first_seen_at, last_used_at)
          VALUES ('hook', $1, 'naver', $2, 1, NOW(), NOW())
          ON CONFLICT (pattern_type, pattern_template, platform)
          DO UPDATE SET
            usage_count = blog.success_pattern_library.usage_count + 1,
            avg_performance = (blog.success_pattern_library.avg_performance + $2) / 2,
            last_used_at = NOW()
        `, [pair.features.hook_type_a, pair.features.score_a || 50]);
      }
    } catch {
      // 중복 무시
    }
  }

  return saved;
}

/**
 * 실패 Taxonomy 업데이트
 */
async function updateFailureTaxonomy(pairs) {
  const failureMap = {};

  for (const pair of pairs) {
    const hookB = pair.features?.hook_type_b || 'unknown';
    const category = `poor_hook_${hookB}`;
    if (!failureMap[category]) {
      failureMap[category] = { post_ids: [], count: 0 };
    }
    failureMap[category].post_ids.push(pair.post_b_id);
    failureMap[category].count++;
  }

  for (const [category, data] of Object.entries(failureMap)) {
    const typedData = /** @type {any} */ (data);
    try {
      await pgPool.query('blog', `
        INSERT INTO blog.failure_taxonomy
          (failure_category, example_post_ids, typical_characteristics, avoidance_hint, frequency_count, last_seen_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (failure_category)
        DO UPDATE SET
          example_post_ids = EXCLUDED.example_post_ids,
          frequency_count = blog.failure_taxonomy.frequency_count + $5,
          last_seen_at = NOW()
      `, [
        category,
        // @ts-ignore failure taxonomy map value is dynamic runtime data
        typedData.post_ids,
        // @ts-ignore failure taxonomy map value is dynamic runtime data
        JSON.stringify({ hook_type: category.replace('poor_hook_', ''), count: typedData.count }),
        `${category.replace('poor_hook_', '')} 스타일 제목은 engagement가 낮음 — 대안 훅 스타일 사용`,
        // @ts-ignore failure taxonomy map value is dynamic runtime data
        typedData.count,
      ]);
    } catch {
      // 무시
    }
  }
}

// ─── 성공 패턴 조회 ──────────────────────────────────────────────────────────

/**
 * 성공 패턴 라이브러리 조회 (topic-selector DPO 힌트용)
 */
async function fetchSuccessPatterns(limit = 10) {
  try {
    const rows = await pgPool.query('blog', `
      SELECT pattern_type, pattern_template, platform, avg_performance, usage_count
      FROM blog.success_pattern_library
      WHERE avg_performance > 50
      ORDER BY avg_performance DESC, usage_count DESC
      LIMIT $1
    `, [limit]);
    return rows || [];
  } catch {
    return [];
  }
}

/**
 * 실패 Taxonomy 조회 (topic-selector 회피용)
 */
async function fetchFailureTaxonomy(limit = 10) {
  try {
    const rows = await pgPool.query('blog', `
      SELECT failure_category, avoidance_hint, frequency_count
      FROM blog.failure_taxonomy
      ORDER BY frequency_count DESC
      LIMIT $1
    `, [limit]);
    return rows || [];
  } catch {
    return [];
  }
}

/**
 * 카테고리별 최고 성과 후킹 스타일 반환 (DPO 힌트)
 */
async function getBestHookStyleByCategory(category) {
  try {
    const rows = await pgPool.query('blog', `
      SELECT features->>'hook_type_a' AS hook_type, AVG((features->>'score_a')::numeric) AS avg_score, COUNT(*) AS cnt
      FROM blog.dpo_preference_pairs
      WHERE features->>'category' = $1
        AND metric_winner = 'a'
      GROUP BY features->>'hook_type_a'
      ORDER BY avg_score DESC
      LIMIT 1
    `, [category]);
    return rows?.[0]?.hook_type || null;
  } catch {
    return null;
  }
}

// ─── 메인 실행 ────────────────────────────────────────────────────────────────

/**
 * 주간 DPO 학습 사이클 실행
 */
async function runDpoLearningCycle(periodDays = 30) {
  if (!isEnabled()) {
    console.log('[marketing-dpo] Kill Switch off — 스킵');
    return { pairs_built: 0, pairs_saved: 0, skipped: true };
  }

  console.log('[marketing-dpo] DPO 학습 사이클 시작');

  // 1. 선호 쌍 생성
  const pairs = await buildPreferencePairs(periodDays);
  console.log(`[marketing-dpo] 선호 쌍 ${pairs.length}개 생성`);

  if (pairs.length === 0) {
    console.log('[marketing-dpo] 데이터 부족 — 종료');
    return { pairs_built: 0, pairs_saved: 0 };
  }

  // 2. LLM 분석 (최대 10쌍만 — 비용 절감)
  const toAnalyze = pairs.slice(0, 10);
  const reasonings = await Promise.all(
    toAnalyze.map(async (pair) => {
      const preferred = { title: pair.features?.title_a, category: pair.features?.category, views_7d: pair.features?.score_a };
      const rejected = { title: pair.features?.title_b, category: pair.features?.category, views_7d: pair.features?.score_b };
      return analyzePairWithLlm(preferred, rejected);
    })
  );

  // 3. 저장
  const saved = await runIfOps(
    'blog.dpo.save',
    () => saveDpoPairs(pairs, reasonings),
    () => pairs.length  // DEV: 실제 DB 저장 없이 개수만 반환
  );

  // 4. 실패 Taxonomy 업데이트
  await runIfOps(
    'blog.dpo.taxonomy',
    () => updateFailureTaxonomy(pairs),
    () => null
  );

  // 5. Telegram 보고
  const summary = `📊 DPO 학습 완료\n선호 쌍: ${pairs.length}개\n저장: ${saved}개\n분석: ${toAnalyze.length}쌍 LLM 분석`;
  await postAlarm(summary, 'general');

  console.log('[marketing-dpo] DPO 학습 사이클 완료');
  return { pairs_built: pairs.length, pairs_saved: saved, analyzed: toAnalyze.length };
}

/**
 * 주제 후보에 DPO 점수 부여 (topic-selector 통합용)
 * @param candidate - { topic, category }
 * @param successPatterns - fetchSuccessPatterns() 결과
 * @param failureTaxonomy - fetchFailureTaxonomy() 결과
 * @returns 0~100 DPO 점수 (높을수록 성공 패턴과 일치)
 */
function calculateDpoScore(candidate, successPatterns, failureTaxonomy) {
  let score = 50; // 기본 점수

  if (!candidate?.topic && !candidate?.title) return score;
  const title = (candidate.topic || candidate.title || '').toLowerCase();
  const hookStyle = classifyHookStyle(title);

  // 성공 패턴과 일치하면 점수 상승
  for (const pattern of successPatterns) {
    if (pattern.pattern_type === 'hook' && pattern.pattern_template === hookStyle) {
      score += Math.min(Number(pattern.avg_performance || 50) - 50, 30);
    }
  }

  // 실패 Taxonomy에 해당하면 점수 하락
  for (const failure of failureTaxonomy) {
    const failHook = (failure.failure_category || '').replace('poor_hook_', '');
    if (failHook === hookStyle) {
      score -= Math.min(Number(failure.frequency_count || 1) * 5, 25);
    }
  }

  return Math.max(0, Math.min(100, score));
}

module.exports = {
  isEnabled,
  fetchPostsWithMetrics,
  buildPreferencePairs,
  analyzePairWithLlm,
  saveDpoPairs,
  updateFailureTaxonomy,
  fetchSuccessPatterns,
  fetchFailureTaxonomy,
  getBestHookStyleByCategory,
  runDpoLearningCycle,
  calcPostScore,
  classifyHookStyle,
  calculateDpoScore,
};
