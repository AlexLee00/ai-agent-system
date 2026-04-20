'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const { buildShortformPlan } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/shortform-planner.ts'));
const { SHORTFORM_DEFAULT_DURATION_SEC } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/shortform-planner.ts'));
const { renderShortformReel } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/shortform-renderer.ts'));
const { generatePostImages } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/img-gen.ts'));
const {
  findLatestThumbPath,
  selectThumbForTitle,
} = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/shortform-files.ts'));

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

function inferPostType(category = '') {
  return String(category || '') === 'Node.js강의' ? 'lecture' : 'general';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const category = args.category || '최신IT트렌드';
  const thumbSelection = args.thumb
    ? { path: path.resolve(args.thumb), score: 999, matchType: 'explicit' }
    : (args.title ? selectThumbForTitle(args.title, category, { purpose: 'reel' }) : null);
  let thumbPath = args.thumb
    ? path.resolve(args.thumb)
    : thumbSelection?.path || (!args.title ? findLatestThumbPath() : null);
  let effectiveThumbSelection = thumbSelection;

  if (!thumbPath && args.title && !args.dryRun) {
    console.log('[숏폼렌더] 매칭 썸네일 없음 — 릴스용 썸네일을 새로 생성합니다');
    const generated = await generatePostImages({
      title: args.title,
      postType: inferPostType(category),
      category,
      format: 'reel',
    });
    if (generated?.thumb?.filepath) {
      thumbPath = generated.thumb.filepath;
      effectiveThumbSelection = {
        path: thumbPath,
        score: 1000,
        matchType: 'generated',
      };
    }
  }

  if (!thumbPath) {
    throw new Error('렌더할 썸네일을 찾지 못했습니다.');
  }

  const title = args.title || path.basename(thumbPath).replace(/_thumb\.png$/i, '').replace(/_/g, ' ');
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
    storyboard: plan.storyboard,
    title: plan.title,
    hook: plan.hook,
    cta: plan.cta,
  });

  const payload = {
    ...plan,
    thumbSelection: effectiveThumbSelection,
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
