#!/usr/bin/env node
'use strict';

/**
 * bots/blog/scripts/auto-facebook-publish.ts
 *
 * 오늘 발행된 최신 블로그 포스트를 Facebook 페이지에 자동 공유.
 * 성공/실패 결과를 Telegram으로 보고.
 *
 * launchd ai.blog.facebook-publish에서 매일 19:00 KST 실행.
 */

const path = require('path');
const env = require('../../../packages/core/lib/env');
const pgPool = require('../../../packages/core/lib/pg-pool');
const { runIfOps } = require('../../../packages/core/lib/mode-guard');
const { postAlarm } = require('../../../packages/core/lib/openclaw-client');
const { publishFacebookPost } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/facebook-publisher.ts'));
const { reportPublishSuccess, reportPublishFailure } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/publish-reporter.ts'));

const DRY_RUN = process.argv.includes('--dry-run');

/**
 * @typedef {{
 *   postId: string | number | null,
 *   postTitle: string | null,
 *   fbPostId?: string | null,
 *   status: string,
 *   errorMsg?: string | null
 * }} FacebookPublishRecord
 */

async function getTodayLatestPost() {
  const rows = await pgPool.query('blog', `
    SELECT id, title, naver_url, category, post_type
    FROM blog.posts
    WHERE publish_date = CURRENT_DATE
      AND status = 'published'
    ORDER BY COALESCE(publish_date::timestamp, created_at) DESC, id DESC
    LIMIT 1
  `);
  return rows?.[0] || null;
}

async function hasFacebookPublishToday() {
  try {
    const rows = await pgPool.query('blog', `
      SELECT COUNT(*)::int AS cnt
      FROM blog.facebook_publish_log
      WHERE publish_date = CURRENT_DATE
        AND status = 'ok'
    `);
    return (rows?.[0]?.cnt || 0) > 0;
  } catch {
    // 테이블 없으면 미발행으로 처리
    return false;
  }
}

/** @param {FacebookPublishRecord} record */
async function recordFacebookPublish({ postId, postTitle, fbPostId = null, status, errorMsg = null }) {
  try {
    await pgPool.query('blog', `
      INSERT INTO blog.facebook_publish_log
        (post_id, post_title, fb_post_id, status, error_msg, publish_date)
      VALUES ($1, $2, $3, $4, $5, CURRENT_DATE)
      ON CONFLICT DO NOTHING
    `, [postId || null, postTitle || null, fbPostId || null, status, errorMsg || null]);
  } catch {
    // 테이블 미존재 시 무시 (migration 전)
  }
}

async function main() {
  console.log(`[facebook-auto] 시작 dryRun=${DRY_RUN}`);

  const post = await getTodayLatestPost();
  if (!post) {
    console.log('[facebook-auto] 오늘 발행된 포스트 없음 — 생략');
    return;
  }

  const alreadyPublished = await hasFacebookPublishToday();
  if (alreadyPublished) {
    console.log('[facebook-auto] 오늘 이미 Facebook 발행 완료 — 생략');
    return;
  }

  const { id: postId, title, naver_url: naverUrl, category } = post;
  const message = [
    `📝 새 포스팅이 올라왔습니다!`,
    ``,
    `제목: ${title}`,
    `카테고리: ${category || '일반'}`,
    naverUrl ? `\n블로그 링크 ▼` : '',
  ].filter(line => line !== undefined).join('\n').trim();

  console.log(`[facebook-auto] 발행 대상: "${title}" naverUrl=${naverUrl || 'none'}`);

  try {
    const result = await publishFacebookPost({
      message,
      link: naverUrl || '',
      dryRun: DRY_RUN,
    });

    if (DRY_RUN) {
      console.log('[facebook-auto][dry-run] 발행 시뮬레이션 완료');
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    await recordFacebookPublish({ postId, postTitle: title, fbPostId: result.postId, status: 'ok' });
    await reportPublishSuccess('facebook', title, naverUrl || '');
    console.log(`[facebook-auto] 발행 성공 fbPostId=${result.postId}`);

  } catch (err) {
    console.error('[facebook-auto] 발행 실패:', err.message);
    await recordFacebookPublish({ postId, postTitle: title, status: 'failed', errorMsg: err.message });
    await reportPublishFailure('facebook', title, err.message);
  }
}

main().catch(err => {
  console.error('[facebook-auto] 치명적 오류:', err.message);
  process.exit(1);
});
