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

function parseArgs(argv = []) {
  return {
    json: argv.includes('--json'),
  };
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
    note: 'Instagram Graph credentials are resolved from hub secrets first, then local secrets-store/env fallback.',
    source: {
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

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`[인스타 readiness] ready=${payload.ready ? 'yes' : 'no'}`);
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
