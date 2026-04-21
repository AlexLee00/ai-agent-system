#!/usr/bin/env node
'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');
const pgPool = require('../../../packages/core/lib/pg-pool.js');
const { checkFacebookPublishReadiness } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/facebook-publisher.ts'));
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

function buildActions({ readiness, latest, previewBundle }) {
  const actions = [];
  const readinessError = String(readiness?.error || '');
  if (readinessError.includes('Facebook 사용자 access token 세션이 만료되었습니다.')) {
    actions.push('허브 instagram secret의 access_token을 새 장기 사용자 토큰으로 교체');
    actions.push(`npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')} run check:facebook -- --json`);
  }
  if (Array.isArray(readiness?.permissionScopes) && readiness.permissionScopes.length > 0) {
    actions.push(`Meta 앱 권한 재연결: ${readiness.permissionScopes.join(', ')}`);
    actions.push('페이지 권한 재연결 후 페이지 access token 다시 발급');
  }
  if (latest?.status === 'failed') {
    actions.push(`npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')} run publish:facebook -- --dry-run`);
  }
  if (previewBundle.reel || previewBundle.cover || previewBundle.qa) {
    actions.push('최신 reel / cover / qa preview를 확인한 뒤 재시도');
  }
  if (actions.length === 0) {
    actions.push(`npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')} run publish:facebook -- --dry-run`);
  }
  return actions;
}

function buildFacebookDoctorFallback(payload = {}) {
  if (!payload.ready) {
    if (String(payload.error || '').includes('Facebook 사용자 access token 세션이 만료되었습니다.')) {
      return '페이스북 자동등록은 현재 허브 사용자 토큰 만료가 핵심이라 access_token 재발급과 readiness 재확인이 먼저입니다.';
    }
    return '페이스북 자동등록은 아직 권한 또는 페이지 연결을 먼저 정리하는 편이 좋습니다.';
  }
  if (payload.latest?.status === 'failed') {
    return '페이스북 readiness는 살아 있지만 최근 실게시 실패가 남아 있어 권한/페이지 토큰을 다시 확인하는 편이 좋습니다.';
  }
  return '페이스북 자동등록 준비는 갖춰져 있어 dry-run 또는 실게시로 마지막 점검만 하면 됩니다.';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const readiness = await checkFacebookPublishReadiness();
  const latest = await getLatestFacebookPublish();
  const previewBundle = buildPreviewBundleForTitle(String(latest?.title || ''));

  /** @type {any} */
  const payload = {
    ready: Boolean(readiness?.ready),
    credentialSource: readiness?.credentialSource || 'unknown',
    pageId: readiness?.pageId || '',
    permissionScopes: Array.isArray(readiness?.permissionScopes) ? readiness.permissionScopes : [],
    error: String(readiness?.error || ''),
    latest: latest
      ? {
          status: String(latest.status || 'unknown'),
          title: String(latest.title || ''),
          error: String(latest.error || ''),
          createdAt: latest.created_at || null,
        }
      : null,
    previewBundle,
    actions: buildActions({ readiness, latest, previewBundle }),
  };

  const aiSummary = await buildBlogCliInsight({
    bot: 'doctor-facebook-publish',
    requestType: 'doctor-facebook-publish',
    title: '블로그 페이스북 publish doctor 요약',
    data: {
      ready: payload.ready,
      pageId: payload.pageId,
      permissionScopes: payload.permissionScopes,
      latest: payload.latest,
      previewBundle: payload.previewBundle,
      actions: payload.actions,
    },
    fallback: buildFacebookDoctorFallback(payload),
  });
  payload.aiSummary = aiSummary;

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`[facebook doctor] ready=${payload.ready ? 'yes' : 'no'} source=${payload.credentialSource}`);
  console.log(`🔍 AI: ${payload.aiSummary}`);
  console.log(`[facebook doctor] page=${payload.pageId || 'missing'}`);
  console.log(`[facebook doctor] scopes=${payload.permissionScopes.length ? payload.permissionScopes.join(', ') : 'ok'}`);
  if (payload.latest) {
    console.log(`[facebook doctor] latest=${payload.latest.status} ${payload.latest.title}`);
    if (payload.latest.error) {
      console.log(`[facebook doctor] latestError=${payload.latest.error}`);
    }
  }
  if (payload.previewBundle.reel || payload.previewBundle.cover || payload.previewBundle.qa) {
    console.log(`[facebook doctor] preview=reel=${payload.previewBundle.reel || 'missing'} / cover=${payload.previewBundle.cover || 'missing'} / qa=${payload.previewBundle.qa || 'missing'}`);
  }
  for (const action of payload.actions) {
    console.log(`- ${action}`);
  }
}

main().catch((error) => {
  console.error('[facebook doctor] 실패:', error?.message || error);
  process.exit(1);
});
