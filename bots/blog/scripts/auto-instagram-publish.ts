#!/usr/bin/env node
'use strict';

/**
 * bots/blog/scripts/auto-instagram-publish.ts
 *
 * Queue-first Instagram 발행.
 * launchd ai.blog.instagram-publish에서 매일 18:00 KST 실행.
 *
 * 동작 순서:
 *   1. marketing_publish_queue에서 instagram_reel 대기 job 확인
 *   2. job 있으면 → strategy_native publish (quality gate → prepare → publish)
 *   3. job 없으면 → 오늘 네이버 포스트 기반 legacy crosspost (naver_post fallback)
 *   4. 성공/실패 결과 Telegram 보고
 *
 * L5 원칙: 사용자 승인 없음. 품질 게이트 통과 시 자동 게시.
 *          실패는 failure_kind로 분류 후 큐 status 갱신.
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
const { claimNextPublishJob, markPublishSuccess, markPublishFailure } = require(
  path.join(env.PROJECT_ROOT, 'bots/blog/lib/omnichannel/publish-queue.ts')
);
const { evaluateAndSaveQuality } = require(
  path.join(env.PROJECT_ROOT, 'bots/blog/lib/omnichannel/creative-quality-gate.ts')
);
const { recordMarketingAssetOutcome } = require(
  path.join(env.PROJECT_ROOT, 'bots/blog/lib/omnichannel/asset-memory.ts')
);
const { createMarketingCampaignFromSignals } = require(
  path.join(env.PROJECT_ROOT, 'bots/blog/lib/omnichannel/campaign-planner.ts')
);
const { getInstagramConfig } = require(
  path.join(env.PROJECT_ROOT, 'packages/core/lib/instagram-graph.ts')
);
const { publishInstagramReel, buildHostedVideoUrl, verifyPublicMediaUrl } = require(
  path.join(env.PROJECT_ROOT, 'packages/core/lib/instagram-graph.ts')
);

const DRY_RUN = process.argv.includes('--dry-run');
const INSTAGRAM_READINESS_COMMAND = `npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')} run check:instagram -- --json`;
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

function getDoctorActions(command = '', limit = 2, areaPrefix = '') {
  if (!command) return [];
  try {
    const output = execFileSync('zsh', ['-lc', command], {
      cwd: path.join(env.PROJECT_ROOT, 'bots/blog'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const payload = JSON.parse(extractJsonObjectText(output) || '{}');
    const primaryArea = String(payload?.primary?.area || '');
    if (!primaryArea || primaryArea === 'clear' || primaryArea === 'unknown') return [];
    if (areaPrefix && !primaryArea.startsWith(areaPrefix)) return [];
    return Array.isArray(payload?.actions)
      ? payload.actions.map((item) => String(item || '').trim()).filter(Boolean).slice(0, limit)
      : [];
  } catch {
    return [];
  }
}

function inferCoverPathFromReel(reelPath = '') {
  if (!reelPath) return '';
  return String(reelPath).replace(/\.mp4$/i, '_cover.jpg');
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

function classifyInstagramError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  if (msg.includes('access token') || msg.includes('token') || msg.includes('oauth')) return 'auth';
  if (msg.includes('prepare') || msg.includes('staged') || msg.includes('공개 비디오 파일')) return 'asset_prepare';
  if (msg.includes('공개 비디오 url') || msg.includes('url이 아직 응답')) return 'media_url';
  if (msg.includes('container') || msg.includes('status_code') || msg.includes('processing')) return 'container_processing';
  if (msg.includes('rate limit') || msg.includes('429')) return 'rate_limit';
  if (msg.includes('publish') || msg.includes('media_publish')) return 'publish';
  return 'unknown';
}

function buildInstagramFailureDetail(error, { reelPath = '', previewBundle = '' } = {}) {
  const baseMessage = String(error?.message || error || '').trim();
  const reelHint = reelPath ? `reel=${reelPath}` : '';
  const socialActions = getDoctorActions(SOCIAL_DOCTOR_COMMAND, 2, 'social');
  const opsActions = getDoctorActions(BLOG_OPS_DOCTOR_COMMAND, 2, 'social');
  const failureKind = classifyInstagramError(error);
  const actionHint = failureKind === 'asset_prepare' || failureKind === 'media_url'
    ? 'action=prepare:instagram-media 또는 GitHub Pages 공개 URL 200 확인 후 재시도'
    : 'action=check:instagram / doctor:instagram 결과를 확인 후 재시도';
  const extras = [
    reelHint,
    `failure_kind=${failureKind}`,
    `diagnose=${INSTAGRAM_READINESS_COMMAND}`,
    `social=${SOCIAL_DOCTOR_COMMAND}`,
    'primary blocker=social.instagram',
    ...socialActions.map((item) => `social action=${item}`),
    ...opsActions.map((item) => `ops action=${item}`),
    actionHint,
    previewBundle ? `preview=${previewBundle}` : '',
  ].filter(Boolean);
  return extras.length > 0 ? `${baseMessage}\n${extras.join('\n')}` : baseMessage;
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
    `[블로팀] 인스타 일일 현황`,
    `성공: ${stats.okCount}건 | 실패: ${stats.failCount}건 | 생략: ${stats.skippedCount}건`,
    stats.successRate != null ? `성공률: ${stats.successRate}%` : '',
  ].filter(Boolean).join('\n');

  await runIfOps(
    'blog-insta-daily-status',
    () => postAlarm({ message: msg, team: 'blog', bot: 'auto-instagram-publish', level: 'info' }),
    () => console.log('[DEV]', msg)
  ).catch(() => {});
}

async function recordAssetOutcomeSafe(payload = {}) {
  if (DRY_RUN) return;
  await recordMarketingAssetOutcome(payload).catch((error) => {
    console.warn('[insta-auto] asset-memory 기록 실패:', String(error?.message || error));
  });
}

/**
 * strategy_native 경로: 큐에서 job을 claim해 quality gate → prepare → publish.
 */
async function publishFromQueue(queueJob) {
  const { queue_id: queueId, variant } = queueJob;
  if (!variant) {
    console.warn('[insta-auto] queue job에 variant 없음 — 건너뜀');
    await markPublishFailure(queueId, { error: 'variant_not_found', failureKind: 'unknown' });
    return { ok: false, reason: 'variant_not_found' };
  }

  const config = await getInstagramConfig().catch(() => ({}));
  const qr = await evaluateAndSaveQuality({ variant, config, dryRun: DRY_RUN });

  if (qr.gateResult === 'blocked') {
    console.warn(`[insta-auto] quality gate BLOCKED score=${qr.scoreTotal} reasons=${JSON.stringify(qr.reasons.blocked)}`);
    await markPublishFailure(queueId, {
      error: `quality_gate_blocked: ${qr.reasons.blocked.join('; ')}`,
      failureKind: 'quality_gate',
      block: true,
    });
    await runIfOps('blog-insta-quality-block', () => postAlarm({
      message: `[블로팀] 인스타 strategy_native 발행 quality gate 차단\n점수=${qr.scoreTotal}\n이유=${qr.reasons.blocked.join(', ')}\n자동 재생성 대기`,
      team: 'blog', bot: 'auto-instagram-publish', level: 'warn',
    }), () => console.log('[DEV] quality gate blocked')).catch(() => {});
    await recordAssetOutcomeSafe({
      variant,
      qualityScore: qr.scoreTotal,
      gateResult: qr.gateResult,
      publishStatus: 'blocked',
      failureKind: 'quality_gate',
      metadata: { blockedReasons: qr.reasons?.blocked || [] },
    });
    return { ok: false, reason: 'quality_gate_blocked' };
  }

  // assetRefs에서 릴스 경로 추출
  const assetRefs = variant.asset_refs || {};
  let reelPath = assetRefs.reelPath || '';
  let coverPath = assetRefs.coverPath || '';
  let qaSheetPath = assetRefs.qaSheetPath || '';

  // 릴스 파일이 variant에 없으면 latest fallback
  if (!reelPath) {
    try {
      const { findLatestReelPath, findLatestReelCoverPath, findLatestReelQaSheetPath } = require(
        path.join(env.PROJECT_ROOT, 'bots/blog/lib/shortform-files.ts')
      );
      reelPath = findLatestReelPath() || '';
      coverPath = findLatestReelCoverPath() || '';
      qaSheetPath = findLatestReelQaSheetPath() || '';
    } catch (e) {
      console.warn('[insta-auto] 릴스 파일 탐색 실패:', e.message);
    }
  }

  if (!reelPath) {
    console.warn('[insta-auto] strategy_native: 릴스 파일 없음 — failed');
    await markPublishFailure(queueId, { error: 'no_reel_file', failureKind: 'asset_prepare' });
    await recordAssetOutcomeSafe({
      variant,
      qualityScore: qr.scoreTotal,
      gateResult: qr.gateResult,
      publishStatus: 'failed',
      failureKind: 'asset_prepare',
      metadata: { reason: 'no_reel_file' },
    });
    return { ok: false, reason: 'no_reel_file' };
  }

  // prepare:instagram-media 항상 실행 (L5 자동 복구)
  let staged = null;
  let previewBundle = '';
  try {
    staged = ensureHostedInstagramMedia(reelPath, coverPath);
    previewBundle = buildPreviewBundle({ staged, reelPath, coverPath, qaSheetPath });
    console.log(`[insta-auto][native] 공개 미디어 준비 완료: ${staged?.reel?.targetPath || 'ok'}`);
  } catch (e) {
    const failureKind = classifyInstagramError(e);
    console.error('[insta-auto][native] prepare 실패:', e.message);
    await markPublishFailure(queueId, { error: e.message, failureKind });
    await reportPublishFailure('instagram', variant.title || 'strategy_native',
      buildInstagramFailureDetail(e, { reelPath }),
      { sourceMode: 'strategy_native' }
    );
    await recordAssetOutcomeSafe({
      variant,
      qualityScore: qr.scoreTotal,
      gateResult: qr.gateResult,
      publishStatus: 'failed',
      failureKind,
      metadata: { stage: 'prepare', error: String(e?.message || e) },
    });
    return { ok: false, reason: 'prepare_failed', error: e };
  }

  // public URL 검증
  const videoUrl = staged?.reel?.publicUrl || assetRefs?.reelPublicUrl || '';
  if (!videoUrl) {
    const msg = 'Instagram 공개 비디오 URL이 준비되지 않았습니다';
    await markPublishFailure(queueId, { error: msg, failureKind: 'media_url' });
    await reportPublishFailure('instagram', variant.title || 'strategy_native', msg, { sourceMode: 'strategy_native' });
    await recordAssetOutcomeSafe({
      variant,
      qualityScore: qr.scoreTotal,
      gateResult: qr.gateResult,
      publishStatus: 'failed',
      failureKind: 'media_url',
      metadata: { stage: 'verify_public_url' },
    });
    return { ok: false, reason: 'no_public_url' };
  }

  if (DRY_RUN) {
    console.log('[insta-auto][native][dry-run] strategy_native 발행 시뮬레이션');
    console.log(`  videoUrl=${videoUrl}`);
    console.log(`  caption=${(variant.caption || '').slice(0, 80)}...`);
    return { ok: true, dryRun: true };
  }

  // 실제 발행
  try {
    const result = await publishInstagramReel({
      videoUrl,
      caption: variant.caption || variant.title || '',
      dryRun: false,
    });
    await markPublishSuccess(queueId);
    await reportPublishSuccess('instagram', variant.title || 'strategy_native', undefined, {
      previewBundle,
      sourceMode: 'strategy_native',
      variantId: variant.variant_id,
    });
    await recordAssetOutcomeSafe({
      variant,
      qualityScore: qr.scoreTotal,
      gateResult: qr.gateResult,
      publishStatus: 'published',
      failureKind: '',
      metadata: { publishId: result?.publishId || null, previewBundle },
    });
    console.log(`[insta-auto][native] 발행 성공 publishId=${result.publishId}`);
    return { ok: true, result };
  } catch (e) {
    const failureKind = classifyInstagramError(e);
    await markPublishFailure(queueId, { error: e.message, failureKind });
    await reportPublishFailure('instagram', variant.title || 'strategy_native',
      buildInstagramFailureDetail(e, { reelPath, previewBundle }),
      { sourceMode: 'strategy_native', failureKind }
    );
    await recordAssetOutcomeSafe({
      variant,
      qualityScore: qr.scoreTotal,
      gateResult: qr.gateResult,
      publishStatus: 'failed',
      failureKind,
      metadata: { stage: 'publish', error: String(e?.message || e) },
    });
    return { ok: false, reason: 'publish_failed', error: e, failureKind };
  }
}

/**
 * legacy naver_post fallback 경로 (기존 로직 유지).
 */
async function publishFromNaverPost() {
  const post = await getTodayPendingCrosspost();
  if (!post) {
    console.log('[insta-auto][legacy] 오늘 발행된 포스트 없음 — 종료');
    return { ok: false, reason: 'no_post' };
  }

  const { post_id: postId, post_title: postTitle, post_status: postStatus, crosspost_status: status } = post;

  if (status === 'ok') {
    console.log('[insta-auto][legacy] 오늘 이미 인스타 발행 완료');
    const stats = await getCrosspostStats(1);
    await notifyDailyStatus(stats);
    return { ok: true, already: true };
  }

  let reelPath = null, coverPath = null, qaSheetPath = null, thumbPath = null;
  try {
    const {
      findLatestReelPath, findReelPathForTitle, findReelCoverPathForTitle,
      findReelQaSheetPathForTitle, findThumbPathForTitle,
    } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/shortform-files.ts'));
    reelPath = findReelPathForTitle(postTitle) || findLatestReelPath();
    coverPath = findReelCoverPathForTitle(postTitle) || '';
    qaSheetPath = findReelQaSheetPathForTitle(postTitle) || '';
    thumbPath = findThumbPathForTitle(postTitle, '') || '';
  } catch (e) {
    console.warn('[insta-auto][legacy] 릴스 파일 탐색 실패:', e.message);
  }

  const fs = require('fs');
  const inferredCoverPath = inferCoverPathFromReel(reelPath);
  if (inferredCoverPath && fs.existsSync(inferredCoverPath)) coverPath = inferredCoverPath;
  const inferredQaSheetPath = inferQaSheetPathFromReel(reelPath);
  if (inferredQaSheetPath && fs.existsSync(inferredQaSheetPath)) qaSheetPath = inferredQaSheetPath;

  if (reelPath && !qaSheetPath && thumbPath) {
    try {
      qaSheetPath = await ensureReelQaSheet({
        outputPath: reelPath, thumbPath, coverPath,
        title: postTitle, hook: postTitle,
        cta: '인스타 게시 전 QA 시트를 먼저 확인하세요',
      });
    } catch (e) {
      console.warn('[insta-auto][legacy] QA 시트 보강 실패:', e.message);
    }
  }

  if (!reelPath) {
    console.log('[insta-auto][legacy] 릴스 파일 없음 — 생략');
    return { ok: false, reason: 'no_reel' };
  }

  let staged = null, previewBundle = '';
  try {
    staged = ensureHostedInstagramMedia(reelPath, coverPath);
    previewBundle = buildPreviewBundle({ staged, reelPath, coverPath, qaSheetPath });
  } catch (e) {
    console.warn('[insta-auto][legacy] prepare 실패:', e.message);
    if (!DRY_RUN) {
      await reportPublishFailure('instagram', postTitle,
        buildInstagramFailureDetail(`prepare_instagram_media_failed: ${e.message}`, { reelPath }),
        {}
      );
    }
    throw e;
  }

  const instaContent = {
    reel: { outputPath: reelPath, coverPath },
    caption: `${postTitle}\n\n#개발자일상 #IT블로그 #승호아빠 #cafe_library`,
  };

  const result = await crosspostToInstagram(instaContent, postTitle, postId, DRY_RUN);
  previewBundle = previewBundle || buildPreviewBundle({ reelPath, coverPath, qaSheetPath });

  if (result.ok) {
    await reportPublishSuccess('instagram', postTitle, undefined, { previewBundle, sourceMode: 'naver_post' });
  } else if (!result.skipped) {
    await reportPublishFailure('instagram', postTitle,
      buildInstagramFailureDetail(result.error || result.reason || '알 수 없는 오류', { reelPath, previewBundle }),
      { previewBundle, sourceMode: 'naver_post' }
    );
  }
  return result;
}

async function main() {
  console.log(`[insta-auto] 시작 dryRun=${DRY_RUN}`);

  // ── 1. Queue-first: strategy_native 큐 확인 ────────────────────────────
  const queueJob = await claimNextPublishJob('instagram_reel', { dryRun: DRY_RUN }).catch(() => null);

  if (queueJob) {
    console.log(`[insta-auto] queue-first: job=${queueJob.queue_id} variant=${queueJob.variant_id}`);
    const result = await publishFromQueue(queueJob);
    const stats = await getCrosspostStats(1).catch(() => ({ okCount: 0, failCount: 0, skippedCount: 0 }));
    await notifyDailyStatus(stats);
    console.log('[insta-auto] 완료 (queue-first)');
    return;
  }

  // ── 2. 전략이 social_native_required이면 새 캠페인 생성 후 즉시 큐 ────────
  // (지금은 간단히 캠페인 생성 후 queue에 넣고 재claim)
  let newCampaignQueued = false;
  try {
    const { directives } = require(
      path.join(env.PROJECT_ROOT, 'bots/blog/lib/strategy-loader.ts')
    ).loadStrategyBundle();
    const nativeRequired = directives?.socialNativeRequired === true;
    if (nativeRequired) {
      console.log('[insta-auto] social_native_required — 새 campaign 생성');
      await createMarketingCampaignFromSignals({ brandAxis: 'cafe_library', objective: 'awareness', dryRun: DRY_RUN });
      newCampaignQueued = true;
    }
  } catch (e) {
    console.warn('[insta-auto] 전략 로드 또는 campaign 생성 실패:', e.message);
  }

  if (newCampaignQueued) {
    const newJob = await claimNextPublishJob('instagram_reel', { dryRun: DRY_RUN }).catch(() => null);
    if (newJob) {
      const result = await publishFromQueue(newJob);
      const stats = await getCrosspostStats(1).catch(() => ({ okCount: 0, failCount: 0, skippedCount: 0 }));
      await notifyDailyStatus(stats);
      console.log('[insta-auto] 완료 (new-campaign queue)');
      return;
    }
  }

  // ── 3. Legacy naver_post fallback ────────────────────────────────────────
  console.log('[insta-auto] 큐 없음 — legacy naver_post fallback');
  await publishFromNaverPost();

  const stats = await getCrosspostStats(1).catch(() => ({ okCount: 0, failCount: 0, skippedCount: 0 }));
  await notifyDailyStatus(stats);
  console.log('[insta-auto] 완료');
}

main().catch(err => {
  console.error('[insta-auto] 치명적 오류:', err.message);
  process.exit(1);
});
