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
const { publishFacebookPost, checkFacebookPublishReadiness } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/facebook-publisher.ts'));
const { ensurePublishLogSchema, reportPublishSuccess, reportPublishFailure } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/publish-reporter.ts'));
const { resolveInstagramHostedMediaUrl } = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/instagram-image-host.ts'));

const DRY_RUN = process.argv.includes('--dry-run');
const FACEBOOK_READINESS_COMMAND = `npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')} run check:facebook -- --json`;
const FACEBOOK_DOCTOR_COMMAND = `npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')} run doctor:facebook -- --json`;
const SOCIAL_DOCTOR_COMMAND = `npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')} run doctor:social -- --json`;
const BLOG_OPS_DOCTOR_COMMAND = `npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')} run doctor:ops -- --json`;

function extractJsonObjectText(output = '') {
  const text = String(output || '').trim();
  if (!text) return '';
  if (text.startsWith('{')) return text;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text;
}

function getDoctorActions(command = '', limit = 2) {
  if (!command) return [];
  try {
    const { execFileSync } = require('child_process');
    const output = execFileSync('zsh', ['-lc', command], {
      cwd: path.join(env.PROJECT_ROOT, 'bots/blog'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const payload = JSON.parse(extractJsonObjectText(output) || '{}');
    return Array.isArray(payload?.actions)
      ? payload.actions.map((item) => String(item || '').trim()).filter(Boolean).slice(0, limit)
      : [];
  } catch {
    return [];
  }
}

function buildPreviewBundleForTitle(title = '') {
  try {
    const {
      findReelPathForTitle,
      findReelCoverPathForTitle,
      findReelQaSheetPathForTitle,
    } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/shortform-files.ts'));
    const reelPath = findReelPathForTitle(title) || '';
    const coverPath = findReelCoverPathForTitle(title) || '';
    const qaSheetPath = findReelQaSheetPathForTitle(title) || '';
    const parts = [
      reelPath ? `reel=${resolveInstagramHostedMediaUrl(reelPath, { kind: 'reels' }).publicUrl || reelPath}` : '',
      coverPath ? `cover=${resolveInstagramHostedMediaUrl(coverPath, { kind: 'thumbs' }).publicUrl || coverPath}` : '',
      qaSheetPath ? `qa=${resolveInstagramHostedMediaUrl(qaSheetPath, { kind: 'thumbs' }).publicUrl || qaSheetPath}` : '',
    ].filter(Boolean);
    return parts.join(' / ');
  } catch {
    return '';
  }
}

async function buildFacebookFailureDetail(error) {
  const baseMessage = String(error?.message || error || '').trim();
  try {
    const readiness = await checkFacebookPublishReadiness().catch(() => null);
    const socialActions = getDoctorActions(SOCIAL_DOCTOR_COMMAND);
    const opsActions = getDoctorActions(BLOG_OPS_DOCTOR_COMMAND);
    const scopes = Array.isArray(readiness?.permissionScopes) && readiness.permissionScopes.length > 0
      ? readiness.permissionScopes.join(', ')
      : (baseMessage.includes('pages_manage_posts') || baseMessage.includes('pages_read_engagement')
        ? 'pages_manage_posts, pages_read_engagement'
        : '');
    const pageHint = readiness?.pageId ? `page=${String(readiness.pageId).slice(0, 32)}` : '';
    const scopeHint = scopes ? `scopes=${scopes}` : '';
    const actionHint = scopes ? 'action=Meta 앱 권한 재연결 후 페이지 토큰 재발급' : '';
    const extras = [
      pageHint,
      scopeHint,
      `diagnose=${FACEBOOK_READINESS_COMMAND}`,
      `doctor=${FACEBOOK_DOCTOR_COMMAND}`,
      `social=${SOCIAL_DOCTOR_COMMAND}`,
      `ops=${BLOG_OPS_DOCTOR_COMMAND}`,
      'primary blocker=social.facebook',
      `next=${SOCIAL_DOCTOR_COMMAND}`,
      ...socialActions.map((item) => `social action=${item}`),
      ...opsActions.map((item) => `ops action=${item}`),
      actionHint,
    ].filter(Boolean).join(' / ');
    return extras ? `${baseMessage}\n${extras}` : baseMessage;
  } catch {
    return baseMessage;
  }
}

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
  const previewBundle = buildPreviewBundleForTitle(title);
  const message = [
    `📝 새 포스팅이 올라왔습니다!`,
    ``,
    `제목: ${title}`,
    `카테고리: ${category || '일반'}`,
    naverUrl ? `\n블로그 링크 ▼` : '',
  ].filter(line => line !== undefined).join('\n').trim();

  console.log(`[facebook-auto] 발행 대상: "${title}" status=${postStatus || 'unknown'} naverUrl=${naverUrl || 'none'}`);
  if (previewBundle) {
    console.log(`[facebook-auto] preview bundle: ${previewBundle}`);
  }
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

    await reportPublishSuccess('facebook', title, naverUrl || '', { postId, previewBundle });
    console.log(`[facebook-auto] 발행 성공 fbPostId=${result.postId}`);

  } catch (err) {
    const rawMessage = String(err?.rawMessage || err?.message || '');
    console.error('[facebook-auto] 발행 실패:', err.message);
    if (rawMessage && rawMessage !== err.message) {
      console.error('[facebook-auto] raw failure:', rawMessage);
    }
    const detailedError = await buildFacebookFailureDetail(err);
    await reportPublishFailure('facebook', title, detailedError, { postId, previewBundle });
  }
}

main().catch(err => {
  console.error('[facebook-auto] 치명적 오류:', err.message);
  process.exit(1);
});
