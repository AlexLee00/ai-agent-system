'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const {
  resolveInstagramHostedMediaUrl,
  getInstagramHostedAssetLocalPath,
} = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/instagram-image-host.ts'));
const {
  findLatestReelPath,
  findLatestReelCoverPath,
  findLatestThumbPath,
} = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/shortform-files.ts'));

function parseArgs(argv = []) {
  return {
    json: argv.includes('--json'),
    dryRun: argv.includes('--dry-run'),
    includeThumb: !argv.includes('--no-thumb'),
    includeCover: !argv.includes('--no-cover'),
    video: readOption(argv, '--video'),
    thumb: readOption(argv, '--thumb'),
    cover: readOption(argv, '--cover'),
  };
}

function readOption(argv = [], flag = '') {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] || '' : '';
}

function ensureParentDir(targetPath = '') {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
}

function ensureGithubPagesMarker(dryRun = false) {
  const markerPath = path.join(env.PROJECT_ROOT, 'docs', '.nojekyll');
  if (!dryRun && !fs.existsSync(markerPath)) {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, '');
  }
  return markerPath;
}

function stageAsset(filePath = '', kind = 'asset', dryRun = false) {
  if (!filePath) return null;
  if (!fs.existsSync(filePath)) {
    throw new Error(`배치할 파일을 찾을 수 없습니다: ${filePath}`);
  }

  const hosted = resolveInstagramHostedMediaUrl(filePath, { kind });
  const localTarget = getInstagramHostedAssetLocalPath(filePath, { kind });
  const sizeBytes = fs.statSync(filePath).size;

  if (!dryRun) {
    ensureParentDir(localTarget.targetPath);
    fs.copyFileSync(filePath, localTarget.targetPath);
  }

  return {
    kind,
    sourcePath: filePath,
    targetPath: localTarget.targetPath,
    relativePath: localTarget.relativePath,
    publicUrl: hosted.publicUrl || '',
    hostMode: hosted.mode || '',
    ready: hosted.ready === true,
    sizeBytes,
    copied: !dryRun,
  };
}

function printHuman(payload) {
  console.log(`[인스타 준비] reel=${payload.reel ? payload.reel.targetPath : 'missing'}`);
  if (payload.cover) {
    console.log(`[인스타 준비] cover=${payload.cover.targetPath}`);
  }
  if (payload.thumb) {
    console.log(`[인스타 준비] thumb=${payload.thumb.targetPath}`);
  }
  console.log(`[인스타 준비] publicReady=${payload.publicReady ? 'yes' : 'no'}`);
  if (payload.reel?.publicUrl) {
    console.log(`[인스타 준비] reelUrl=${payload.reel.publicUrl}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const reelPath = args.video ? path.resolve(args.video) : findLatestReelPath();
  if (!reelPath) {
    throw new Error('준비할 릴스 파일을 찾지 못했습니다.');
  }

  const thumbPath = args.includeThumb
    ? (args.thumb ? path.resolve(args.thumb) : findLatestThumbPath())
    : '';
  const coverPath = args.includeCover
    ? (args.cover ? path.resolve(args.cover) : findLatestReelCoverPath())
    : '';

  const reel = stageAsset(reelPath, 'reels', args.dryRun);
  const cover = coverPath ? stageAsset(coverPath, 'thumbs', args.dryRun) : null;
  const thumb = thumbPath ? stageAsset(thumbPath, 'thumbs', args.dryRun) : null;
  const payload = {
    dryRun: args.dryRun,
    publicReady: reel?.ready === true,
    noJekyllPath: ensureGithubPagesMarker(args.dryRun),
    reel,
    cover,
    thumb,
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  printHuman(payload);
}

main();
