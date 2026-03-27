'use strict';
const kst = require('../../../packages/core/lib/kst');

/**
 * img-gen.js — 블로그팀 이미지 생성
 *
 * 전략: OpenAI gpt-image-1 Medium 메인(유료) → Nano Banana 폴백(무료)
 *
 * 함수:
 *   generateImage(prompt, opts)          — 단건 생성 (폴백 체인)
 *   generateWithOpenAI(prompt, opts)     — OpenAI gpt-image-1 medium 직접 호출 (메인)
 *   generateWithNanoBanana(prompt, opts) — Gemini 직접 호출 (폴백)
 *   generatePostImages({ title, postType, category }) — 블로그 포스팅 이미지 2장
 *   generateInstaCard(summary, cardIndex, outputPath) — 인스타 카드 1장
 *
 * 비용:
 *   OpenAI medium: ~$0.04/장 (1024×1024, 메인)
 *   Nano Banana: 무료 500장/일 (RPM 15, RPD 1,000, 폴백 시에만)
 */

const fs   = require('fs');
const path = require('path');
const { getGeminiImageKey, getOpenAIKey } = require('../../../packages/core/lib/llm-keys');

const OUTPUT_DIR  = path.join(__dirname, '..', 'output');
const IMAGES_DIR  = path.join(OUTPUT_DIR, 'images');
const GDRIVE_DIR  = '/Users/alexlee/Library/CloudStorage/GoogleDrive-***REMOVED***/내 드라이브/010_BlogPost/images';

const NANO_BANANA_MODEL = 'gemini-2.5-flash-image';

// 비율 → OpenAI 사이즈 매핑
const OPENAI_SIZE_MAP = {
  '1:1':  '1024x1024',
  '16:9': '1536x1024',
  '9:16': '1024x1536',
  '3:4':  '1024x1536',
  '4:3':  '1536x1024',
};

// ── 1. Nano Banana (메인 — 무료) ────────────────────────────────

/**
 * Nano Banana로 이미지 생성 (Buffer 반환)
 * @param {string} prompt
 * @param {{ aspectRatio?: string }} [opts]
 * @returns {Promise<{ buffer: Buffer, source: 'nano_banana' }>}
 */
async function generateWithNanoBanana(prompt, opts = {}) {
  const apiKey = getGeminiImageKey();
  if (!apiKey) throw new Error('GEMINI_IMAGE_KEY / GEMINI_API_KEY 없음');

  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const { aspectRatio = '1:1' } = opts;

  const genai = new GoogleGenerativeAI(apiKey);
  const model = genai.getGenerativeModel({ model: NANO_BANANA_MODEL });

  // 비율은 프롬프트로 전달 (SDK에서 imageGenerationConfig 미지원)
  const aspectHint = aspectRatio !== '1:1' ? ` Aspect ratio ${aspectRatio}.` : '';
  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt + aspectHint }] }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
    },
  });

  const parts   = result.response?.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));

  if (!imgPart?.inlineData?.data) throw new Error('Nano Banana 이미지 응답 없음');

  return { buffer: Buffer.from(imgPart.inlineData.data, 'base64'), source: 'nano_banana' };
}

// ── 2. OpenAI gpt-image-1 Medium (폴백 — 유료) ──────────────────

/**
 * OpenAI gpt-image-1 이미지 생성
 * quality: OPENAI_IMAGE_QUALITY 환경변수 (high|medium|low, 기본 medium)
 * @param {string} prompt
 * @param {{ aspectRatio?: string }} [opts]
 * @returns {Promise<{ buffer: Buffer, source: 'openai_high' }>}
 */
async function generateWithOpenAI(prompt, opts = {}) {
  const apiKey = getOpenAIKey();
  if (!apiKey) throw new Error('OPENAI_API_KEY 없음');

  const OpenAI = require('openai');
  const { aspectRatio = '1:1' } = opts;
  const size    = OPENAI_SIZE_MAP[aspectRatio] || '1024x1024';
  const quality = process.env.OPENAI_IMAGE_QUALITY || 'medium';

  const openai    = new OpenAI({ apiKey });
  const response  = await openai.images.generate({
    model:   'gpt-image-1',
    prompt,
    n:       1,
    size,
    quality,
  });

  const imageData = response.data?.[0];
  let buffer;

  if (imageData?.b64_json) {
    buffer = Buffer.from(imageData.b64_json, 'base64');
  } else if (imageData?.url) {
    const https = require('https');
    buffer = await new Promise((resolve, reject) => {
      https.get(imageData.url, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    });
  } else {
    throw new Error('OpenAI 이미지 응답 없음');
  }

  return { buffer, source: 'openai_medium' };
}

// ── 3. 메인 체인 (OpenAI Medium → Nano Banana 폴백) ─────────────

/**
 * 이미지 생성 — OpenAI medium 메인, 실패 시 Nano Banana 폴백
 * @param {string} prompt
 * @param {{ aspectRatio?: string, outputPath?: string }} [opts]
 * @returns {Promise<{ buffer: Buffer, source: string, fallback: boolean }>}
 */
async function generateImage(prompt, opts = {}) {
  const { outputPath, ...genOpts } = opts;

  // OpenAI medium 시도 (메인)
  try {
    const result = await generateWithOpenAI(prompt, genOpts);
    if (outputPath) _saveBuffer(result.buffer, outputPath);
    return { ...result, fallback: false };
  } catch (e) {
    console.warn(`  ⚠️ [img-gen] OpenAI 실패 → Nano Banana 폴백: ${e.message}`);
  }

  // Nano Banana 폴백 (무료)
  const result = await generateWithNanoBanana(prompt, genOpts);
  if (outputPath) _saveBuffer(result.buffer, outputPath);
  return { ...result, fallback: true };
}

function _saveBuffer(buffer, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buffer);
}

// ── 4. 블로그 포스팅 이미지 2장 (대표 + 중간) ─────────────────

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
    '최신IT트렌드':       'Futuristic technology theme, AI and innovation, deep blue, cyan, and silver accents.',
    'IT정보와분석':       'Business intelligence mood, structured dashboards, charts, and analytical visual cues.',
    '홈페이지와App':      'Product design mood, UI/UX artifacts, wireframes, smartphone and laptop interplay, clean white and blue.',
    '자기계발':           'Personal growth mood, disciplined routine, reflective energy, warm orange and neutral tones.',
    '도서리뷰':           'Thoughtful reading mood, books, notes, library textures, warm and calm light.',
    '성장과성공':         'Achievement and momentum mood, strategic progress symbols, gold and navy contrast.',
    '개발기획과컨설팅':   'Planning and facilitation mood, service blueprints, whiteboard systems, collaboration energy.',
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

/**
 * 블로그 포스팅 이미지 생성 (대표 thumb + 중간 mid)
 * @param {{ title: string, postType: string, category: string }} postMeta
 * @returns {Promise<{ thumb: {filename, filepath}, mid: {filename, filepath} } | null>}
 */
async function generatePostImages({ title, postType, category }) {
  if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

  const today    = kst.today();
  const safeSlug = (title || '').replace(/[^가-힣a-zA-Z0-9]/g, '_').slice(0, 40);
  const slug     = `${today}_${postType}_${safeSlug}`;

  console.log(`[이미지] 생성 시작 (OpenAI Medium 메인 → Nano Banana 폴백) — ${title}`);

  const thumbPrompt = _buildThumbPrompt(title, postType, category);
  const midPrompt   = _buildMidPrompt(title, postType, category);

  async function _genAndSave(prompt, label) {
    const filename = `${slug}_${label}.png`;
    const filepath = path.join(IMAGES_DIR, filename);
    const { buffer, source, fallback } = await generateImage(prompt, { aspectRatio: '16:9' });

    fs.writeFileSync(filepath, buffer);
    // 구글드라이브 복사
    try {
      if (!fs.existsSync(GDRIVE_DIR)) fs.mkdirSync(GDRIVE_DIR, { recursive: true });
      fs.writeFileSync(path.join(GDRIVE_DIR, filename), buffer);
    } catch (_) {}

    console.log(`  [이미지] ${label}: images/${filename} (${source}${fallback ? ', 폴백' : ''})`);
    return { filename, filepath };
  }

  const [thumb, mid] = await Promise.all([
    _genAndSave(thumbPrompt, 'thumb').catch(e => { console.warn('[이미지] 대표 실패:', e.message); return null; }),
    _genAndSave(midPrompt, 'mid').catch(e => { console.warn('[이미지] 중간 실패:', e.message); return null; }),
  ]);

  return { thumb, mid };
}

// ── 5. 한글 텍스트 오버레이 (sharp + SVG) ──────────────────────

function _escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 이미지 버퍼에 한글 텍스트 오버레이 합성
 * @param {Buffer} buffer — 원본 이미지 버퍼
 * @param {string} mainText — 중앙 한글 텍스트 (이모지 포함)
 * @param {string} [watermark] — 하단 워터마크
 * @returns {Promise<Buffer>}
 */
async function _addKoreanTextOverlay(buffer, mainText, watermark = '승호아빠 | cafe_library') {
  const sharp = require('sharp');

  // 이모지 제거 — 텍스트만 오버레이 (이모지는 AI 배경 프롬프트 힌트로만 사용)
  const text     = mainText.replace(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic})\s*/u, '').trim();
  const fontSize = text.length <= 10 ? 72 : text.length <= 15 ? 62 : 52;

  const svg = `
<svg width="1024" height="1024" xmlns="http://www.w3.org/2000/svg">
  <!-- 중앙 텍스트 배경 -->
  <rect x="80" y="452" width="864" height="110" rx="16" fill="rgba(255,255,255,0.85)"/>
  <!-- 한글 본문 -->
  <text x="512" y="522" font-size="${fontSize}" font-weight="bold" text-anchor="middle"
        font-family="Apple SD Gothic Neo, Noto Sans KR, NanumGothic, sans-serif"
        fill="#1a1a2e">${_escapeXml(text)}</text>
  <!-- 워터마크 배경 -->
  <rect x="0" y="980" width="1024" height="44" fill="rgba(0,0,0,0.45)"/>
  <!-- 워터마크 텍스트 -->
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

// ── 6. 인스타 카드 이미지 생성 (social.js용) ────────────────────

/**
 * 인스타 카드 이미지 생성 (1:1 정사각형)
 * - AI: 텍스트 없는 배경 디자인 생성
 * - sharp: 한글 요약 텍스트 + 워터마크 직접 합성
 * @param {string} summary — 15~20자 요약 텍스트 (이모지 포함)
 * @param {number} cardIndex — 카드 번호 (1, 2, 3)
 * @param {string} outputPath — 저장할 전체 파일 경로
 * @returns {Promise<string | null>} — 저장 경로 또는 null
 */
async function generateInstaCard(summary, cardIndex, outputPath) {
  // 이모지 추출 → AI 배경 프롬프트에 분위기 힌트로만 사용
  const emojiMatch = summary.match(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic})\s*/u);
  const emoji      = emojiMatch ? emojiMatch[1] : '';

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
  generateWithNanoBanana,
  generateWithOpenAI,
  generatePostImages,
  generateInstaCard,
  _buildThumbPrompt,
  _buildMidPrompt,
  IMAGES_DIR,
};
