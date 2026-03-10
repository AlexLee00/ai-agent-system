'use strict';

/**
 * img-gen.js — 블로그 포스팅 이미지 자동 생성
 *
 * 모델: gpt-image-1 (high quality)
 * 생성: 대표 이미지 1장 + 본문 중간 이미지 1장 (총 2장/편)
 * 저장: bots/blog/output/images/{날짜}_{postType}_{slug}_{thumb|mid}.png
 */

const fs   = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { getOpenAIKey } = require('../../../packages/core/lib/llm-keys');

const OUTPUT_DIR  = path.join(__dirname, '..', 'output');
const IMAGES_DIR  = path.join(OUTPUT_DIR, 'images');
const GDRIVE_DIR  = '/Users/alexlee/Library/CloudStorage/GoogleDrive-***REMOVED***/내 드라이브/010_BlogPost/images';

const MODEL   = 'gpt-image-1';
const QUALITY = 'high';
const SIZE    = '1024x1024';

// ─── 프롬프트 빌더 ────────────────────────────────────────────────────

const STYLE_BASE = 'Clean, modern, professional blog thumbnail. No text overlay. Soft lighting, high resolution.';

function _buildPrompt(title, postType, category) {
  if (postType === 'lecture') {
    // Node.js 강의 → 기술/개발 느낌
    const topic = title.replace(/\[Node\.js \d+강\]\s*/, '').trim();
    return `${STYLE_BASE} Topic: "${topic}". Technology and software development theme. Dark modern UI aesthetic, code editor vibes, subtle Node.js green accent color (#68a063). Abstract digital background.`;
  }

  // 일반 포스팅 → 카테고리별 스타일
  const categoryStyles = {
    '최신IT트렌드':    'Futuristic technology theme, AI and innovation, glowing neural network, deep blue and purple gradient.',
    'IT정보와분석':    'Data visualization, charts and graphs, business intelligence, clean infographic style, blue tones.',
    '홈페이지와App':  'Modern web and mobile app design, UI/UX, smartphone and laptop, clean white and blue.',
    '자기계발':       'Growth mindset, sunrise, open book, person climbing stairs, warm orange and yellow tones.',
    '도서리뷰':       'Open book with soft light, cozy reading atmosphere, warm tones, library background.',
    '성장과성공':     'Success concept, upward arrow, achievement trophy, motivated person, gold and navy tones.',
    '개발기획과컨설팅': 'Project planning, whiteboard with diagrams, team collaboration, professional office setting.',
  };
  const style = categoryStyles[category] || 'Modern professional blog image, clean minimal design.';
  const topic = title.replace(/\[.*?\]\s*/, '').trim();
  return `${STYLE_BASE} Topic: "${topic}". ${style}`;
}

function _buildMidPrompt(title, postType, category) {
  // 본문 중간 이미지 — 대표보다 조금 더 내용 연관
  if (postType === 'lecture') {
    const topic = title.replace(/\[Node\.js \d+강\]\s*/, '').trim();
    return `${STYLE_BASE} Illustrating the concept of "${topic}" in software development. Code snippets, flowchart elements, or system architecture diagram style. Dark theme, developer aesthetic.`;
  }
  const topic = title.replace(/\[.*?\]\s*/, '').trim();
  return `${STYLE_BASE} Detailed illustration supporting the blog post about "${topic}". Engaging, informative visual with subtle icons or abstract shapes related to "${category}".`;
}

// ─── 이미지 생성 & 저장 ───────────────────────────────────────────────

async function _generateOne(client, prompt, slug, label) {
  const resp = await client.images.generate({
    model:   MODEL,
    prompt,
    n:       1,
    size:    SIZE,
    quality: QUALITY,
  });

  const b64 = resp.data[0].b64_json;
  if (!b64) throw new Error('b64_json 없음');

  const filename = `${slug}_${label}.png`;
  const filepath = path.join(IMAGES_DIR, filename);
  fs.writeFileSync(filepath, Buffer.from(b64, 'base64'));

  // 구글드라이브 복사
  try {
    if (!fs.existsSync(GDRIVE_DIR)) fs.mkdirSync(GDRIVE_DIR, { recursive: true });
    fs.writeFileSync(path.join(GDRIVE_DIR, filename), Buffer.from(b64, 'base64'));
  } catch (_) {}

  return { filename, filepath };
}

// ─── 메인 함수 ────────────────────────────────────────────────────────

/**
 * 포스팅 이미지 생성 (대표 1장 + 본문 중간 1장)
 * @param {{ title, postType, category }} postMeta
 * @returns {{ thumb: {filename, filepath}, mid: {filename, filepath} } | null}
 */
async function generatePostImages({ title, postType, category }) {
  const apiKey = getOpenAIKey();
  if (!apiKey) {
    console.warn('[이미지] OpenAI API 키 없음 — 이미지 생성 스킵');
    return null;
  }

  // 디렉토리 보장
  if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

  const today    = new Date().toISOString().slice(0, 10);
  const safeSlug = (title || '').replace(/[^가-힣a-zA-Z0-9]/g, '_').slice(0, 40);
  const slug     = `${today}_${postType}_${safeSlug}`;

  const client = new OpenAI({ apiKey });

  console.log(`[이미지] 생성 시작 (gpt-image-1 high) — ${title}`);

  const thumbPrompt = _buildPrompt(title, postType, category);
  const midPrompt   = _buildMidPrompt(title, postType, category);

  const [thumb, mid] = await Promise.all([
    _generateOne(client, thumbPrompt, slug, 'thumb').catch(e => {
      console.warn('[이미지] 대표 이미지 실패:', e.message); return null;
    }),
    _generateOne(client, midPrompt, slug, 'mid').catch(e => {
      console.warn('[이미지] 중간 이미지 실패:', e.message); return null;
    }),
  ]);

  if (thumb) console.log(`[이미지] ✅ 대표: images/${thumb.filename}`);
  if (mid)   console.log(`[이미지] ✅ 중간: images/${mid.filename}`);

  return { thumb, mid };
}

module.exports = { generatePostImages, IMAGES_DIR };
