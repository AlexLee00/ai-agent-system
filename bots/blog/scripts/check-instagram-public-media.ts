'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');
const {
  buildHostedVideoUrl,
  verifyPublicMediaUrl,
} = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/instagram-graph.ts'));
const { findLatestReelPath } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/shortform-files.ts'));

function parseArgs(argv = []) {
  return {
    json: argv.includes('--json'),
    video: readOption(argv, '--video'),
  };
}

function readOption(argv = [], flag = '') {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] || '' : '';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const reelPath = args.video ? path.resolve(args.video) : findLatestReelPath();
  if (!reelPath) {
    throw new Error('확인할 릴스 파일을 찾지 못했습니다.');
  }

  const publicUrl = buildHostedVideoUrl(reelPath);
  const result = await verifyPublicMediaUrl(publicUrl);
  const payload = {
    reelPath,
    publicUrl,
    ...result,
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`[인스타 public media] ${payload.ok ? 'ready' : 'not-ready'} status=${payload.status || 'n/a'} method=${payload.method}`);
  console.log(`[인스타 public media] ${payload.publicUrl}`);
}

main().catch((error) => {
  console.error('[인스타 public media] 실패:', error?.message || error);
  process.exit(1);
});
