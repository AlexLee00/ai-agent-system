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

/**
 * 인스타그램 크로스포스트 (최신 블로그 글 기반)
 * @param {object} blogPost 네이버 블로그 포스팅 정보
 * @param {boolean} dryRun
 */
async function crosspostToInstagram(blogPost, dryRun = false) {
  try {
    const crossposter = require('./insta-crosspost');
    // 인스타 콘텐츠 준비 (제목 + URL)
    const caption = `${blogPost.title}\n\n#스터디카페 #집중력 #공부 #개발`;
    const result = await crossposter.crosspostToInstagram(
      { caption, thumbnailUrl: blogPost.thumbnail_url },
      blogPost.title,
      String(blogPost.id || ''),
      dryRun,
    );
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
    const summary = `${blogPost.title} - 스터디카페 공부법과 자기계발 이야기를 나눕니다.`;
    const result = await fbPublisher.publishFacebookPost({
      message: summary,
      link: blogPost.naver_url || blogPost.url || '',
      dryRun,
    });
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
  const naverStatus = status.naver > 0 ? `✅ ${status.naver}편` : '❌ 없음';
  const igStatus = status.instagram > 0 ? `✅ ${status.instagram}건` : '⏳ 대기';
  const fbStatus = status.facebook > 0 ? `✅ ${status.facebook}건` : '⏳ 대기';

  const msg = `📢 [블로팀] 3 플랫폼 발행 현황\n`
    + `📝 네이버: ${naverStatus}\n`
    + `📷 인스타: ${igStatus}\n`
    + `👥 페북: ${fbStatus}`;

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

  const blogPost = await getLatestTodayPost();
  if (!blogPost) {
    console.log('[platform-orchestrator] 오늘 발행된 네이버 포스팅 없음 — 건너뜀');
    return null;
  }

  console.log(`[platform-orchestrator] 오케스트레이션 시작 — "${blogPost.title}"`);

  const [igResult, fbResult] = await Promise.allSettled([
    crosspostToInstagram(blogPost, dryRun),
    crosspostToFacebook(blogPost, dryRun),
  ]);

  const igSuccess = igResult.status === 'fulfilled' && igResult.value?.ok !== false;
  const fbSuccess = fbResult.status === 'fulfilled' && fbResult.value !== null;

  // 발행 성공/실패 보고
  if (!dryRun) {
    if (igSuccess) {
      await publishReporter.reportPublishSuccess('instagram', blogPost.title, '').catch(() => {});
    } else {
      const igErr = igResult.reason?.message || '알 수 없는 오류';
      await publishReporter.reportPublishFailure('instagram', blogPost.title, igErr).catch(() => {});
    }

    if (fbSuccess) {
      await publishReporter.reportPublishSuccess('facebook', blogPost.title, '').catch(() => {});
    } else {
      const fbErr = fbResult.reason?.message || '알 수 없는 오류';
      await publishReporter.reportPublishFailure('facebook', blogPost.title, fbErr).catch(() => {});
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
  getTodayPublishStatus,
  getLatestTodayPost,
  sendDailyOrchestrationReport,
  PLATFORM_STRATEGY,
};
