'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const { getInstagramConfig } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/instagram-publisher.ts'));

const BLOG_ROOT = path.join(env.PROJECT_ROOT, 'bots/blog');
const SHORTFORM_DIR = path.join(BLOG_ROOT, 'output/shortform');

function parseArgs(argv = []) {
  return {
    json: argv.includes('--json'),
  };
}

function latestReelPath() {
  if (!fs.existsSync(SHORTFORM_DIR)) return null;
  const files = fs
    .readdirSync(SHORTFORM_DIR)
    .filter((name) => name.endsWith('_reel.mp4'))
    .map((name) => path.join(SHORTFORM_DIR, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] || null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await getInstagramConfig();
  const reelPath = latestReelPath();
  const missing = [];

  if (!config.accessToken) missing.push('instagram.access_token');
  if (!config.igUserId) missing.push('instagram.ig_user_id');
  if (!reelPath) missing.push('latest_reel_mp4');

  const payload = {
    ready: missing.length === 0,
    missing,
    source: {
      apiVersion: config.apiVersion || 'v21.0',
      baseUrl: config.baseUrl || 'https://graph.facebook.com',
      hasAccessToken: Boolean(config.accessToken),
      hasIgUserId: Boolean(config.igUserId),
    },
    reel: reelPath
      ? {
          path: reelPath,
          sizeBytes: fs.statSync(reelPath).size,
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
