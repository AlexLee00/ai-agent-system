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

function buildActions({ facebookReadiness, instagramConfig, latestFacebook, latestInstagram, previewBundle }) {
  const actions = [];

  if (Array.isArray(facebookReadiness?.permissionScopes) && facebookReadiness.permissionScopes.length > 0) {
    actions.push(`Meta 앱 권한 재연결: ${facebookReadiness.permissionScopes.join(', ')}`);
    actions.push('페이지 권한 재연결 후 페이지 access token 다시 발급');
  }

  if (!instagramConfig?.tokenHealth?.tokenExpiresAt) {
    actions.push('인스타 token_expires_at 저장 또는 refresh:instagram-token으로 만료일 확정');
  }

  if (String(latestInstagram?.status || '') === 'failed') {
    actions.push(`npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')} run check:instagram -- --json`);
    actions.push(`npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')} run doctor:instagram -- --json`);
  }

  if (String(latestFacebook?.status || '') === 'failed') {
    actions.push(`npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')} run check:facebook -- --json`);
    actions.push(`npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')} run doctor:facebook -- --json`);
  }

  if (previewBundle.reel || previewBundle.cover || previewBundle.qa) {
    actions.push('최신 reel / cover / qa preview를 확인한 뒤 재시도');
  }

  return Array.from(new Set(actions));
}

function buildPrimary({ latestFacebook, latestInstagram, facebookReadiness, instagramConfig }) {
  const blogPrefix = `npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')}`;
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
  if (String(latestInstagram?.status || '') === 'failed' && !latestInstagram?.dry_run) {
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

  const payload = {
    facebook: {
      ready: Boolean(facebookReadiness?.ready),
      pageId: String(facebookReadiness?.pageId || ''),
      permissionScopes: Array.isArray(facebookReadiness?.permissionScopes) ? facebookReadiness.permissionScopes : [],
      latest: latestFacebook
        ? {
            status: String(latestFacebook.status || 'unknown'),
            title: String(latestFacebook.title || ''),
            error: String(latestFacebook.error || ''),
            createdAt: latestFacebook.created_at || null,
          }
        : null,
      needsAttention: String(latestFacebook?.status || '') === 'failed',
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
      needsAttention: String(latestInstagram?.status || '') === 'failed' && !latestInstagram?.dry_run,
    },
    previewBundle,
  };

  payload.actions = buildActions({
    facebookReadiness,
    instagramConfig,
    latestFacebook,
    latestInstagram,
    previewBundle,
  });
  payload.primary = buildPrimary({
    latestFacebook,
    latestInstagram,
    facebookReadiness,
    instagramConfig,
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
