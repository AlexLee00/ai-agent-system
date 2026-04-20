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
const { ensurePublishLogSchema, reportPublishSuccess, reportPublishFailure } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/publish-reporter.ts'));

const DRY_RUN = process.argv.includes('--dry-run');

async function getTodayLatestPost() {
  const rows = await pgPool.query('blog', `
    SELECT id, title, naver_url, category, post_type, status
    FROM blog.posts
    WHERE publish_date = CURRENT_DATE
      AND status IN ('published', 'ready')
    ORDER BY
      CASE WHEN status = 'published' THEN 0 ELSE 1 END,
      COALESCE(publish_date::timestamp, created_at) DESC,
      id DESC
    LIMIT 1
  `);
  return rows?.[0] || null;
}

async function hasFacebookPublishToday() {
  try {
    await ensurePublishLogSchema();
    const rows = await pgPool.query('blog', `
      SELECT COUNT(*)::int AS cnt
      FROM blog.publish_log
      WHERE platform = 'facebook'
        AND status = 'success'
        AND COALESCE(dry_run, false) = false
        AND DATE(created_at AT TIME ZONE 'Asia/Seoul') = timezone('Asia/Seoul', now())::date
    `);
    return (rows?.[0]?.cnt || 0) > 0;
  } catch {
    return false;
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

  const { id: postId, title, naver_url: naverUrl, category, status: postStatus } = post;
  const message = [
    `📝 새 포스팅이 올라왔습니다!`,
    ``,
    `제목: ${title}`,
    `카테고리: ${category || '일반'}`,
    naverUrl ? `\n블로그 링크 ▼` : '',
  ].filter(line => line !== undefined).join('\n').trim();

  console.log(`[facebook-auto] 발행 대상: "${title}" status=${postStatus || 'unknown'} naverUrl=${naverUrl || 'none'}`);
  if (postStatus === 'ready' && !naverUrl) {
    console.log('[facebook-auto] published 미확정 포스트를 링크 없이 Facebook teaser로 발행합니다.');
  }

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

    await reportPublishSuccess('facebook', title, naverUrl || '', { postId });
    console.log(`[facebook-auto] 발행 성공 fbPostId=${result.postId}`);

  } catch (err) {
    const rawMessage = String(err?.rawMessage || err?.message || '');
    console.error('[facebook-auto] 발행 실패:', err.message);
    if (rawMessage && rawMessage !== err.message) {
      console.error('[facebook-auto] raw failure:', rawMessage);
    }
    await reportPublishFailure('facebook', title, err.message, { postId });
  }
}

main().catch(err => {
  console.error('[facebook-auto] 치명적 오류:', err.message);
  process.exit(1);
});
