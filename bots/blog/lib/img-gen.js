'use strict';

/**
 * img-gen.js — 블로그팀 이미지 생성
 *
 * 전략: Nano Banana 메인(무료) → OpenAI gpt-image-1 High 폴백(유료)
 *
 * 함수:
 *   generateImage(prompt, opts)          — 단건 생성 (폴백 체인)
 *   generateWithNanoBanana(prompt, opts) — Gemini 직접 호출
 *   generateWithOpenAI(prompt, opts)     — OpenAI gpt-image-1 high 직접 호출
 *   generatePostImages({ title, postType, category }) — 블로그 포스팅 이미지 2장
 *   generateInstaCard(summary, cardIndex, outputPath) — 인스타 카드 1장
 *
 * 비용:
 *   Nano Banana: 무료 500장/일 (RPM 15, RPD 1,000)
 *   OpenAI high: ~$0.07/장 (1024×1024, 폴백 시에만)
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

// ── 2. OpenAI gpt-image-1 High (폴백 — 유료) ───────────────────

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

  return { buffer, source: 'openai_high' };
}

// ── 3. 폴백 체인 (Nano Banana → OpenAI High) ────────────────────

/**
 * 이미지 생성 — Nano Banana 시도, 실패 시 OpenAI High 폴백
 * @param {string} prompt
 * @param {{ aspectRatio?: string, outputPath?: string }} [opts]
 * @returns {Promise<{ buffer: Buffer, source: string, fallback: boolean }>}
 */
async function generateImage(prompt, opts = {}) {
  const { outputPath, ...genOpts } = opts;

  // Nano Banana 시도
  try {
    const result = await generateWithNanoBanana(prompt, genOpts);
    if (outputPath) _saveBuffer(result.buffer, outputPath);
    return { ...result, fallback: false };
  } catch (e) {
    console.warn(`  ⚠️ [img-gen] Nano Banana 실패 → OpenAI 폴백: ${e.message}`);
  }

  // OpenAI High 폴백
  const result = await generateWithOpenAI(prompt, genOpts);
  if (outputPath) _saveBuffer(result.buffer, outputPath);
  return { ...result, fallback: true };
}

function _saveBuffer(buffer, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buffer);
}

// ── 4. 블로그 포스팅 이미지 2장 (대표 + 중간) ─────────────────

const STYLE_BASE = 'Clean, modern, professional blog thumbnail. No text overlay. Soft lighting, high resolution.';

function _buildThumbPrompt(title, postType, category) {
  if (postType === 'lecture') {
    const topic = title.replace(/\[Node\.js \d+강\]\s*/, '').trim();
    return `${STYLE_BASE} Topic: "${topic}". Technology and software development theme. Dark modern UI aesthetic, code editor vibes, subtle Node.js green accent color (#68a063). Abstract digital background.`;
  }
  const categoryStyles = {
    '최신IT트렌드':       'Futuristic technology theme, AI and innovation, glowing neural network, deep blue and purple gradient.',
    'IT정보와분석':       'Data visualization, charts and graphs, business intelligence, clean infographic style, blue tones.',
    '홈페이지와App':      'Modern web and mobile app design, UI/UX, smartphone and laptop, clean white and blue.',
    '자기계발':           'Growth mindset, sunrise, open book, person climbing stairs, warm orange and yellow tones.',
    '도서리뷰':           'Open book with soft light, cozy reading atmosphere, warm tones, library background.',
    '성장과성공':         'Success concept, upward arrow, achievement trophy, motivated person, gold and navy tones.',
    '개발기획과컨설팅':   'Project planning, whiteboard with diagrams, team collaboration, professional office setting.',
  };
  const style = categoryStyles[category] || 'Modern professional blog image, clean minimal design.';
  const topic = title.replace(/\[.*?\]\s*/, '').trim();
  return `${STYLE_BASE} Topic: "${topic}". ${style}`;
}

function _buildMidPrompt(title, postType, category) {
  if (postType === 'lecture') {
    const topic = title.replace(/\[Node\.js \d+강\]\s*/, '').trim();
    return `${STYLE_BASE} Illustrating the concept of "${topic}" in software development. Code snippets, flowchart elements, or system architecture diagram style. Dark theme, developer aesthetic.`;
  }
  const topic = title.replace(/\[.*?\]\s*/, '').trim();
  return `${STYLE_BASE} Detailed illustration supporting the blog post about "${topic}". Engaging, informative visual with subtle icons or abstract shapes related to "${category}".`;
}

/**
 * 블로그 포스팅 이미지 생성 (대표 thumb + 중간 mid)
 * @param {{ title: string, postType: string, category: string }} postMeta
 * @returns {Promise<{ thumb: {filename, filepath}, mid: {filename, filepath} } | null>}
 */
async function generatePostImages({ title, postType, category }) {
  if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

  const today    = new Date().toISOString().slice(0, 10);
  const safeSlug = (title || '').replace(/[^가-힣a-zA-Z0-9]/g, '_').slice(0, 40);
  const slug     = `${today}_${postType}_${safeSlug}`;

  console.log(`[이미지] 생성 시작 (Nano Banana → OpenAI High 폴백) — ${title}`);

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
  IMAGES_DIR,
};
