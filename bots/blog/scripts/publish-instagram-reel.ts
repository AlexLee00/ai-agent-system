'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const { publishInstagramReel, buildFileVideoUrl } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/instagram-publisher.js'));

const BLOG_ROOT = path.join(env.PROJECT_ROOT, 'bots/blog');
const SHORTFORM_DIR = path.join(BLOG_ROOT, 'output/shortform');

/**
 * @typedef {{
 *   dryRun: boolean,
 *   json: boolean,
 *   video?: string,
 *   caption?: string,
 * }} PublishInstagramArgs
 */

/** @returns {PublishInstagramArgs} */
function parseArgs(argv = []) {
  const args = /** @type {PublishInstagramArgs} */ ({
    dryRun: false,
    json: false,
    video: undefined,
    caption: undefined,
  });
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--dry-run') args.dryRun = true;
    else if (token === '--json') args.json = true;
    else if (token === '--video') args.video = argv[++i];
    else if (token === '--caption') args.caption = argv[++i];
  }
  return args;
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
  const videoPath = args.video ? path.resolve(args.video) : latestReelPath();
  if (!videoPath) throw new Error('업로드할 릴스 파일을 찾지 못했습니다.');

  const caption = args.caption || '릴스 초안 업로드 테스트입니다.';
  const result = await publishInstagramReel({
    videoUrl: buildFileVideoUrl(videoPath),
    caption,
    dryRun: args.dryRun || false,
  });

  const payload = {
    videoPath,
    caption,
    ...result,
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`[인스타] 대상: ${videoPath}`);
  console.log(`[인스타] dryRun: ${payload.dryRun ? 'yes' : 'no'}`);
  if (payload.dryRun) {
    console.log(`[인스타] media 요청: ${payload.createRequest.url}`);
    return;
  }
  console.log(`[인스타] creationId: ${payload.creationId}`);
  console.log(`[인스타] publishId: ${payload.publishId || 'n/a'}`);
}

main().catch((error) => {
  console.error('[인스타] 업로드 실패:', error?.message || error);
  process.exit(1);
});
