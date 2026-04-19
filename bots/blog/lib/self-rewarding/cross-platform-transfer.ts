'use strict';

/**
 * bots/blog/lib/self-rewarding/cross-platform-transfer.ts
 * Cross-Platform Transfer Learning — 플랫폼 간 성공 패턴 이전
 *
 * Phase 6: 인스타 성공 패턴 → 네이버 블로그/페이스북 적용
 * Kill Switch: BLOG_DPO_ENABLED=true
 */

const pgPool = require('../../../../packages/core/lib/pg-pool');

function isEnabled() {
  return process.env.BLOG_DPO_ENABLED === 'true';
}

// ─── 플랫폼별 성공 후킹 패턴 추출 ────────────────────────────────────────────

/**
 * 특정 플랫폼에서 최근 N일 고성과 포스팅의 후킹 패턴 추출
 */
async function extractSuccessfulHooks(platform, days = 30) {
  try {
    const rows = await pgPool.query('blog', `
      SELECT
        p.title,
        COALESCE(cp.engagement_rate, pf.engagement_rate, 0) AS eng_rate,
        COALESCE(cp.views, pf.total_views_7d, 0) AS views
      FROM blog.posts p
      LEFT JOIN blog.channel_performance cp ON cp.post_id::text = p.id::text AND cp.channel = $1
      LEFT JOIN blog.post_performance pf ON pf.post_id::text = p.id::text
      WHERE p.status = 'published'
        AND COALESCE(p.published_at, p.created_at) > NOW() - ($2::text || ' days')::interval
        AND COALESCE(cp.engagement_rate, pf.engagement_rate, 0) > 0.03
      ORDER BY COALESCE(cp.engagement_rate, pf.engagement_rate, 0) DESC
      LIMIT 20
    `, [platform, days]);

    return (rows || []).map((r) => ({
      title: r.title,
      engagement_rate: Number(r.eng_rate || 0),
      views: Number(r.views || 0),
      hook_style: classifyHookStyle(r.title),
      hook_words: extractHookWords(r.title),
    }));
  } catch {
    return [];
  }
}

/**
 * 제목 후킹 스타일 분류
 */
function classifyHookStyle(title) {
  if (!title) return 'unknown';
  if (/\d+가지|\d+개|TOP\s*\d+/i.test(title)) return 'list';
  if (/왜|이유|때문/.test(title)) return 'why';
  if (/방법|비결|전략/.test(title)) return 'how';
  if (/뭐가|무엇|어떤|어떻게/.test(title)) return 'question';
  if (/vs|비교/.test(title)) return 'comparison';
  if (/실수|하면 안 되는|피해야/.test(title)) return 'mistake';
  if (/완벽|최고|최강|무조건/.test(title)) return 'superlative';
  return 'statement';
}

/**
 * 제목에서 고성과 후킹 단어 추출
 */
function extractHookWords(title) {
  if (!title) return [];
  const hookWords = ['방법', '비결', '전략', '이유', '핵심', '실수', '완벽', '최강', '무조건', '즉시', '바로', '진짜', '팁', '노하우', '실전', '가이드'];
  return hookWords.filter((w) => title.includes(w));
}

// ─── 플랫폼 간 패턴 변환 ────────────────────────────────────────────────────

/**
 * 인스타 후킹 패턴 → 네이버 블로그 제목 템플릿 변환
 */
function adaptHooksToBlogTitles(igHooks) {
  const templates = [];

  for (const hook of igHooks) {
    const style = hook.hook_style;

    if (style === 'list') {
      templates.push({
        template: `{주제} {숫자}가지 방법 — 실제로 효과 있는 것만`,
        base_style: 'list',
        confidence: 0.85,
        source_platform: 'instagram',
        sample_title: hook.title,
      });
    } else if (style === 'why') {
      templates.push({
        template: `{주제}가 잘 안 되는 진짜 이유 (그리고 해결책)`,
        base_style: 'why',
        confidence: 0.80,
        source_platform: 'instagram',
        sample_title: hook.title,
      });
    } else if (style === 'how') {
      templates.push({
        template: `{주제} 제대로 하는 방법 — 많이들 놓치는 핵심`,
        base_style: 'how',
        confidence: 0.78,
        source_platform: 'instagram',
        sample_title: hook.title,
      });
    } else if (style === 'mistake') {
      templates.push({
        template: `{주제}에서 하면 안 되는 실수 {숫자}가지`,
        base_style: 'mistake',
        confidence: 0.82,
        source_platform: 'instagram',
        sample_title: hook.title,
      });
    }
  }

  // 중복 스타일 제거 (confidence 높은 것 유지)
  const seen = new Set();
  return templates.filter((t) => {
    if (seen.has(t.base_style)) return false;
    seen.add(t.base_style);
    return true;
  });
}

/**
 * 인스타 후킹 패턴 → 페이스북 포스트 템플릿 변환
 * (짧고 직접적인 스타일 — 페북은 80~200자 최적)
 */
function adaptHooksToFacebook(igHooks) {
  const templates = [];

  for (const hook of igHooks) {
    const style = hook.hook_style;

    if (style === 'list') {
      templates.push({
        template: `{주제}에 대해 모르면 손해인 {숫자}가지 → 자세히 보기 👇`,
        base_style: 'list',
        confidence: 0.80,
        source_platform: 'instagram',
      });
    } else if (style === 'why') {
      templates.push({
        template: `"{주제}가 안 되는 이유"를 정리했습니다. 공감되시면 공유해주세요 🙏`,
        base_style: 'why',
        confidence: 0.75,
        source_platform: 'instagram',
      });
    } else if (style === 'how') {
      templates.push({
        template: `{주제} 이렇게 하면 됩니다. 블로그에 자세히 정리했어요 →`,
        base_style: 'how',
        confidence: 0.77,
        source_platform: 'instagram',
      });
    }
  }

  const seen = new Set();
  return templates.filter((t) => {
    if (seen.has(t.base_style)) return false;
    seen.add(t.base_style);
    return true;
  });
}

// ─── 저장 ─────────────────────────────────────────────────────────────────────

/**
 * 이전 학습 결과 DB 저장
 */
async function saveTransferLearning(learnedFrom, appliedTo, templates) {
  if (!templates || templates.length === 0) return 0;

  let saved = 0;
  for (const template of templates) {
    try {
      await pgPool.query('blog', `
        INSERT INTO blog.success_pattern_library
          (pattern_type, pattern_template, platform, avg_performance, usage_count, first_seen_at, last_used_at)
        VALUES ('title_template', $1, $2, $3, 0, NOW(), NOW())
        ON CONFLICT (pattern_type, pattern_template, platform)
        DO UPDATE SET
          avg_performance = (blog.success_pattern_library.avg_performance + $3) / 2,
          last_used_at = NOW()
      `, [
        template.template,
        appliedTo,
        Math.round((template.confidence || 0.7) * 100),
      ]);
      saved++;
    } catch {
      // 무시
    }
  }
  return saved;
}

// ─── 메인 실행 ────────────────────────────────────────────────────────────────

/**
 * Cross-Platform 이전 학습 실행
 * @param sourcePlatform 소스 플랫폼 (기본 'instagram')
 */
async function runTransferLearning(sourcePlatform = 'instagram') {
  if (!isEnabled()) {
    console.log('[cross-platform-transfer] Kill Switch off — 스킵');
    return { skipped: true };
  }

  console.log('[cross-platform-transfer] 플랫폼 간 이전 학습 시작');

  // 소스 플랫폼 성공 패턴 추출
  const sourceHooks = await extractSuccessfulHooks(sourcePlatform, 30);
  console.log(`[cross-platform-transfer] ${sourcePlatform} 성공 후킹 ${sourceHooks.length}개 추출`);

  if (sourceHooks.length === 0) {
    console.log('[cross-platform-transfer] 데이터 부족 — 기본 결과 반환');
    return { learned_from: sourcePlatform, source_hooks: 0, applied_to: [], templates: { blog: [], facebook: [] }, saved: { blog: 0, facebook: 0 } };
  }

  const learnedFrom = sourcePlatform;

  // 다른 플랫폼용 템플릿 변환
  const blogTemplates = adaptHooksToBlogTitles(sourceHooks);
  const fbTemplates = adaptHooksToFacebook(sourceHooks);

  // 저장
  const blogSaved = await saveTransferLearning(learnedFrom, 'naver', blogTemplates);
  const fbSaved = await saveTransferLearning(learnedFrom, 'facebook', fbTemplates);

  console.log(`[cross-platform-transfer] 블로그 템플릿 ${blogSaved}개, 페북 템플릿 ${fbSaved}개 저장`);

  return {
    learned_from: learnedFrom,
    source_hooks: sourceHooks.length,
    applied_to: ['naver_blog', 'facebook'],
    templates: { blog: blogTemplates, facebook: fbTemplates },
    saved: { blog: blogSaved, facebook: fbSaved },
    confidence: 0.75,
  };
}

module.exports = {
  isEnabled,
  extractSuccessfulHooks,
  classifyHookStyle,
  extractHookWords,
  adaptHooksToBlogTitles,
  adaptHooksToFacebook,
  saveTransferLearning,
  runTransferLearning,
};
