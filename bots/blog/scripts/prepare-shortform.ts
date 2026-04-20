'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const { buildShortformPlan } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/shortform-planner.ts'));
const { SHORTFORM_DEFAULT_DURATION_SEC } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/shortform-planner.ts'));
const { generateInstaCaption } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/social.ts'));
const { generatePostImages } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/img-gen.ts'));
const {
  findLatestThumbPath,
  selectThumbForTitle,
} = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/shortform-files.ts'));

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

function inferPostType(category = '') {
  return String(category || '') === 'Node.js강의' ? 'lecture' : 'general';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const category = args.category || '최신IT트렌드';
  const thumbSelection = args.thumb
    ? { path: path.resolve(args.thumb), score: 999, matchType: 'explicit' }
    : (args.title ? selectThumbForTitle(args.title, category) : null);
  let resolvedThumb = args.thumb
    ? path.resolve(args.thumb)
    : thumbSelection?.path || (!args.title ? findLatestThumbPath() : null);
  let effectiveThumbSelection = thumbSelection;

  if (!resolvedThumb && args.title && !args.dryRun) {
    console.log('[숏폼] 매칭 썸네일 없음 — 릴스용 썸네일을 새로 생성합니다');
    const generated = await generatePostImages({
      title: args.title,
      postType: inferPostType(category),
      category,
    });
    if (generated?.thumb?.filepath) {
      resolvedThumb = generated.thumb.filepath;
      effectiveThumbSelection = {
        path: resolvedThumb,
        score: 1000,
        matchType: 'generated',
      };
    }
  }

  if (!resolvedThumb) {
    if (args.dryRun) {
      const payload = {
        ok: false,
        title: args.title || '',
        category,
        thumbSelection: {
          path: null,
          score: 0,
          matchType: 'missing',
        },
        thumbFallback: 'generate_required',
        reason: '숏폼 준비용 썸네일을 찾지 못했습니다.',
      };
      if (args.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log('[숏폼] 매칭 썸네일이 없어 새 썸네일 생성이 필요합니다');
      return;
    }
    throw new Error('숏폼 준비용 썸네일을 찾지 못했습니다.');
  }

  const thumbPath = resolvedThumb;
  const title = args.title || path.basename(thumbPath).replace(/_thumb\.png$/i, '').replace(/_/g, ' ');
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
    },
    thumbSelection: effectiveThumbSelection,
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
