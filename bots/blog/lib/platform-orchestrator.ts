'use strict';

/**
 * bots/blog/lib/platform-orchestrator.ts
 * 3 플랫폼 (네이버/인스타/페이스북) 통합 발행 오케스트레이터
 *
 * Phase 4: 블로그 글 → 멀티 플랫폼 자동 크로스포스팅
 * Kill Switch: BLOG_MULTI_PLATFORM_ENABLED=true
 *
 * 플랫폼별 최적 전략:
 *   네이버 블로그: 일 1~2편, 1500~3000자, 06:00 발행
 *   인스타그램:   일 1 릴스, 09:00 크로스포스트
 *   페이스북:     일 1편, 10:00 크로스포스트
 */

const { postAlarm } = require('../../../packages/core/lib/openclaw-client');
const { runIfOps } = require('../../../packages/core/lib/mode-guard');
const pgPool = require('../../../packages/core/lib/pg-pool');
const { loadStrategyBundle } = require('./strategy-loader.ts');
const { getRecentPosts, selectAndValidateTopic } = require('./topic-selector.ts');
const { blogToFacebookPost } = require('./cross-platform-adapter.ts');
const { generateTrackingLink, recordPublishAttribution } = require('./attribution-tracker.ts');

const publishReporter = require('./publish-reporter');

function isEnabled() {
  return process.env.BLOG_MULTI_PLATFORM_ENABLED === 'true';
}

// 기본 플랫폼 전략 상수
const PLATFORM_STRATEGY = {
  naver_blog: {
    daily_posts: 1,
    optimal_hours: [6, 11, 18],
    content_length_min: 1500,
    content_length_max: 3000,
    thumbnail_required: true,
    hashtags_max: 10,
    internal_links_min: 1,
  },
  instagram: {
    daily_reels: 1,
    optimal_hours: [9, 12, 20],
    reel_duration_sec: 45,
    caption_length_max: 2200,
    hashtags_max: 30,
    story_posts: 2,
  },
  facebook: {
    daily_posts: 1,
    optimal_hours: [10, 13, 19],
    content_length_optimal: 150,
    share_blog_url: true,
  },
};

function getEffectivePlatformStrategy() {
  const { executionDirectives } = loadStrategyBundle();
  const channelPriority = executionDirectives.channelPriority || {};
  const targets = executionDirectives.executionTargets || {};

  return {
    naver_blog: {
      ...PLATFORM_STRATEGY.naver_blog,
      daily_posts: Math.max(1, Number(targets.blogRegistrationsPerCycle || PLATFORM_STRATEGY.naver_blog.daily_posts || 1)),
      priority: channelPriority.naverBlog || 'primary',
    },
    instagram: {
      ...PLATFORM_STRATEGY.instagram,
      daily_reels: Math.max(0, Number(targets.instagramRegistrationsPerCycle || PLATFORM_STRATEGY.instagram.daily_reels || 1)),
      priority: channelPriority.instagram || 'secondary',
    },
    facebook: {
      ...PLATFORM_STRATEGY.facebook,
      daily_posts: Math.max(0, Number(targets.facebookRegistrationsPerCycle || PLATFORM_STRATEGY.facebook.daily_posts || 1)),
      priority: channelPriority.facebook || 'supporting',
    },
  };
}

async function hasRemainingPublishQuota(platform = 'instagram') {
  const status = await getTodayPublishStatus();
  const strategy = getEffectivePlatformStrategy();
  if (platform === 'instagram') {
    return Number(status.instagram || 0) < Number(strategy.instagram.daily_reels || 0);
  }
  if (platform === 'facebook') {
    return Number(status.facebook || 0) < Number(strategy.facebook.daily_posts || 0);
  }
  if (platform === 'naver') {
    return Number(status.naver || 0) < Number(strategy.naver_blog.daily_posts || 0);
  }
  return true;
}

/**
 * 오늘의 3 플랫폼 발행 상태 조회
 */
async function getTodayPublishStatus() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await pgPool.query('blog', `
      SELECT platform, COUNT(*) AS count, MAX(status) AS last_status
      FROM blog.publish_log
      WHERE DATE(created_at) = $1
      GROUP BY platform
    `, [today]);

    const status = { naver: 0, instagram: 0, facebook: 0 };
    for (const row of (rows || [])) {
      if (row.platform && status[row.platform] !== undefined) {
        status[row.platform] = Number(row.count || 0);
      }
    }
    return status;
  } catch {
    return { naver: 0, instagram: 0, facebook: 0 };
  }
}

/**
 * 오늘 발행된 최신 네이버 블로그 포스팅 조회
 */
async function getLatestTodayPost() {
  try {
    const post = await pgPool.get('blog', `
      SELECT id, title, url, naver_url, category
      FROM blog.posts
      WHERE status = 'published'
        AND DATE(COALESCE(published_at, created_at)) = CURRENT_DATE
      ORDER BY COALESCE(published_at, created_at) DESC
      LIMIT 1
    `);
    return post;
  } catch {
    return null;
  }
}

function buildIndependentContentBody(selection = {}, strategy = {}) {
  const focus = Array.isArray(strategy?.focus) ? strategy.focus.slice(0, 3) : [];
  const recommendations = Array.isArray(selection?.marketingRecommendations)
    ? selection.marketingRecommendations.slice(0, 3)
    : [];
  const keyQuestions = Array.isArray(selection?.keyQuestions)
    ? selection.keyQuestions.slice(0, 3)
    : [];

  return [
    `${selection.title || selection.topic || ''}.`,
    selection.readerProblem ? `지금 독자 문제는 ${selection.readerProblem}입니다.` : '',
    selection.openingAngle ? `이번 콘텐츠는 ${selection.openingAngle}에서 출발합니다.` : '',
    keyQuestions.length ? keyQuestions.map((item, index) => `${index + 1}. ${item}`).join('\n') : '',
    selection.marketingSignalSummary ? `현재 신호는 ${selection.marketingSignalSummary}입니다.` : '',
    recommendations.length ? `실행 포인트:\n${recommendations.map((item) => `- ${item}`).join('\n')}` : '',
    focus.length ? `전략 포커스:\n${focus.map((item) => `- ${item}`).join('\n')}` : '',
    selection.closingAngle ? `마무리 방향은 ${selection.closingAngle}입니다.` : '',
  ].filter(Boolean).join('\n\n');
}

async function buildIndependentPlatformCampaign(options = {}) {
  const needInstagram = options.needInstagram !== false;
  const needFacebook = options.needFacebook !== false;
  const { plan } = loadStrategyBundle();
  const category = String(plan?.preferredCategory || 'IT정보와분석');
  const recentPosts = getRecentPosts(category, 8);
  const selection = selectAndValidateTopic(
    category,
    recentPosts,
    plan,
    null,
    null,
    recentPosts.map((post) => post.title).filter(Boolean)
  );
  const syntheticPostId = `social_${Date.now()}`;
  const content = buildIndependentContentBody(selection, plan || {});
  const title = String(selection?.title || selection?.topic || `${category} 전략 포인트`);
  const trackingInstagram = generateTrackingLink(`${syntheticPostId}_instagram`, 'instagram');
  const trackingFacebook = generateTrackingLink(`${syntheticPostId}_facebook`, 'facebook');
  let instaContent = null;
  if (needInstagram) {
    const starSocial = require('./star.ts');
    instaContent = await starSocial.createInstaContent(content, title, category, 0, {
      strategy: plan,
      blogUrl: trackingInstagram.url,
    });
  }

  const facebookContent = needFacebook
    ? blogToFacebookPost({
        title,
        content,
        category,
        url: trackingFacebook.url,
      }, 200, plan)
    : null;

  return {
    id: syntheticPostId,
    title,
    category,
    url: trackingFacebook.url,
    naver_url: trackingFacebook.url,
    synthetic: true,
    sourceMode: 'strategy_native',
    instaContent,
    facebookContent,
    tracking: {
      instagram: trackingInstagram,
      facebook: trackingFacebook,
    },
    topicSelection: selection,
  };
}

/**
 * 인스타그램 크로스포스트 (최신 블로그 글 기반)
 * @param {object} blogPost 네이버 블로그 포스팅 정보
 * @param {boolean} dryRun
 */
async function crosspostToInstagram(blogPost, dryRun = false) {
  try {
    const crossposter = require('./insta-crosspost');
    const payload = blogPost?.sourceMode === 'strategy_native'
      ? blogPost?.instaContent
      : { caption: `${blogPost.title}\n\n#스터디카페 #집중력 #공부 #개발`, thumbnailUrl: blogPost.thumbnail_url };
    const result = await crossposter.crosspostToInstagram(
      payload,
      blogPost.title,
      String(blogPost.id || ''),
      dryRun,
    );
    if (result?.ok && blogPost?.sourceMode === 'strategy_native') {
      await recordPublishAttribution(
        String(blogPost.id || ''),
        blogPost.title,
        blogPost?.tracking?.instagram?.url || blogPost.naver_url || blogPost.url || '',
        new Date(),
        'instagram'
      ).catch(() => {});
    }
    return result;
  } catch (err) {
    console.warn('[platform-orchestrator] 인스타 크로스포스트 실패:', err.message);
    return null;
  }
}

/**
 * 페이스북 크로스포스트 (최신 블로그 글 기반)
 * @param {object} blogPost 네이버 블로그 포스팅 정보
 * @param {boolean} dryRun
 */
async function crosspostToFacebook(blogPost, dryRun = false) {
  try {
    const fbPublisher = require('./facebook-publisher');
    const prepared = blogPost?.sourceMode === 'strategy_native'
      ? (blogPost.facebookContent || {})
      : {
          message: `${blogPost.title} - 스터디카페 공부법과 자기계발 이야기를 나눕니다.`,
          link: blogPost.naver_url || blogPost.url || '',
        };
    const result = await fbPublisher.publishFacebookPost({
      message: prepared.message,
      link: prepared.link || blogPost.naver_url || blogPost.url || '',
      dryRun,
    });
    if (result?.postId && blogPost?.sourceMode === 'strategy_native') {
      await recordPublishAttribution(
        String(blogPost.id || ''),
        blogPost.title,
        prepared.link || blogPost.naver_url || blogPost.url || '',
        new Date(),
        'facebook'
      ).catch(() => {});
    }
    return result;
  } catch (err) {
    console.warn('[platform-orchestrator] 페이스북 크로스포스트 실패:', err.message);
    return null;
  }
}

/**
 * 3 플랫폼 통합 발행 상태 보고 (일일 오케스트레이션 완료 시)
 */
async function sendDailyOrchestrationReport(status) {
  const strategy = getEffectivePlatformStrategy();
  const naverStatus = status.naver > 0 ? `✅ ${status.naver}/${strategy.naver_blog.daily_posts}편` : `❌ 0/${strategy.naver_blog.daily_posts}`;
  const igStatus = status.instagram > 0 ? `✅ ${status.instagram}/${strategy.instagram.daily_reels}건` : `⏳ 0/${strategy.instagram.daily_reels}`;
  const fbStatus = status.facebook > 0 ? `✅ ${status.facebook}/${strategy.facebook.daily_posts}건` : `⏳ 0/${strategy.facebook.daily_posts}`;

  const msg = `📢 [블로팀] 3 플랫폼 발행 현황\n`
    + `📝 네이버: ${naverStatus}\n`
    + `📷 인스타: ${igStatus}\n`
    + `👥 페북: ${fbStatus}\n`
    + `🎯 priority: 네이버=${strategy.naver_blog.priority} / 인스타=${strategy.instagram.priority} / 페북=${strategy.facebook.priority}`;

  await runIfOps(
    'blog-orchestration-report',
    () => postAlarm({ message: msg, team: 'blog', bot: 'platform-orchestrator', level: 'info' }),
    () => console.log('[DEV]', msg),
  ).catch(() => {});
}

/**
 * 일일 플랫폼 오케스트레이션 실행
 * 네이버 블로그 발행은 ai.blog.daily에서 이미 처리됨
 * 이 함수는 인스타/페북 크로스포스트 + 상태 보고를 담당
 */
async function orchestrateDailyPublishing(dryRun = false) {
  if (!isEnabled()) {
    console.log('[platform-orchestrator] BLOG_MULTI_PLATFORM_ENABLED=false — 건너뜀');
    return null;
  }

  const [igQuota, fbQuota] = await Promise.all([
    hasRemainingPublishQuota('instagram'),
    hasRemainingPublishQuota('facebook'),
  ]);
  const latestBlogPost = await getLatestTodayPost();
  const blogPost = latestBlogPost || ((igQuota || fbQuota)
    ? await buildIndependentPlatformCampaign({ needInstagram: igQuota, needFacebook: fbQuota })
    : null);
  if (!blogPost) {
    console.log('[platform-orchestrator] 오늘 발행된 네이버 포스팅도 없고 실행할 전략 기반 플랫폼 quota도 없음 — 건너뜀');
    return null;
  }

  console.log(`[platform-orchestrator] 오케스트레이션 시작 — "${blogPost.title}" (${blogPost.sourceMode || 'naver_post'})`);
  const [igResult, fbResult] = await Promise.allSettled([
    igQuota ? crosspostToInstagram(blogPost, dryRun) : Promise.resolve({ ok: false, skipped: true, reason: 'strategy_quota_reached' }),
    fbQuota ? crosspostToFacebook(blogPost, dryRun) : Promise.resolve({ ok: false, skipped: true, reason: 'strategy_quota_reached' }),
  ]);

  const igSuccess = igResult.status === 'fulfilled' && igResult.value?.ok !== false;
  const fbSuccess = fbResult.status === 'fulfilled' && fbResult.value !== null;

  // 발행 성공/실패 보고
  if (!dryRun) {
    if (igSuccess) {
      await publishReporter.reportPublishSuccess('instagram', blogPost.title, blogPost.naver_url || blogPost.url || '', {
        previewBundle: blogPost.sourceMode || 'naver_post',
        postId: blogPost.id || null,
      }).catch(() => {});
    } else {
      const igErr = igResult.status === 'rejected'
        ? (igResult.reason?.message || '알 수 없는 오류')
        : '알 수 없는 오류';
      await publishReporter.reportPublishFailure('instagram', blogPost.title, igErr, {
        previewBundle: blogPost.sourceMode || 'naver_post',
        postId: blogPost.id || null,
      }).catch(() => {});
    }

    if (fbSuccess) {
      await publishReporter.reportPublishSuccess('facebook', blogPost.title, blogPost.naver_url || blogPost.url || '', {
        previewBundle: blogPost.sourceMode || 'naver_post',
        postId: blogPost.id || null,
      }).catch(() => {});
    } else {
      const fbErr = fbResult.status === 'rejected'
        ? (fbResult.reason?.message || '알 수 없는 오류')
        : '알 수 없는 오류';
      await publishReporter.reportPublishFailure('facebook', blogPost.title, fbErr, {
        previewBundle: blogPost.sourceMode || 'naver_post',
        postId: blogPost.id || null,
      }).catch(() => {});
    }
  }

  const status = await getTodayPublishStatus();
  await sendDailyOrchestrationReport(status);

  return {
    blogPost,
    instagram: { success: igSuccess },
    facebook: { success: fbSuccess },
    status,
  };
}

module.exports = {
  isEnabled,
  orchestrateDailyPublishing,
  crosspostToInstagram,
  crosspostToFacebook,
  buildIndependentPlatformCampaign,
  getTodayPublishStatus,
  getLatestTodayPost,
  sendDailyOrchestrationReport,
  PLATFORM_STRATEGY,
  getEffectivePlatformStrategy,
  hasRemainingPublishQuota,
};
