'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const { buildShortformPlan } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/shortform-planner.ts'));
const { SHORTFORM_DEFAULT_DURATION_SEC } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/shortform-planner.ts'));
const { renderShortformReel } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/shortform-renderer.ts'));

const BLOG_ROOT = path.join(env.PROJECT_ROOT, 'bots/blog');
const IMAGE_DIR = path.join(BLOG_ROOT, 'output/images');

/**
 * @typedef {{
 *   dryRun: boolean,
 *   json: boolean,
 *   title?: string,
 *   category?: string,
 *   thumb?: string,
 *   blogUrl?: string,
 *   durationSec?: number,
 * }} RenderShortformArgs
 */

/** @returns {RenderShortformArgs} */
function parseArgs(argv = []) {
  const args = /** @type {RenderShortformArgs} */ ({
    dryRun: false,
    json: false,
    title: undefined,
    category: undefined,
    thumb: undefined,
    blogUrl: undefined,
    durationSec: undefined,
  });
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--dry-run') args.dryRun = true;
    else if (token === '--json') args.json = true;
    else if (token === '--title') args.title = argv[++i];
    else if (token === '--category') args.category = argv[++i];
    else if (token === '--thumb') args.thumb = argv[++i];
    else if (token === '--blog-url') args.blogUrl = argv[++i];
    else if (token === '--duration') args.durationSec = Number(argv[++i] || SHORTFORM_DEFAULT_DURATION_SEC);
  }
  return args;
}

function latestThumbPath() {
  if (!fs.existsSync(IMAGE_DIR)) return null;
  const files = fs
    .readdirSync(IMAGE_DIR)
    .filter((name) => name.endsWith('_thumb.png'))
    .map((name) => path.join(IMAGE_DIR, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] || null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const thumbPath = args.thumb ? path.resolve(args.thumb) : latestThumbPath();
  if (!thumbPath) throw new Error('렌더할 썸네일을 찾지 못했습니다.');

  const title = args.title || path.basename(thumbPath).replace(/_thumb\.png$/i, '').replace(/_/g, ' ');
  const category = args.category || '최신IT트렌드';
  const durationSec = args.durationSec || SHORTFORM_DEFAULT_DURATION_SEC;

  const plan = buildShortformPlan({
    title,
    category,
    thumbPath,
    blogUrl: args.blogUrl || '',
    durationSec,
  });

  if (args.dryRun) {
    if (args.json) {
      console.log(JSON.stringify(plan, null, 2));
      return;
    }
    console.log(`[숏폼렌더] dry-run: ${plan.outputPath}`);
    console.log(`[숏폼렌더] ffmpeg: ${plan.ffmpegPreview}`);
    return;
  }

  const result = await renderShortformReel({
    thumbPath: plan.thumbPath,
    outputPath: plan.outputPath,
    durationSec: plan.durationSec,
  });

  const payload = {
    ...plan,
    render: result,
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`[숏폼렌더] 완료: ${result.outputPath}`);
  console.log(`[숏폼렌더] 크기: ${result.fileSize} bytes`);
}

main().catch((error) => {
  console.error('[숏폼렌더] 실패:', error?.message || error);
  process.exit(1);
});
