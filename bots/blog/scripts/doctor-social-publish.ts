#!/usr/bin/env node
'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');
const pgPool = require('../../../packages/core/lib/pg-pool.js');
const { checkFacebookPublishReadiness } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/facebook-publisher.ts'));
const { getInstagramConfig } = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/instagram-graph.ts'));
const { resolveInstagramHostedMediaUrl } = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/instagram-image-host.ts'));
const { buildBlogCliInsight } = require('../lib/cli-insight.ts');

function parseArgs(argv = []) {
  return {
    json: argv.includes('--json'),
  };
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
    return {
      reel: reelPath ? (resolveInstagramHostedMediaUrl(reelPath, { kind: 'reels' }).publicUrl || reelPath) : '',
      cover: coverPath ? (resolveInstagramHostedMediaUrl(coverPath, { kind: 'thumbs' }).publicUrl || coverPath) : '',
      qa: qaSheetPath ? (resolveInstagramHostedMediaUrl(qaSheetPath, { kind: 'thumbs' }).publicUrl || qaSheetPath) : '',
    };
  } catch {
    return { reel: '', cover: '', qa: '' };
  }
}

function getInstagramHostedRecovery(latestInstagram = null) {
  try {
    const title = String(latestInstagram?.post_title || '');
    const errorText = String(latestInstagram?.error_msg || '');
    if (!title || !errorText) return false;
    const { findReelPathForTitle } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/shortform-files.ts'));
    const reelPath = findReelPathForTitle(title) || '';
    if (!reelPath) return false;
    const hosted = resolveInstagramHostedMediaUrl(reelPath, { kind: 'reels' });
    return Boolean(
      hosted?.ready === true
      && (
        errorText.includes('Instagram 공개 비디오 URL이 아직 응답하지 않습니다')
        || errorText.includes('Instagram 공개 비디오 파일이 아직 준비되지 않았습니다')
      )
    );
  } catch {
    return false;
  }
}

async function getLatestFacebookPublish() {
  try {
    const rows = await pgPool.query('blog', `
      SELECT status, title, error, created_at
      FROM blog.publish_log
      WHERE platform = 'facebook'
      ORDER BY created_at DESC
      LIMIT 1
    `);
    return rows?.[0] || null;
  } catch {
    return null;
  }
}

async function getLatestInstagramPublish() {
  try {
    const rows = await pgPool.query('blog', `
      SELECT status, dry_run, post_title, error_msg, created_at
      FROM blog.instagram_crosspost
      ORDER BY created_at DESC
      LIMIT 1
    `);
    return rows?.[0] || null;
  } catch {
    return null;
  }
}

function buildActions({ facebookReadiness, instagramConfig, latestFacebook, latestInstagram, previewBundle, primary }) {
  const actions = [];
  const instagramHostedRecovery = getInstagramHostedRecovery(latestInstagram);
  const facebookReadinessError = String(facebookReadiness?.error || '').trim();
  const primaryArea = String(primary?.area || '');
  const hasActivePrimary = primaryArea && primaryArea !== 'clear' && primaryArea !== 'unknown';
  const prioritizeFacebook = primaryArea.startsWith('social.facebook');
  const prioritizeInstagram = primaryArea.startsWith('social.instagram');

  if (facebookReadinessError && !prioritizeInstagram) {
    actions.push('Facebook readiness 토큰/세션 상태를 먼저 확인');
    actions.push(`npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')} run check:facebook -- --json`);
    actions.push(`npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')} run doctor:facebook -- --json`);
  }

  if (!prioritizeInstagram && Array.isArray(facebookReadiness?.permissionScopes) && facebookReadiness.permissionScopes.length > 0) {
    actions.push(`Meta 앱 권한 재연결: ${facebookReadiness.permissionScopes.join(', ')}`);
    actions.push('페이지 권한 재연결 후 페이지 access token 다시 발급');
  }

  if (!prioritizeFacebook && !instagramConfig?.tokenHealth?.tokenExpiresAt) {
    actions.push('인스타 token_expires_at 저장 또는 refresh:instagram-token으로 만료일 확정');
  }

  if (!prioritizeFacebook && String(latestInstagram?.status || '') === 'failed' && !instagramHostedRecovery) {
    actions.push(`npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')} run check:instagram -- --json`);
    actions.push(`npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')} run doctor:instagram -- --json`);
  }

  if (!prioritizeInstagram && String(latestFacebook?.status || '') === 'failed') {
    actions.push(`npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')} run check:facebook -- --json`);
    actions.push(`npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')} run doctor:facebook -- --json`);
  }

  if ((previewBundle.reel || previewBundle.cover || previewBundle.qa) && !prioritizeFacebook) {
    actions.push('최신 reel / cover / qa preview를 확인한 뒤 재시도');
  }

  const prioritized = [];
  if (hasActivePrimary && primary?.actionFocus) {
    prioritized.push(`focus blocker: ${primary.actionFocus}`);
  }
  if (hasActivePrimary && primary?.nextCommand) {
    prioritized.push(`우선 실행: ${primary.nextCommand}`);
  }

  return Array.from(new Set([...prioritized, ...actions]));
}

function buildPrimary({ latestFacebook, latestInstagram, facebookReadiness, instagramConfig }) {
  const blogPrefix = `npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')}`;
  const instagramHostedRecovery = getInstagramHostedRecovery(latestInstagram);
  const facebookReadinessError = String(facebookReadiness?.error || '').trim();
  const tokenExpired = facebookReadinessError.includes('Facebook 사용자 access token 세션이 만료되었습니다.')
    || facebookReadinessError.includes('Session has expired');
  if (facebookReadinessError) {
    return {
      area: 'social.facebook.readiness',
      reason: tokenExpired
        ? 'Facebook 토큰 세션이 만료돼 다음 게시 전에 재발급이 필요합니다.'
        : 'Facebook readiness가 깨져 다음 게시 전에 토큰/권한 상태 확인이 필요합니다.',
      nextCommand: `${blogPrefix} run doctor:facebook -- --json`,
      actionFocus: tokenExpired
        ? '허브 Facebook 토큰 재발급 및 readiness 재확인'
        : 'Facebook readiness 에러 원인과 페이지 토큰 상태 재확인',
    };
  }
  if (String(latestFacebook?.status || '') === 'failed') {
    return {
      area: 'social.facebook',
      reason: 'Facebook publish 권한 이슈가 현재 소셜 채널 최우선 병목입니다.',
      nextCommand: `${blogPrefix} run doctor:facebook -- --json`,
      actionFocus: Array.isArray(facebookReadiness?.permissionScopes) && facebookReadiness.permissionScopes.length > 0
        ? `Meta 권한 재연결 (${facebookReadiness.permissionScopes.join(', ')})`
        : 'Meta 앱 권한 재연결과 페이지 토큰 재발급',
    };
  }
  if (String(latestInstagram?.status || '') === 'failed' && !latestInstagram?.dry_run && !instagramHostedRecovery) {
    return {
      area: 'social.instagram',
      reason: 'Instagram publish 실패가 현재 소셜 채널 최우선 병목입니다.',
      nextCommand: `${blogPrefix} run doctor:instagram -- --json`,
      actionFocus: instagramConfig?.tokenHealth?.tokenExpiresAt
        ? '공개 reel/cover/qa 자산과 최신 Instagram failure reason 재확인'
        : 'Instagram token 만료일과 hosted media readiness 재확인',
    };
  }
  return {
    area: 'clear',
    reason: '현재 소셜 채널의 즉시 조치가 필요한 병목은 없습니다.',
    nextCommand: `${blogPrefix} run doctor:social -- --json`,
    actionFocus: 'preview bundle과 readiness를 짧게 확인',
  };
}

function buildSocialDoctorFallback(payload = {}) {
  const primaryArea = String(payload?.primary?.area || '');
  const facebookError = String(payload?.facebook?.error || '');
  if (primaryArea === 'social.facebook.readiness') {
    if (facebookError.includes('Facebook 사용자 access token 세션이 만료되었습니다.')) {
      return '소셜 자동등록의 현재 최우선 병목은 Facebook 허브 사용자 토큰 만료라 access_token 교체와 readiness 재확인이 먼저입니다.';
    }
    return '소셜 자동등록의 현재 최우선 병목은 Facebook readiness 에러라 토큰/권한 상태를 먼저 확인하는 편이 좋습니다.';
  }
  if (primaryArea === 'social.facebook') {
    return '소셜 자동등록의 현재 최우선 병목은 Facebook 게시 권한/페이지 연결이라 Meta 권한과 페이지 토큰을 먼저 점검하는 편이 좋습니다.';
  }
  if (primaryArea === 'social.instagram') {
    return '소셜 자동등록의 현재 최우선 병목은 Instagram publish/readiness라 공개 자산과 게시 실패 이유를 먼저 점검하는 편이 좋습니다.';
  }
  if (payload.facebook?.needsAttention || payload.instagram?.needsAttention) {
    return '소셜 자동등록은 준비돼 있지만 최근 실패 흔적이 있어 채널별 doctor와 preview를 함께 보고 정리하는 편이 좋습니다.';
  }
  return '소셜 자동등록은 현재 큰 막힘 없이 유지되고 있어 readiness와 preview만 짧게 확인하면 됩니다.';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [facebookReadiness, instagramConfig, latestFacebook, latestInstagram] = await Promise.all([
    checkFacebookPublishReadiness().catch(() => null),
    getInstagramConfig().catch(() => null),
    getLatestFacebookPublish(),
    getLatestInstagramPublish(),
  ]);

  const previewTitle = String(
    latestInstagram?.post_title
    || latestFacebook?.title
    || ''
  );
  const previewBundle = buildPreviewBundleForTitle(previewTitle);
  const instagramHostedRecovery = getInstagramHostedRecovery(latestInstagram);

  const payload = {
    facebook: {
      ready: Boolean(facebookReadiness?.ready),
      pageId: String(facebookReadiness?.pageId || ''),
      permissionScopes: Array.isArray(facebookReadiness?.permissionScopes) ? facebookReadiness.permissionScopes : [],
      error: String(facebookReadiness?.error || ''),
      latest: latestFacebook
        ? {
            status: String(latestFacebook.status || 'unknown'),
            title: String(latestFacebook.title || ''),
            error: String(latestFacebook.error || ''),
            createdAt: latestFacebook.created_at || null,
          }
        : null,
      needsAttention: Boolean(String(facebookReadiness?.error || '').trim() || String(latestFacebook?.status || '') === 'failed'),
    },
    instagram: {
      ready: Boolean(
        instagramConfig?.accessToken
        && instagramConfig?.igUserId
        && instagramConfig?.appId
        && instagramConfig?.appSecret
      ),
      tokenExpiresAt: instagramConfig?.tokenHealth?.tokenExpiresAt || null,
      latest: latestInstagram
        ? {
            status: String(latestInstagram.status || 'unknown'),
            dryRun: Boolean(latestInstagram.dry_run),
            title: String(latestInstagram.post_title || ''),
            error: String(latestInstagram.error_msg || ''),
            createdAt: latestInstagram.created_at || null,
          }
        : null,
      hostedRecovery: instagramHostedRecovery,
      needsAttention: String(latestInstagram?.status || '') === 'failed' && !latestInstagram?.dry_run && !instagramHostedRecovery,
    },
    previewBundle,
  };

  payload.primary = buildPrimary({
    latestFacebook,
    latestInstagram,
    facebookReadiness,
    instagramConfig,
  });
  payload.actions = buildActions({
    facebookReadiness,
    instagramConfig,
    latestFacebook,
    latestInstagram,
    previewBundle,
    primary: payload.primary,
  });

  const aiSummary = await buildBlogCliInsight({
    bot: 'doctor-social-publish',
    requestType: 'doctor-social-publish',
    title: '블로그 소셜 publish doctor 요약',
    data: payload,
    fallback: buildSocialDoctorFallback(payload),
  });
  payload.aiSummary = aiSummary;

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`[social doctor] facebook=${payload.facebook.needsAttention ? 'attention' : 'ok'} instagram=${payload.instagram.needsAttention ? 'attention' : 'ok'}`);
  console.log(`🔍 AI: ${payload.aiSummary}`);
  console.log(`[social doctor] primary=${payload.primary.area} ${payload.primary.reason}`);
  console.log(`[social doctor] next=${payload.primary.nextCommand}`);
  if (payload.facebook.pageId) {
    console.log(`[social doctor] facebook page=${payload.facebook.pageId}`);
  }
  if (payload.previewBundle.reel || payload.previewBundle.cover || payload.previewBundle.qa) {
    console.log(`[social doctor] preview=reel=${payload.previewBundle.reel || 'missing'} / cover=${payload.previewBundle.cover || 'missing'} / qa=${payload.previewBundle.qa || 'missing'}`);
  }
  for (const action of payload.actions) {
    console.log(`- ${action}`);
  }
}

main().catch((error) => {
  console.error('[social doctor] 실패:', error?.message || error);
  process.exit(1);
});
