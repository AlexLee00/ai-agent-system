'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const { buildShortformPlan } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/shortform-planner.ts'));
const { SHORTFORM_DEFAULT_DURATION_SEC } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/shortform-planner.ts'));
const { generateInstaCaption } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/social.ts'));

const BLOG_ROOT = path.join(env.PROJECT_ROOT, 'bots/blog');
const IMAGE_DIR = path.join(BLOG_ROOT, 'output/images');
const OUTPUT_DIR = path.join(BLOG_ROOT, 'output/shortform');

/**
 * @typedef {{
 *   dryRun: boolean,
 *   json: boolean,
 *   title?: string,
 *   category?: string,
 *   thumb?: string,
 *   blogUrl?: string,
 *   contentFile?: string,
 *   durationSec?: number,
 * }} PrepareShortformArgs
 */

/** @returns {PrepareShortformArgs} */
function parseArgs(argv = []) {
  const args = /** @type {PrepareShortformArgs} */ ({
    dryRun: false,
    json: false,
    title: undefined,
    category: undefined,
    thumb: undefined,
    blogUrl: undefined,
    contentFile: undefined,
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
    else if (token === '--content-file') args.contentFile = argv[++i];
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

function readContent(contentFile = '') {
  if (!contentFile) return '';
  return fs.readFileSync(path.resolve(contentFile), 'utf8');
}

function slugify(text = '') {
  return String(text)
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const thumbPath = args.thumb ? path.resolve(args.thumb) : latestThumbPath();
  if (!thumbPath) throw new Error('숏폼 준비용 썸네일을 찾지 못했습니다.');
  const title = args.title || path.basename(thumbPath).replace(/_thumb\.png$/i, '').replace(/_/g, ' ');
  const category = args.category || '최신IT트렌드';
  const content = readContent(args.contentFile);

  const plan = buildShortformPlan({
    title,
    category,
    thumbPath,
    blogUrl: args.blogUrl || '',
    durationSec: args.durationSec || SHORTFORM_DEFAULT_DURATION_SEC,
    content
  });

  let captionData;
  try {
    captionData = await generateInstaCaption(content || title, title, category);
  } catch (error) {
    console.warn('[숏폼] 캡션 생성 실패 — 기본 템플릿 사용:', error?.message || error);
    const hashtags = ['#개발자일상', '#IT블로그', '#승호아빠', '#cafe_library', '#shorts', '#reels'];
    captionData = {
      caption: `📝 ${title}\n15~20초 안에 핵심만 정리했어요!`,
      hashtags,
      cta: plan.cta,
      fullText: `📝 ${title}\n15~20초 안에 핵심만 정리했어요!\n\n${plan.cta}\n\n${hashtags.join(' ')}`
    };
  }
  const result = {
    ...plan,
    instagram: {
      caption: captionData.caption,
      hashtags: captionData.hashtags,
      cta: plan.cta,
      fullText: `${captionData.caption}\n\n${plan.cta}\n\n${captionData.hashtags.join(' ')}`
    }
  };

  if (!args.dryRun) {
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const filePath = path.join(OUTPUT_DIR, `${slugify(title)}_shortform-plan.json`);
    fs.writeFileSync(filePath, JSON.stringify(result, null, 2));
    result.savedPath = filePath;
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`[숏폼] 제목: ${result.title}`);
  console.log(`[숏폼] 썸네일: ${result.thumbPath}`);
  console.log(`[숏폼] 훅: ${result.hook}`);
  console.log(`[숏폼] CTA: ${result.cta}`);
  console.log(`[숏폼] ffmpeg 초안: ${result.ffmpegPreview}`);
  if (result.savedPath) console.log(`[숏폼] 저장: ${result.savedPath}`);
}

main().catch((error) => {
  console.error('[숏폼] 준비 실패:', error?.message || error);
  process.exit(1);
});
