'use strict';
const kst = require('../../../packages/core/lib/kst');

/**
 * img-gen.js — 블로그팀 이미지 생성
 *
 * 전략: Draw Things 중심의 단일 클릭 유도형 썸네일
 */

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const { selectRuntime } = require('../../../packages/core/lib/runtime-selector');
const { generateWithComfyUI } = require('../../../packages/core/lib/local-image-client');

const OUTPUT_DIR = path.join(env.PROJECT_ROOT, 'bots/blog/output');
const IMAGES_DIR = path.join(OUTPUT_DIR, 'images');
const GDRIVE_DIR = process.env.GDRIVE_BLOG_IMAGES || '/tmp/blog-images';

async function generateImage(prompt, opts = {}) {
  const { outputPath, ...genOpts } = opts;
  const runtimeProfile = await selectRuntime('blog', 'image-local');
  const result = await generateWithComfyUI(prompt, {
    provider: process.env.BLOG_IMAGE_PROVIDER || 'drawthings',
    baseUrl: process.env.BLOG_IMAGE_BASE_URL || 'http://127.0.0.1:7860',
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
  'Professional blog thumbnail, 16:9 aspect ratio, ultra high quality.',
  'No text overlay.',
  'Absolutely no readable text, letters, words, numbers, UI labels, logos, signage, captions, checklist text, whiteboard text, or typography anywhere.',
  'Image should feel premium, distinctive, and curiosity-inducing.',
].join(' ');

const CLICK_BAIT_STYLES = [
  'Dramatic cinematic lighting with strong contrast, mysterious mood, single bold focal point.',
  'Vibrant neon accents against a dark background, futuristic tech aesthetic, eye-catching glow.',
  'Breathtaking sense of scale with a surprising perspective and visual wonder.',
  'Unexpected close-up focus with rich texture detail and strong subject isolation.',
  'Bold editorial magazine-cover composition with striking color blocks and premium feel.',
  'Surreal dreamlike scene with impossible architecture or floating objects, high curiosity.',
  'Golden-hour warm lighting with cozy aspiration mood and polished lifestyle energy.',
  'Minimalist composition with one powerful subject and clean negative space.',
];

const COLOR_HINTS = {
  '최신IT트렌드': 'deep blue, cyan, electric purple accents',
  'IT정보와분석': 'dark navy, gold analytical glow',
  '홈페이지와App': 'clean white, soft blue, modern UI atmosphere',
  '자기계발': 'warm sunrise orange, focused motivation',
  '도서리뷰': 'warm amber, cozy bookish brown tones',
  '성장과성공': 'bold gold, confident navy contrast',
  '개발기획과컨설팅': 'professional gray, strategic blue accents',
};

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

function _buildVisualVariant(title, postType, category) {
  const seed = _hashSeed(`${postType}:${category}:${title}`);
  const categoryTypePools = {
    '최신IT트렌드': {
      thumb: ['cinematic photo', 'animation concept art', 'modern infographic scene'],
    },
    'IT정보와분석': {
      thumb: ['modern infographic scene', 'editorial illustration', 'documentary-style photo'],
    },
    '홈페이지와App': {
      thumb: ['editorial illustration', 'cinematic photo', 'modern infographic scene'],
    },
    '자기계발': {
      thumb: ['cinematic photo', 'animation concept art', 'editorial illustration'],
    },
    '도서리뷰': {
      thumb: ['documentary-style photo', 'editorial illustration', 'animation concept art'],
    },
    '성장과성공': {
      thumb: ['cinematic photo', 'modern infographic scene', 'editorial illustration'],
    },
    '개발기획과컨설팅': {
      thumb: ['modern infographic scene', 'editorial illustration', 'cinematic photo'],
    },
    default: {
      thumb: ['cinematic photo', 'editorial illustration', 'animation concept art', 'modern infographic scene'],
    },
  };
  const categoryTypePool = categoryTypePools[category] || categoryTypePools.default;
  const typePool = categoryTypePool.thumb;

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

  const propPool = [
    'clear focal subject with bold silhouette',
    'layered devices, notes, and visual cues',
    'strong depth with foreground-background separation',
    'subtle motion and directional light',
  ];

  return {
    renderType: _pickVariant(typePool, seed, 0),
    shot: _pickVariant(shotPool, seed, 1),
    attitude: _pickVariant(attitudePool, seed, 2),
    situation: _pickVariant(situationPool[category] || situationPool.default, seed, 3),
    propStyle: _pickVariant(propPool, seed, 4),
  };
}

function _buildThumbPrompt(title, postType, category) {
  if (postType === 'lecture') {
    const topic = title.replace(/\[Node\.js \d+강\]\s*/, '').trim();
    const style = CLICK_BAIT_STYLES[_hashSeed(`${title}:${category}`) % CLICK_BAIT_STYLES.length];
    return [
      STYLE_BASE,
      `Topic hint: "${topic}". Dark modern UI, code editor vibes, Node.js green accent color (#68a063).`,
      style,
      'Strong focal subject, clean composition, premium tutorial cover feel.',
    ].join(' ');
  }
  const visual = _buildVisualVariant(title, postType, category);
  const clickStyle = CLICK_BAIT_STYLES[_hashSeed(`${title}:${category}`) % CLICK_BAIT_STYLES.length];
  const topic = title.replace(/\[.*?\]\s*/, '').trim();
  return [
    STYLE_BASE,
    `Topic hint: "${topic}".`,
    clickStyle,
    `Render type: ${visual.renderType}.`,
    `Scene: ${visual.situation}.`,
    `Mood and attitude: ${visual.attitude}.`,
    `Composition: ${visual.shot}, ${visual.propStyle}.`,
    `Color mood: ${COLOR_HINTS[category] || 'modern tech color palette'}.`,
    'The image should make people want to click through curiosity, surprise, beauty, or tension.',
    'Avoid generic stock-photo feel. Be bold, distinctive, and emotionally legible at a glance.',
    'No readable words on walls, screens, papers, boards, or devices.',
  ].join(' ');
}

async function generatePostImages({ title, postType, category }) {
  if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

  const today = kst.today();
  const safeSlug = (title || '').replace(/[^가-힣a-zA-Z0-9]/g, '_').slice(0, 40);
  const slug = `${today}_${postType}_${safeSlug}`;

  console.log(`[이미지] 썸네일 생성 시작 (Draw Things/local runtime) — ${title}`);

  const thumbPrompt = _buildThumbPrompt(title, postType, category);
  const filename = `${slug}_thumb.png`;
  const filepath = path.join(IMAGES_DIR, filename);

  try {
    const { buffer, source, fallback } = await generateImage(thumbPrompt, { aspectRatio: '16:9' });
    fs.writeFileSync(filepath, buffer);
    try {
      if (!fs.existsSync(GDRIVE_DIR)) fs.mkdirSync(GDRIVE_DIR, { recursive: true });
      fs.writeFileSync(path.join(GDRIVE_DIR, filename), buffer);
    } catch (_) {}

    console.log(`  [이미지] thumb: images/${filename} (${source}${fallback ? ', 폴백' : ''})`);
    return { thumb: { filename, filepath } };
  } catch (e) {
    console.warn('[이미지] 썸네일 실패:', e.message);
    return null;
  }
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
  IMAGES_DIR,
};
