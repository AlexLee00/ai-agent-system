#!/usr/bin/env node
'use strict';

/**
 * bots/blog/scripts/auto-facebook-publish.ts
 *
 * Queue-first Facebook 발행.
 * launchd ai.blog.facebook-publish에서 매일 19:00 KST 실행.
 *
 * 동작 순서:
 *   1. marketing_publish_queue에서 facebook_page 대기 job 확인
 *   2. job 있으면 → strategy_native publish (quality gate → native message → publish)
 *   3. job 없으면 → 오늘 네이버 포스트 기반 legacy 공유 (naver_post fallback)
 *   4. 성공/실패 결과 Telegram 보고
 *
 * L5 원칙: 사용자 승인 없음. 정책 통과 시 자동 게시.
 */

const path = require('path');
const env = require('../../../packages/core/lib/env');
const pgPool = require('../../../packages/core/lib/pg-pool');
const { runIfOps } = require('../../../packages/core/lib/mode-guard');
const { postAlarm } = require('../../../packages/core/lib/openclaw-client');
const { publishFacebookPost, checkFacebookPublishReadiness } = require(
  path.join(env.PROJECT_ROOT, 'bots/blog/lib/facebook-publisher.ts')
);
const { ensurePublishLogSchema, reportPublishSuccess, reportPublishFailure } = require(
  path.join(env.PROJECT_ROOT, 'bots/blog/lib/publish-reporter.ts')
);
const { resolveInstagramHostedMediaUrl } = require(
  path.join(env.PROJECT_ROOT, 'packages/core/lib/instagram-image-host.ts')
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

const DRY_RUN = process.argv.includes('--dry-run');
const QUEUE_CLAIM_HORIZON_HOURS = 12;
const FACEBOOK_READINESS_COMMAND = `npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')} run check:facebook -- --json`;
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
    const { execFileSync } = require('child_process');
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

function buildPreviewBundleForTitle(title = '') {
  try {
    const {
      findReelPathForTitle, findReelCoverPathForTitle, findReelQaSheetPathForTitle,
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
    const socialActions = getDoctorActions(SOCIAL_DOCTOR_COMMAND, 2, 'social');
    const opsActions = getDoctorActions(BLOG_OPS_DOCTOR_COMMAND, 2, 'social');
    const scopes = Array.isArray(readiness?.permissionScopes) && readiness.permissionScopes.length > 0
      ? readiness.permissionScopes.join(', ')
      : '';
    const extras = [
      readiness?.pageId ? `page=${String(readiness.pageId).slice(0, 32)}` : '',
      scopes ? `scopes=${scopes}` : '',
      `diagnose=${FACEBOOK_READINESS_COMMAND}`,
      `social=${SOCIAL_DOCTOR_COMMAND}`,
      ...socialActions.map((item) => `social action=${item}`),
      ...opsActions.map((item) => `ops action=${item}`),
      scopes ? 'action=Meta 앱 권한 재연결 후 페이지 토큰 재발급' : '',
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

async function recordAssetOutcomeSafe(payload = {}) {
  if (DRY_RUN) return;
  await recordMarketingAssetOutcome(payload).catch((error) => {
    console.warn('[facebook-auto] asset-memory 기록 실패:', String(error?.message || error));
  });
}

async function notifyQueueUnavailable(detail = '') {
  const message = [
    '[블로팀] Facebook queue-first 확인 실패 (fail-closed)',
    '큐 상태를 확인할 수 없어 legacy fallback 발행을 중단합니다.',
    detail ? `detail=${detail}` : '',
  ].filter(Boolean).join('\n');

  await runIfOps(
    'blog-fb-queue-unavailable',
    () => postAlarm({ message, team: 'blog', bot: 'auto-facebook-publish', level: 'warn' }),
    () => console.log('[DEV]', message),
  ).catch(() => {});
}

/**
 * strategy_native 경로: 큐 job → quality gate → native message → publish
 */
async function publishFromQueue(queueJob) {
  const { queue_id: queueId, variant } = queueJob;
  if (!variant) {
    await markPublishFailure(queueId, { error: 'variant_not_found', failureKind: 'unknown' });
    return { ok: false, reason: 'variant_not_found' };
  }

  const qr = await evaluateAndSaveQuality({ variant, config: {}, dryRun: DRY_RUN });
  if (qr.gateResult === 'blocked' || qr.gateResult === 'recoverable') {
    const isRecoverable = qr.gateResult === 'recoverable';
    console.warn(`[facebook-auto][native] quality gate ${isRecoverable ? 'RECOVERABLE' : 'BLOCKED'} score=${qr.scoreTotal}`);
    await markPublishFailure(queueId, {
      error: isRecoverable
        ? `quality_gate_recoverable: ${(qr.reasons.recoverable || []).join('; ')}`
        : `quality_gate_blocked: ${(qr.reasons.blocked || []).join('; ')}`,
      failureKind: isRecoverable ? 'quality_gate_recoverable' : 'quality_gate',
      block: !isRecoverable,
    });
    await runIfOps('blog-fb-quality-block', () => postAlarm({
      message: isRecoverable
        ? `[블로팀] Facebook strategy_native 발행 quality gate recoverable\n점수=${qr.scoreTotal}\n이유=${(qr.reasons.recoverable || []).join(', ')}\n게시 중단 후 자동 재생성 진행`
        : `[블로팀] Facebook strategy_native 발행 quality gate 차단\n점수=${qr.scoreTotal}\n이유=${(qr.reasons.blocked || []).join(', ')}`,
      team: 'blog', bot: 'auto-facebook-publish', level: 'warn',
    }), () => console.log('[DEV] quality gate blocked')).catch(() => {});

    if (isRecoverable) {
      await createMarketingCampaignFromSignals({
        brandAxis: variant.brand_axis || 'cafe_library',
        objective: variant.objective || 'engagement',
        dryRun: DRY_RUN,
      }).catch((error) => {
        console.warn('[facebook-auto] recoverable 재생성 campaign 실패:', String(error?.message || error));
      });
    }

    await recordAssetOutcomeSafe({
      variant,
      qualityScore: qr.scoreTotal,
      gateResult: qr.gateResult,
      publishStatus: isRecoverable ? 'failed' : 'blocked',
      failureKind: isRecoverable ? 'quality_gate_recoverable' : 'quality_gate',
      metadata: {
        blockedReasons: qr.reasons?.blocked || [],
        recoverableReasons: qr.reasons?.recoverable || [],
      },
    });
    return { ok: false, reason: isRecoverable ? 'quality_gate_recoverable' : 'quality_gate_blocked' };
  }

  const message = variant.body || variant.caption || variant.title || '';
  if (!message) {
    await markPublishFailure(queueId, { error: 'empty_message', failureKind: 'unknown' });
    await recordAssetOutcomeSafe({
      variant,
      qualityScore: qr.scoreTotal,
      gateResult: qr.gateResult,
      publishStatus: 'failed',
      failureKind: 'unknown',
      metadata: { reason: 'empty_message' },
    });
    return { ok: false, reason: 'empty_message' };
  }

  console.log(`[facebook-auto][native] 발행 대상: "${(message).slice(0, 60)}..." dryRun=${DRY_RUN}`);

  if (DRY_RUN) {
    console.log('[facebook-auto][native][dry-run] strategy_native 발행 시뮬레이션');
    console.log(JSON.stringify({ message: message.slice(0, 100), queueId, variantId: variant.variant_id }, null, 2));
    return { ok: true, dryRun: true };
  }

  try {
    const result = await publishFacebookPost({ message, link: '', dryRun: false });
    await markPublishSuccess(queueId);
    await reportPublishSuccess('facebook', variant.title || 'strategy_native', '', {
      postId: variant.variant_id,
      sourceMode: 'strategy_native',
      variantId: variant.variant_id,
    });
    await recordAssetOutcomeSafe({
      variant,
      qualityScore: qr.scoreTotal,
      gateResult: qr.gateResult,
      publishStatus: 'published',
      failureKind: '',
      metadata: { postId: result?.postId || null },
    });
    console.log(`[facebook-auto][native] 발행 성공 fbPostId=${result.postId}`);
    return { ok: true, result };
  } catch (err) {
    const detailedError = await buildFacebookFailureDetail(err);
    await markPublishFailure(queueId, { error: err.message, failureKind: 'publish' });
    await reportPublishFailure('facebook', variant.title || 'strategy_native', detailedError, {
      sourceMode: 'strategy_native',
    });
    await recordAssetOutcomeSafe({
      variant,
      qualityScore: qr.scoreTotal,
      gateResult: qr.gateResult,
      publishStatus: 'failed',
      failureKind: 'publish',
      metadata: { error: String(err?.message || err) },
    });
    return { ok: false, reason: 'publish_failed', error: err };
  }
}

/**
 * legacy naver_post fallback 경로
 */
async function publishFromNaverPost() {
  const post = await getTodayLatestPost();
  if (!post) {
    console.log('[facebook-auto][legacy] 오늘 발행된 포스트 없음 — 생략');
    return;
  }

  const alreadyPublished = await hasFacebookPublishToday();
  if (alreadyPublished) {
    console.log('[facebook-auto][legacy] 오늘 이미 Facebook 발행 완료 — 생략');
    return;
  }

  const { id: postId, title, naver_url: naverUrl, category, status: postStatus } = post;
  const previewBundle = buildPreviewBundleForTitle(title);
  const message = [
    `새 포스팅이 올라왔습니다!`,
    ``,
    `제목: ${title}`,
    `카테고리: ${category || '일반'}`,
    naverUrl ? `\n블로그 링크 ▼` : '',
  ].filter(line => line !== undefined).join('\n').trim();

  console.log(`[facebook-auto][legacy] "${title}" status=${postStatus || 'unknown'}`);
  if (previewBundle) console.log(`[facebook-auto][legacy] preview bundle: ${previewBundle}`);

  try {
    const result = await publishFacebookPost({ message, link: naverUrl || '', dryRun: DRY_RUN });

    if (DRY_RUN) {
      console.log('[facebook-auto][legacy][dry-run] 발행 시뮬레이션 완료');
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    await reportPublishSuccess('facebook', title, naverUrl || '', { postId, previewBundle, sourceMode: 'naver_post' });
    console.log(`[facebook-auto][legacy] 발행 성공 fbPostId=${result.postId}`);
  } catch (err) {
    const detailedError = await buildFacebookFailureDetail(err);
    await reportPublishFailure('facebook', title, detailedError, { postId, previewBundle, sourceMode: 'naver_post' });
    console.error('[facebook-auto][legacy] 발행 실패:', err.message);
  }
}

async function main() {
  console.log(`[facebook-auto] 시작 dryRun=${DRY_RUN}`);

  // ── 1. Queue-first: strategy_native 큐 확인 ────────────────────────────
  let queueJob = null;
  try {
    queueJob = await claimNextPublishJob('facebook_page', {
      dryRun: DRY_RUN,
      scheduleHorizonHours: QUEUE_CLAIM_HORIZON_HOURS,
    });
  } catch (error) {
    await notifyQueueUnavailable(String(error?.message || error));
    throw new Error(`queue_unavailable: ${String(error?.message || error)}`);
  }

  if (queueJob) {
    console.log(`[facebook-auto] queue-first: job=${queueJob.queue_id} variant=${queueJob.variant_id}`);
    await publishFromQueue(queueJob);
    console.log('[facebook-auto] 완료 (queue-first)');
    return;
  }

  // ── 2. 전략이 social_native_required이면 새 캠페인 생성 ────────────────
  let nativeRequired = false;
  let newCampaignQueued = false;
  try {
    const { directives } = require(
      path.join(env.PROJECT_ROOT, 'bots/blog/lib/strategy-loader.ts')
    ).loadStrategyBundle();
    nativeRequired = directives?.socialNativeRequired === true;
    if (nativeRequired) {
      console.log('[facebook-auto] social_native_required — 새 campaign 생성');
      await createMarketingCampaignFromSignals({ brandAxis: 'cafe_library', objective: 'awareness', dryRun: DRY_RUN });
      newCampaignQueued = true;
    }
  } catch (e) {
    console.warn('[facebook-auto] 전략 로드 또는 campaign 생성 실패:', e.message);
    if (nativeRequired) {
      await runIfOps('blog-fb-native-required-create-failed', () => postAlarm({
        message: `[블로팀] Facebook social_native_required 경로에서 campaign 생성 실패 (fail-closed)\n${String(e?.message || e)}`,
        team: 'blog',
        bot: 'auto-facebook-publish',
        level: 'warn',
      }), () => console.log('[DEV] native required create failed')).catch(() => {});
      throw new Error(`social_native_required_campaign_create_failed: ${String(e?.message || e)}`);
    }
  }

  if (newCampaignQueued) {
    let newJob = null;
    try {
      newJob = await claimNextPublishJob('facebook_page', {
        dryRun: DRY_RUN,
        scheduleHorizonHours: QUEUE_CLAIM_HORIZON_HOURS,
      });
    } catch (error) {
      await notifyQueueUnavailable(String(error?.message || error));
      throw new Error(`queue_unavailable_after_regen: ${String(error?.message || error)}`);
    }
    if (newJob) {
      await publishFromQueue(newJob);
      console.log('[facebook-auto] 완료 (new-campaign queue)');
      return;
    }
    if (nativeRequired) {
      if (DRY_RUN) {
        console.log('[facebook-auto][dry-run] social_native_required queue empty 시뮬레이션 종료');
        return;
      }
      await runIfOps('blog-fb-native-required-queue-empty', () => postAlarm({
        message: '[블로팀] Facebook social_native_required 경로에서 queue claim 결과 없음 (fail-closed)',
        team: 'blog',
        bot: 'auto-facebook-publish',
        level: 'warn',
      }), () => console.log('[DEV] native required queue empty')).catch(() => {});
      throw new Error('social_native_required_queue_empty');
    }
  } else if (nativeRequired) {
    if (DRY_RUN) {
      console.log('[facebook-auto][dry-run] social_native_required not queued 시뮬레이션 종료');
      return;
    }
    await runIfOps('blog-fb-native-required-not-queued', () => postAlarm({
      message: '[블로팀] Facebook social_native_required 경로에서 새 campaign이 queue로 등록되지 않았습니다 (fail-closed)',
      team: 'blog',
      bot: 'auto-facebook-publish',
      level: 'warn',
    }), () => console.log('[DEV] native required not queued')).catch(() => {});
    throw new Error('social_native_required_not_queued');
  }

  // ── 3. Legacy naver_post fallback ────────────────────────────────────────
  console.log('[facebook-auto] 큐 없음 — legacy naver_post fallback');
  await publishFromNaverPost();
  console.log('[facebook-auto] 완료');
}

main().catch(err => {
  console.error('[facebook-auto] 치명적 오류:', err.message);
  process.exit(1);
});
