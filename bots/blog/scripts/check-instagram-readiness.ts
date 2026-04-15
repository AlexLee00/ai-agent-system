'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const { getInstagramConfig } = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/instagram-graph.ts'));
const {
  resolveInstagramHostedMediaUrl,
  getInstagramHostedAssetLocalPath,
} = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/instagram-image-host.ts'));
const { findLatestReelPath } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/shortform-files.ts'));
const { buildBlogCliInsight } = require('../lib/cli-insight.ts');

function parseArgs(argv = []) {
  return {
    json: argv.includes('--json'),
  };
}

function buildInstagramReadinessFallback(payload = {}) {
  if (!payload.ready) {
    return `인스타 업로드 준비가 아직 불완전해 missing 항목 ${Array.isArray(payload.missing) ? payload.missing.length : 0}개를 먼저 채우는 편이 좋습니다.`;
  }
  return '인스타 업로드 readiness는 현재 갖춰져 있어 실제 게시 전 마지막 공개 URL 확인만 하면 됩니다.';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await getInstagramConfig();
  const reelPath = findLatestReelPath();
  const missing = [];
  const hosted = reelPath ? resolveInstagramHostedMediaUrl(reelPath, { kind: 'reels' }) : null;
  const localTarget = reelPath ? getInstagramHostedAssetLocalPath(reelPath, { kind: 'reels' }) : null;
  const staged = localTarget ? fs.existsSync(localTarget.targetPath) : false;

  if (!config.accessToken) missing.push('instagram.access_token');
  if (!config.igUserId) missing.push('instagram.ig_user_id');
  if (!reelPath) missing.push('latest_reel_mp4');
  if (reelPath && !hosted?.ready) missing.push('instagram.public_media_url');
  if (reelPath && hosted?.mode === 'github_pages' && !staged) missing.push('instagram.staged_media');

  const payload = {
    ready: missing.length === 0,
    missing,
    note: 'Instagram Graph credentials are resolved from hub secrets first, then hub-managed secrets-store/env fallback.',
    source: {
      credentialSource: config.credentialSource || 'unknown',
      apiVersion: config.apiVersion || 'v21.0',
      baseUrl: config.baseUrl || 'https://graph.facebook.com',
      hasAccessToken: Boolean(config.accessToken),
      hasIgUserId: Boolean(config.igUserId),
      tokenHealth: config.tokenHealth || null,
    },
    reel: reelPath
      ? {
          path: reelPath,
          sizeBytes: fs.statSync(reelPath).size,
          hostedUrl: hosted?.publicUrl || null,
          hostedReady: hosted?.ready === true,
          hostMode: hosted?.mode || null,
          stagedPath: localTarget?.targetPath || null,
          stagedReady: staged,
        }
      : null,
  };
  payload.aiSummary = await buildBlogCliInsight({
    bot: 'check-instagram-readiness',
    requestType: 'check-instagram-readiness',
    title: '블로그 인스타그램 readiness 요약',
    data: {
      ready: payload.ready,
      missing: payload.missing,
      source: payload.source,
      reel: payload.reel,
    },
    fallback: buildInstagramReadinessFallback(payload),
  });

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`[인스타 readiness] ready=${payload.ready ? 'yes' : 'no'}`);
  console.log(`🔍 AI: ${payload.aiSummary}`);
  console.log(`[인스타 readiness] token=${payload.source.hasAccessToken ? 'yes' : 'no'} igUserId=${payload.source.hasIgUserId ? 'yes' : 'no'}`);
  console.log(`[인스타 readiness] reel=${payload.reel ? payload.reel.path : 'missing'}`);
  if (missing.length) {
    console.log(`[인스타 readiness] missing=${missing.join(', ')}`);
  }
}

main().catch((error) => {
  console.error('[인스타 readiness] 실패:', error?.message || error);
  process.exit(1);
});
