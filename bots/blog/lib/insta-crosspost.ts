'use strict';

/**
 * bots/blog/lib/insta-crosspost.ts — 인스타 자동 크로스포스팅
 *
 * Phase D: 블로그 발행 후 자동으로 인스타 릴스 업로드
 * - 릴스 파일 존재 시 publishInstagramReel() 호출
 * - 토큰 오류 시 긴급 알람 + DB 기록
 * - 실패해도 블로그 발행에 영향 없음 (non-blocking)
 */

const path = require('path');
const env = require('../../../packages/core/lib/env');

const { publishInstagramReel, buildHostedVideoUrl } = require(
  path.join(env.PROJECT_ROOT, 'packages/core/lib/instagram-graph.ts')
);
const { parseInstagramAuthError } = require(
  path.join(env.PROJECT_ROOT, 'packages/core/lib/instagram-token-manager.ts')
);
const pgPool = require('../../../packages/core/lib/pg-pool');
const { runIfOps } = require('../../../packages/core/lib/mode-guard');
const { postAlarm } = require('../../../packages/core/lib/openclaw-client');

/**
 * @typedef {{
 *   postId?: number | null,
 *   postTitle?: string | null,
 *   videoPath?: string | null,
 *   caption?: string | null,
 *   status: string,
 *   creationId?: string | null,
 *   publishId?: string | null,
 *   errorMsg?: string | null,
 *   dryRun?: boolean
 * }} InstagramCrosspostRecord
 */

/**
 * DB에 크로스포스트 결과 기록
 */
/** @param {InstagramCrosspostRecord} record */
async function recordCrosspost({
  postId = null,
  postTitle = null,
  videoPath = null,
  caption = null,
  status,
  creationId = null,
  publishId = null,
  errorMsg = null,
  dryRun = false,
}) {
  try {
    await pgPool.query('blog', `
      INSERT INTO blog.instagram_crosspost
        (post_id, post_title, video_path, caption, status, creation_id, publish_id, error_msg, dry_run)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      postId || null,
      postTitle || null,
      videoPath || null,
      (caption || '').slice(0, 2000),
      status,
      creationId || null,
      publishId || null,
      errorMsg || null,
      dryRun || false,
    ]);
  } catch (err) {
    console.warn('[크로스포스트] DB 기록 실패:', err.message);
  }
}

/**
 * 토큰 오류 긴급 알람
 */
async function notifyTokenError(errMsg, diagnosis) {
  const code = diagnosis?.code || 'unknown';
  const note = diagnosis?.note || '';
  await runIfOps(
    'insta-token-alarm',
    () => postAlarm({
      message: `[블로팀] 🚨 인스타 토큰 오류\n코드: ${code}\n메모: ${note}\n원인: ${errMsg}`,
      team: 'blog',
      bot: 'insta-crosspost',
      level: 'critical',
    }),
    () => console.warn('[DEV] 인스타 토큰 오류 알람 생략:', code)
  );
}

/**
 * 인스타 릴스 크로스포스팅
 *
 * @param {{ reel?: { outputPath?: string }, fullText?: string, caption?: string }} instaContent
 * @param {string}  postTitle     - 블로그 포스트 제목
 * @param {number|null} postId    - blog.posts.id (선택)
 * @param {boolean} dryRun
 * @returns {{ ok, skipped?, reason?, publishId?, creationId?, status, error? }}
 */
async function crosspostToInstagram(instaContent, postTitle, postId = null, dryRun = false) {
  const reelPath = instaContent?.reel?.outputPath;

  if (!reelPath) {
    console.log('[크로스포스트] 릴스 파일 없음 — 인스타 게시 생략');
    await recordCrosspost({ postId, postTitle, status: 'skipped', errorMsg: 'no_reel', dryRun });
    return { ok: false, skipped: true, reason: 'no_reel' };
  }

  if (dryRun) {
    console.log(`[크로스포스트][dry-run] 릴스 게시 생략: ${path.basename(reelPath)}`);
    await recordCrosspost({ postId, postTitle, videoPath: reelPath, status: 'skipped', errorMsg: 'dry_run', dryRun: true });
    return { ok: false, skipped: true, reason: 'dry_run' };
  }

  const caption = instaContent.fullText || instaContent.caption || `📝 ${postTitle}\n\n#개발자일상 #IT블로그 #승호아빠 #cafe_library`;

  try {
    const videoUrl = buildHostedVideoUrl(reelPath);
    const result = await publishInstagramReel({ videoUrl, caption });

    await recordCrosspost({
      postId, postTitle, videoPath: reelPath, caption,
      status: 'ok',
      creationId: result.creationId,
      publishId: result.publishId,
      dryRun: false,
    });

    console.log(`[크로스포스트] 인스타 업로드 성공: publishId=${result.publishId}`);
    await runIfOps(
      'blog-insta-publish-ok',
      () => postAlarm({
        message: `✅ [블로팀] 인스타 발행 성공\n글: ${postTitle}\npublishId: ${result.publishId}`,
        team: 'blog',
        bot: 'insta-crosspost',
        level: 'info',
      }),
      () => {}
    ).catch(() => {});
    return { ok: true, publishId: result.publishId, creationId: result.creationId, status: 'ok' };

  } catch (err) {
    const diagnosis = parseInstagramAuthError(err);
    const isTokenError = diagnosis?.code && diagnosis.code !== 'unknown_auth_error';
    const status = isTokenError ? 'token_error' : 'failed';

    await recordCrosspost({
      postId, postTitle, videoPath: reelPath, caption,
      status, errorMsg: err.message, dryRun: false,
    });

    if (isTokenError) {
      await notifyTokenError(err.message, diagnosis).catch(() => {});
    }

    console.warn(`[크로스포스트] 인스타 업로드 실패 (${status}): ${err.message}`);
    return { ok: false, status, error: err.message };
  }
}

/**
 * 최근 N일 크로스포스트 성과 집계
 */
async function getCrosspostStats(days = 7) {
  try {
    const rows = await pgPool.query('blog', `
      SELECT
        COUNT(*)::int                                       AS total,
        COUNT(*) FILTER (WHERE status = 'ok')::int          AS ok_count,
        COUNT(*) FILTER (WHERE status = 'failed')::int      AS fail_count,
        COUNT(*) FILTER (WHERE status = 'token_error')::int AS token_error_count,
        COUNT(*) FILTER (WHERE status = 'skipped')::int     AS skipped_count
      FROM blog.instagram_crosspost
      WHERE created_at >= CURRENT_DATE - ($1::text || ' days')::interval
        AND dry_run = false
    `, [days]);

    const r = rows?.[0] || {};
    const attempted = (Number(r.ok_count || 0)) + (Number(r.fail_count || 0)) + (Number(r.token_error_count || 0));
    const successRate = attempted > 0 ? Math.round(Number(r.ok_count || 0) / attempted * 100) : null;

    return {
      total: Number(r.total || 0),
      okCount: Number(r.ok_count || 0),
      failCount: Number(r.fail_count || 0),
      tokenErrorCount: Number(r.token_error_count || 0),
      skippedCount: Number(r.skipped_count || 0),
      successRate,
    };
  } catch {
    return { total: 0, okCount: 0, failCount: 0, tokenErrorCount: 0, skippedCount: 0, successRate: null };
  }
}

module.exports = {
  crosspostToInstagram,
  getCrosspostStats,
  recordCrosspost,
};
