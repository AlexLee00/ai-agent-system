// @ts-nocheck
'use strict';
const kst = require('../../../packages/core/lib/kst');

/**
 * img-gen.js — 블로그팀 이미지 생성
 *
 * 전략: 로컬 이미지 엔진 메인 + 로컬 재시도
 *
 * 함수:
 *   generateImage(prompt, opts)          — 단건 생성 (폴백 체인)
 *   generateWithComfyUI(prompt, opts)    — 로컬 이미지 생성 (ComfyUI / Draw Things)
 *   generatePostImages({ title, postType, category }) — 블로그 포스팅 이미지 2장
 *   generateInstaCard(summary, cardIndex, outputPath) — 인스타 카드 1장
 *
 * 비용:
 *   로컬 자원 사용 (메인)
 */

const fs = require('fs');
const path = require('path');
const { selectRuntime } = require('../../../packages/core/lib/runtime-selector');
const { generateWithComfyUI } = require('../../../packages/core/lib/local-image-client');

const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const IMAGES_DIR = path.join(OUTPUT_DIR, 'images');
const GDRIVE_DIR = process.env.GDRIVE_BLOG_IMAGES || '/tmp/blog-images';

async function generateImage(prompt, opts = {}) {
  const { outputPath, ...genOpts } = opts;
  const runtimeProfile = await selectRuntime('blog', 'image-local');
  const result = await generateWithComfyUI(prompt, {
    ...genOpts,
    runtimeProfile,
  });
  if (outputPath) _saveBuffer(result.buffer, outputPath);
  return { ...result, fallback: false };
}

function _saveBuffer(buffer, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buffer);
}

const STYLE_BASE = [
  'Clean, modern, professional blog thumbnail.',
  'No text overlay.',
  'Soft lighting, high resolution.',
  'Absolutely no readable text, letters, numbers, words, UI labels, logos, signage, checklist text, whiteboard text, or typography anywhere in the image.',
  'If documents, screens, boards, or clipboards appear, render only abstract wireframe blocks, empty cards, icons, or illegible placeholder marks.',
].join(' ');

function _hashSeed(input) {
  const text = String(input || '');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function _pickVariant(list, seed, offset = 0) {
  if (!Array.isArray(list) || !list.length) return '';
  return list[(seed + offset) % list.length];
}

function _buildVisualVariant(title, postType, category, label) {
  const seed = _hashSeed(`${postType}:${category}:${label}:${title}`);
  const categoryTypePools = {
    '최신IT트렌드': {
      thumb: ['cinematic photo', 'animation concept art', 'modern infographic scene'],
      mid: ['isometric explainer visual', 'animation storyboard scene', 'editorial illustration'],
    },
    'IT정보와분석': {
      thumb: ['modern infographic scene', 'editorial illustration', 'documentary-style photo'],
      mid: ['isometric explainer visual', 'editorial illustration', 'modern infographic scene'],
    },
    '홈페이지와App': {
      thumb: ['editorial illustration', 'cinematic photo', 'modern infographic scene'],
      mid: ['isometric explainer visual', 'editorial illustration', 'animation storyboard scene'],
    },
    '자기계발': {
      thumb: ['cinematic photo', 'animation concept art', 'editorial illustration'],
      mid: ['animation storyboard scene', 'documentary-style photo', 'editorial illustration'],
    },
    '도서리뷰': {
      thumb: ['documentary-style photo', 'editorial illustration', 'animation concept art'],
      mid: ['editorial illustration', 'documentary-style photo', 'animation storyboard scene'],
    },
    '성장과성공': {
      thumb: ['cinematic photo', 'modern infographic scene', 'editorial illustration'],
      mid: ['editorial illustration', 'isometric explainer visual', 'documentary-style photo'],
    },
    '개발기획과컨설팅': {
      thumb: ['modern infographic scene', 'editorial illustration', 'cinematic photo'],
      mid: ['editorial illustration', 'isometric explainer visual', 'documentary-style photo'],
    },
    default: {
      thumb: ['cinematic photo', 'editorial illustration', 'animation concept art', 'modern infographic scene'],
      mid: ['editorial illustration', 'isometric explainer visual', 'animation storyboard scene', 'documentary-style photo'],
    },
  };
  const categoryTypePool = categoryTypePools[category] || categoryTypePools.default;
  const typePool = label === 'thumb' ? categoryTypePool.thumb : categoryTypePool.mid;

  const shotPool = ['wide shot', 'three-quarter view', 'close-up focus', 'over-the-shoulder composition'];
  const attitudePool = ['calm and focused', 'confident and proactive', 'curious and analytical', 'warm and collaborative'];
  const situationPool = {
    '최신IT트렌드': [
      'future technology showroom',
      'AI operations command room',
      'city-scale connected digital infrastructure',
    ],
    'IT정보와분석': [
      'strategy room with dashboards and decision boards',
      'market analysis desk with layered reports',
      'data review session with charts and briefing materials',
    ],
    '홈페이지와App': [
      'product design studio reviewing app states',
      'web and mobile UI planning table with wireframes',
      'design critique session about user flows and edge cases',
    ],
    '자기계발': [
      'personal routine space at sunrise',
      'quiet reflective workspace with notes and progress board',
      'daily habit review moment with subtle motion and energy',
    ],
    '도서리뷰': [
      'reading desk with layered notes and bookmarks',
      'cozy library corner with thoughtful review mood',
      'book discussion setting with reflective atmosphere',
    ],
    '성장과성공': [
      'goal review wall with milestones',
      'achievement planning desk with momentum cues',
      'long-term progress scene with compounding growth metaphor',
    ],
    '개발기획과컨설팅': [
      'planning workshop with roadmap and system diagrams',
      'consulting session around a service blueprint',
      'product strategy review with whiteboard and stakeholder notes',
    ],
    default: [
      'modern professional workspace',
      'thoughtful planning scene',
      'structured problem-solving environment',
    ],
  };

  const propPool = {
    thumb: [
      'clear focal subject with bold silhouette',
      'layered devices, notes, and visual cues',
      'strong depth with foreground-background separation',
      'subtle motion and directional light',
    ],
    mid: [
      'supporting objects that explain the idea',
      'step-by-step visual logic with subtle symbols',
      'spatial layout showing process and relationships',
      'clean scene with informative details',
    ],
  };

  return {
    renderType: _pickVariant(typePool, seed, 0),
    shot: _pickVariant(shotPool, seed, 1),
    attitude: _pickVariant(attitudePool, seed, 2),
    situation: _pickVariant(situationPool[category] || situationPool.default, seed, 3),
    propStyle: _pickVariant(propPool[label] || propPool.thumb, seed, 4),
  };
}

function _buildThumbPrompt(title, postType, category) {
  if (postType === 'lecture') {
    const topic = title.replace(/\[Node\.js \d+강\]\s*/, '').trim();
    return `${STYLE_BASE} Topic: "${topic}". Technology and software development theme. Dark modern UI aesthetic, code editor vibes, subtle Node.js green accent color (#68a063). Abstract digital background.`;
  }
  const visual = _buildVisualVariant(title, postType, category, 'thumb');
  const categoryStyles = {
    '최신IT트렌드': 'Futuristic technology theme, AI and innovation, deep blue, cyan, and silver accents.',
    'IT정보와분석': 'Business intelligence mood, structured dashboards, charts, and analytical visual cues.',
    '홈페이지와App': 'Product design mood, UI/UX artifacts, wireframes, smartphone and laptop interplay, clean white and blue.',
    '자기계발': 'Personal growth mood, disciplined routine, reflective energy, warm orange and neutral tones.',
    '도서리뷰': 'Thoughtful reading mood, books, notes, library textures, warm and calm light.',
    '성장과성공': 'Achievement and momentum mood, strategic progress symbols, gold and navy contrast.',
    '개발기획과컨설팅': 'Planning and facilitation mood, service blueprints, whiteboard systems, collaboration energy.',
  };
  const style = categoryStyles[category] || 'Modern professional blog image with strong concept storytelling.';
  const topic = title.replace(/\[.*?\]\s*/, '').trim();
  return [
    STYLE_BASE,
    `Topic: "${topic}".`,
    `Render type: ${visual.renderType}.`,
    `Scene: ${visual.situation}.`,
    `Mood and attitude: ${visual.attitude}.`,
    `Composition: ${visual.shot}, ${visual.propStyle}.`,
    style,
    'Keep the image visually distinct from generic AI-tech thumbnails; avoid repeating the same pose, same lighting, and same layout every time.',
    'Do not render any readable words on walls, screens, papers, or devices; use diagram shapes or blank interface blocks only.',
  ].join(' ');
}

function _buildMidPrompt(title, postType, category) {
  if (postType === 'lecture') {
    const topic = title.replace(/\[Node\.js \d+강\]\s*/, '').trim();
    return `${STYLE_BASE} Illustrating the concept of "${topic}" in software development. Code snippets, flowchart elements, or system architecture diagram style. Dark theme, developer aesthetic.`;
  }
  const visual = _buildVisualVariant(title, postType, category, 'mid');
  const topic = title.replace(/\[.*?\]\s*/, '').trim();
  return [
    STYLE_BASE,
    `Detailed supporting visual for "${topic}".`,
    `Render type: ${visual.renderType}.`,
    `Situation: ${visual.situation}.`,
    `Character presence and attitude: ${visual.attitude}.`,
    `Composition: ${visual.shot}, ${visual.propStyle}.`,
    `Use category-aware objects and context for "${category}", not just abstract shapes.`,
    'Make this image complementary to the thumbnail, with a different framing, situation, and storytelling emphasis.',
    'No readable text on clipboards, notebooks, calendars, dashboards, or interface panels; replace with icon-like placeholders and empty structure.',
  ].join(' ');
}

async function generatePostImages({ title, postType, category }) {
  if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

  const today = kst.today();
  const safeSlug = (title || '').replace(/[^가-힣a-zA-Z0-9]/g, '_').slice(0, 40);
  const slug = `${today}_${postType}_${safeSlug}`;

  console.log(`[이미지] 생성 시작 (local image runtime) — ${title}`);

  const thumbPrompt = _buildThumbPrompt(title, postType, category);
  const midPrompt = _buildMidPrompt(title, postType, category);

  async function _genAndSave(prompt, label) {
    const filename = `${slug}_${label}.png`;
    const filepath = path.join(IMAGES_DIR, filename);
    const { buffer, source, fallback } = await generateImage(prompt, { aspectRatio: '16:9' });

    fs.writeFileSync(filepath, buffer);
    try {
      if (!fs.existsSync(GDRIVE_DIR)) fs.mkdirSync(GDRIVE_DIR, { recursive: true });
      fs.writeFileSync(path.join(GDRIVE_DIR, filename), buffer);
    } catch (_) {}

    console.log(`  [이미지] ${label}: images/${filename} (${source}${fallback ? ', 폴백' : ''})`);
    return { filename, filepath };
  }

  const [thumb, mid] = await Promise.all([
    _genAndSave(thumbPrompt, 'thumb').catch((e) => { console.warn('[이미지] 대표 실패:', e.message); return null; }),
    _genAndSave(midPrompt, 'mid').catch((e) => { console.warn('[이미지] 중간 실패:', e.message); return null; }),
  ]);

  if (!thumb && !mid) {
    console.warn('[이미지] 대표/중간 이미지 모두 실패 — 이미지 없이 포스팅 진행');
    return null;
  }

  return { thumb, mid };
}

function _escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function _addKoreanTextOverlay(buffer, mainText, watermark = '승호아빠 | cafe_library') {
  const sharp = require('sharp');

  const text = mainText.replace(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic})\s*/u, '').trim();
  const fontSize = text.length <= 10 ? 72 : text.length <= 15 ? 62 : 52;

  const svg = `
<svg width="1024" height="1024" xmlns="http://www.w3.org/2000/svg">
  <rect x="80" y="452" width="864" height="110" rx="16" fill="rgba(255,255,255,0.85)"/>
  <text x="512" y="522" font-size="${fontSize}" font-weight="bold" text-anchor="middle"
        font-family="Apple SD Gothic Neo, Noto Sans KR, NanumGothic, sans-serif"
        fill="#1a1a2e">${_escapeXml(text)}</text>
  <rect x="0" y="980" width="1024" height="44" fill="rgba(0,0,0,0.45)"/>
  <text x="512" y="1008" font-size="22" text-anchor="middle"
        font-family="Apple SD Gothic Neo, Noto Sans KR, NanumGothic, sans-serif"
        fill="rgba(255,255,255,0.90)">${_escapeXml(watermark)}</text>
</svg>`.trim();

  return sharp(buffer)
    .resize(1024, 1024)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();
}

async function generateInstaCard(summary, cardIndex, outputPath) {
  const emojiMatch = summary.match(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic})\s*/u);
  const emoji = emojiMatch ? emojiMatch[1] : '';

  const EMOJI_HINT = {
    '🔥': 'warm fiery energy, orange-red accent tones',
    '💡': 'bright idea, soft yellow glow accent',
    '🚀': 'futuristic space launch, deep blue and star motifs',
    '📊': 'data visualization, chart-inspired geometric shapes',
    '🏆': 'achievement, gold accent tones',
    '💻': 'dark code editor aesthetic, terminal green accent',
    '🌐': 'global network, connected nodes, teal tones',
    '⚡': 'electric energy, yellow-white accent',
    '🛡️': 'security shield, deep navy and silver',
    '🤖': 'AI robot, metallic blue-gray tones',
  };
  const moodHint = emoji ? (EMOJI_HINT[emoji] || 'modern tech vibe') : 'clean minimal tech';

  const prompt = [
    'Minimalist Instagram card background, 1024x1024, square format.',
    `Style: ${moodHint}.`,
    'Clean modern design, soft gradient background.',
    'Leave center area clean and empty for text overlay.',
    'No text, no letters, no characters anywhere in the image.',
    `Card ${cardIndex} of series.`,
  ].join(' ');

  try {
    const { buffer, source, fallback } = await generateImage(prompt, { aspectRatio: '1:1' });
    const finalBuffer = await _addKoreanTextOverlay(buffer, summary);
    _saveBuffer(finalBuffer, outputPath);
    console.log(`  [img-gen] 인스타 카드 ${cardIndex} 저장 (${source}${fallback ? ', 폴백' : ''})`);
    return outputPath;
  } catch (e) {
    console.warn(`  [img-gen] 인스타 카드 ${cardIndex} 실패: ${e.message}`);
    return null;
  }
}

module.exports = {
  generateImage,
  generatePostImages,
  generateInstaCard,
  _buildThumbPrompt,
  _buildMidPrompt,
  IMAGES_DIR,
};
