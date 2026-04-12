'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const { publishInstagramReel, buildHostedVideoUrl } = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/instagram-graph.ts'));
const { findLatestReelPath } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/shortform-files.ts'));
const { parseInstagramAuthError } = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/instagram-token-manager.ts'));

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const videoPath = args.video ? path.resolve(args.video) : findLatestReelPath();
  if (!videoPath) throw new Error('업로드할 릴스 파일을 찾지 못했습니다.');

  const caption = args.caption || '릴스 초안 업로드 테스트입니다.';
  const result = await publishInstagramReel({
    videoUrl: buildHostedVideoUrl(videoPath),
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
  const diagnosis = parseInstagramAuthError(error);
  console.error('[인스타] 업로드 실패:', error?.message || error);
  if (diagnosis?.code && diagnosis.code !== 'unknown_auth_error') {
    console.error(`[인스타] 진단: ${diagnosis.code} | ${diagnosis.note}`);
  }
  process.exit(1);
});
