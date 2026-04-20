#!/usr/bin/env node
'use strict';

/**
 * bots/blog/scripts/auto-instagram-publish.ts
 *
 * 오늘 발행된 블로그 포스트의 인스타 크로스포스트 상태 확인 후 재시도 or 보고.
 * launchd ai.blog.instagram-publish에서 매일 18:00 KST 실행.
 *
 * 동작:
 *   1. 오늘 크로스포스트 성공 이력 확인 → 이미 완료면 종료
 *   2. 오늘 블로그 포스트의 릴스 파일 존재 확인
 *   3. 릴스 있으면 publishInstagramReel() 호출
 *   4. 성공/실패 결과 Telegram 보고
 */

const path = require('path');
const { execFileSync } = require('child_process');
const env = require('../../../packages/core/lib/env');
const pgPool = require('../../../packages/core/lib/pg-pool');
const { crosspostToInstagram, getCrosspostStats } = require(
  path.join(env.PROJECT_ROOT, 'bots/blog/lib/insta-crosspost.ts')
);
const { reportPublishSuccess, reportPublishFailure } = require(
  path.join(env.PROJECT_ROOT, 'bots/blog/lib/publish-reporter.ts')
);
const { runIfOps } = require('../../../packages/core/lib/mode-guard');
const { postAlarm } = require('../../../packages/core/lib/openclaw-client');
const { ensureReelQaSheet } = require(
  path.join(env.PROJECT_ROOT, 'bots/blog/lib/shortform-renderer.ts')
);

const DRY_RUN = process.argv.includes('--dry-run');

function inferCoverPathFromReel(reelPath = '') {
  if (!reelPath) return '';
  const coverPath = String(reelPath).replace(/\.mp4$/i, '_cover.jpg');
  return coverPath;
}

function inferQaSheetPathFromReel(reelPath = '') {
  if (!reelPath) return '';
  return String(reelPath).replace(/\.mp4$/i, '_qa.jpg');
}

function ensureHostedInstagramMedia(reelPath, coverPath = '') {
  if (!reelPath) return null;
  const scriptPath = path.join(env.PROJECT_ROOT, 'bots/blog/scripts/prepare-instagram-media.ts');
  const args = [scriptPath, '--json', '--no-thumb', '--video', reelPath];
  if (coverPath) args.push('--cover', coverPath);
  else args.push('--no-cover');
  if (DRY_RUN) args.push('--dry-run');

  const output = execFileSync('node', args, {
    cwd: path.join(env.PROJECT_ROOT, 'bots/blog'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

  try {
    return JSON.parse(output || '{}');
  } catch {
    return { raw: output };
  }
}

function buildPreviewBundle({ staged = null, reelPath = '', coverPath = '', qaSheetPath = '' } = {}) {
  const parts = [
    staged?.reel?.publicUrl ? `reel=${staged.reel.publicUrl}` : (reelPath ? `reel=${reelPath}` : ''),
    staged?.cover?.publicUrl ? `cover=${staged.cover.publicUrl}` : (coverPath ? `cover=${coverPath}` : ''),
    staged?.qaSheet?.publicUrl ? `qa=${staged.qaSheet.publicUrl}` : (qaSheetPath ? `qa=${qaSheetPath}` : ''),
  ].filter(Boolean);
  return parts.join(' / ');
}

async function getTodayPendingCrosspost() {
  const rows = await pgPool.query('blog', `
    SELECT
      p.id AS post_id,
      p.title AS post_title,
      p.status AS post_status,
      p.naver_url,
      ic.status AS crosspost_status,
      ic.error_msg
    FROM blog.posts p
    LEFT JOIN blog.instagram_crosspost ic
      ON ic.post_id = p.id
    WHERE p.publish_date = CURRENT_DATE
      AND p.status IN ('published', 'ready')
    ORDER BY
      CASE WHEN p.status = 'published' THEN 0 ELSE 1 END,
      COALESCE(p.publish_date::timestamp, p.created_at) DESC,
      p.id DESC
    LIMIT 1
  `);
  return rows?.[0] || null;
}

async function notifyDailyStatus(stats) {
  const msg = [
    `📊 [블로팀] 인스타 일일 현황`,
    `성공: ${stats.okCount}건 | 실패: ${stats.failCount}건 | 생략: ${stats.skippedCount}건`,
    stats.successRate != null ? `성공률: ${stats.successRate}%` : '',
  ].filter(Boolean).join('\n');

  await runIfOps(
    'blog-insta-daily-status',
    () => postAlarm({ message: msg, team: 'blog', bot: 'auto-instagram-publish', level: 'info' }),
    () => console.log('[DEV]', msg)
  ).catch(() => {});
}

async function main() {
  console.log(`[insta-auto] 시작 dryRun=${DRY_RUN}`);
  let previewBundle = '';

  const post = await getTodayPendingCrosspost();

  if (!post) {
    console.log('[insta-auto] 오늘 발행된 포스트 없음 — 종료');
    return;
  }

  const {
    post_id: postId,
    post_title: postTitle,
    post_status: postStatus,
    crosspost_status: status,
  } = post;

  // 이미 성공이면 상태만 보고 후 종료
  if (status === 'ok') {
    console.log('[insta-auto] 오늘 이미 인스타 발행 완료');
    const stats = await getCrosspostStats(1);
    await notifyDailyStatus(stats);
    return;
  }

  if (postStatus === 'ready') {
    console.log('[insta-auto] published 전 ready 포스트를 릴스 우선 경로로 처리합니다.');
  }

  // 릴스 파일 찾기 (shortform-files.ts 활용)
  let reelPath = null;
  let coverPath = null;
  let qaSheetPath = null;
  let thumbPath = null;
  try {
    const {
      findLatestReelPath,
      findReelPathForTitle,
      findReelCoverPathForTitle,
      findReelQaSheetPathForTitle,
      findThumbPathForTitle,
    } = require(
      path.join(env.PROJECT_ROOT, 'bots/blog/lib/shortform-files.ts')
    );
    reelPath = findReelPathForTitle(postTitle) || findLatestReelPath();
    coverPath = findReelCoverPathForTitle(postTitle) || '';
    qaSheetPath = findReelQaSheetPathForTitle(postTitle) || '';
    thumbPath = findThumbPathForTitle(postTitle, '') || '';
  } catch (e) {
    console.warn('[insta-auto] 릴스 파일 탐색 실패:', e.message);
  }
  const inferredCoverPath = inferCoverPathFromReel(reelPath);
  if (inferredCoverPath && require('fs').existsSync(inferredCoverPath)) {
    coverPath = inferredCoverPath;
  }
  const inferredQaSheetPath = inferQaSheetPathFromReel(reelPath);
  if (inferredQaSheetPath && require('fs').existsSync(inferredQaSheetPath)) {
    qaSheetPath = inferredQaSheetPath;
  }

  if (reelPath && !qaSheetPath && thumbPath) {
    try {
      qaSheetPath = await ensureReelQaSheet({
        outputPath: reelPath,
        thumbPath,
        coverPath,
        title: postTitle,
        hook: postTitle,
        cta: '인스타 게시 전 QA 시트를 먼저 확인하세요',
      });
      console.log(`[insta-auto] 릴스 QA 시트 자동 보강: ${qaSheetPath}`);
    } catch (e) {
      console.warn('[insta-auto] 릴스 QA 시트 자동 보강 실패:', e.message);
    }
  }

  if (!reelPath) {
    console.log('[insta-auto] 오늘 릴스 파일 없음 — 인스타 발행 생략');
    await runIfOps(
      'blog-insta-no-reel',
      () => postAlarm({
        message: `⚠️ [블로팀] 인스타 발행 생략\n오늘 릴스 파일 없음 (글: ${postTitle})`,
        team: 'blog',
        bot: 'auto-instagram-publish',
        level: 'warn',
      }),
      () => console.log('[DEV] 릴스 없음 — 생략')
    ).catch(() => {});
    return;
  }

  try {
    const staged = ensureHostedInstagramMedia(reelPath, coverPath);
    previewBundle = buildPreviewBundle({ staged, reelPath, coverPath, qaSheetPath });
    const hostedPath = staged?.reel?.targetPath || '';
    const coverTarget = staged?.cover?.targetPath || '';
    console.log(`[insta-auto] 공개 미디어 준비: ${hostedPath || 'ok'}`);
    if (coverTarget) {
      console.log(`[insta-auto] 릴스 커버 준비: ${coverTarget}`);
    }
    if (qaSheetPath) {
      console.log(`[insta-auto] 릴스 QA 시트 인식: ${qaSheetPath}`);
    }
    if (previewBundle) {
      console.log(`[insta-auto] preview bundle: ${previewBundle}`);
    }
  } catch (e) {
    console.warn('[insta-auto] 공개 미디어 준비 실패:', e.message);
    if (!DRY_RUN) {
      await reportPublishFailure('instagram', postTitle, `prepare_instagram_media_failed: ${e.message}`, {
        previewBundle: buildPreviewBundle({ reelPath, coverPath, qaSheetPath }),
      });
    }
    throw e;
  }

  // 인스타 크로스포스트 실행
  const instaContent = {
    reel: { outputPath: reelPath, coverPath },
    caption: `📝 ${postTitle}\n\n#개발자일상 #IT블로그 #승호아빠 #cafe_library`,
  };

  console.log(`[insta-auto] 릴스 발행 시도: ${reelPath}`);
  if (coverPath) {
    console.log(`[insta-auto] 릴스 커버 인식: ${coverPath}`);
  }
  if (qaSheetPath) {
    console.log(`[insta-auto] 릴스 QA 시트 인식: ${qaSheetPath}`);
  }
  const result = await crosspostToInstagram(instaContent, postTitle, postId, DRY_RUN);
  previewBundle = previewBundle || buildPreviewBundle({ reelPath, coverPath, qaSheetPath });

  if (result.ok) {
    await reportPublishSuccess('instagram', postTitle, undefined, { previewBundle });
  } else if (!result.skipped) {
    await reportPublishFailure('instagram', postTitle, result.error || result.reason || '알 수 없는 오류', {
      previewBundle,
    });
  }

  const stats = await getCrosspostStats(1);
  await notifyDailyStatus(stats);
  console.log('[insta-auto] 완료');
}

main().catch(err => {
  console.error('[insta-auto] 치명적 오류:', err.message);
  process.exit(1);
});
