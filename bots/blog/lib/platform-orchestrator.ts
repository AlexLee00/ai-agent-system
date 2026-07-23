// @ts-nocheck
'use strict';

/**
 * bots/blog/lib/platform-orchestrator.ts
 * 과거 네이버/인스타/페이스북 통합 발행 오케스트레이터.
 *
 * Instagram/Facebook 실행 경로는 2026-07-23 은퇴했다. 호환용 변환
 * helper와 상태 조회만 남기고 모든 게시 진입점은 retired 결과를 반환한다.
 *
 * 플랫폼별 최적 전략:
 *   네이버 블로그: 일 1~2편, 1500~3000자, 06:00 발행
 *   인스타그램:   일 1 릴스, 09:00 크로스포스트
 *   페이스북:     일 1편, 10:00 크로스포스트
 */

const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');
const { runIfOps } = require('../../../packages/core/lib/mode-guard');
const pgPool = require('../../../packages/core/lib/pg-pool');
const { loadStrategyBundle } = require('./strategy-loader.ts');
const { buildRetiredFeatureResult } = require('./retirement-policy.ts');

function isEnabled() {
  return false;
}

function isSnsCrosspostEnabled() {
  return false;
}

function buildSnsCrosspostDisabledResult(platform = 'sns') {
  return {
    ...buildRetiredFeatureResult(platform),
    platform,
    snsCrosspostEnabled: false,
  };
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
    daily_reels: 0,
    optimal_hours: [9, 12, 20],
    reel_duration_sec: 45,
    caption_length_max: 2200,
    hashtags_max: 30,
    story_posts: 0,
  },
  facebook: {
    daily_posts: 0,
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
      daily_reels: 0,
      story_posts: 0,
      priority: 'retired',
    },
    facebook: {
      ...PLATFORM_STRATEGY.facebook,
      daily_posts: 0,
      priority: 'retired',
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

async function buildIndependentPlatformCampaign(options = {}) {
  return buildSnsCrosspostDisabledResult('independent_campaign');
}

/**
 * 인스타그램 크로스포스트 (최신 블로그 글 기반)
 * @param {object} blogPost 네이버 블로그 포스팅 정보
 * @param {boolean} dryRun
 */
async function crosspostToInstagram(blogPost, dryRun = false) {
  return buildSnsCrosspostDisabledResult('instagram');
}

/**
 * 페이스북 크로스포스트 (최신 블로그 글 기반)
 * @param {object} blogPost 네이버 블로그 포스팅 정보
 * @param {boolean} dryRun
 */
async function crosspostToFacebook(blogPost, dryRun = false) {
  return buildSnsCrosspostDisabledResult('facebook');
}

async function runStrategyNativeFollowup(platform, dryRun = false) {
  return buildSnsCrosspostDisabledResult(platform);
}

/**
 * 3 플랫폼 통합 발행 상태 보고 (일일 오케스트레이션 완료 시)
 */
async function sendDailyOrchestrationReport(status) {
  const strategy = getEffectivePlatformStrategy();
  const naverStatus = status.naver > 0 ? `✅ ${status.naver}/${strategy.naver_blog.daily_posts}편` : `❌ 0/${strategy.naver_blog.daily_posts}`;
  const msg = `📢 [블로팀] 네이버 발행 현황\n`
    + `📝 네이버: ${naverStatus}\n`
    + '📷 인스타·👥 페북: retired';

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
  return buildSnsCrosspostDisabledResult('orchestrator');
}

module.exports = {
  isEnabled,
  isSnsCrosspostEnabled,
  buildSnsCrosspostDisabledResult,
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
