'use strict';

/**
 * bots/blog/lib/social.js — 소셜(SOCIAL) 봇
 *
 * 역할:
 *   N40. 포스팅 본문 → 섹션별 15~20자 요약 (Gemini Flash, 무료)
 *   N41. 요약 텍스트 → 1024×1024 인스타 카드 (gpt-image-1, medium)
 *   N42. 캡션 + 해시태그 자동 생성 (Gemini Flash, 무료)
 *
 * 비용: Gemini Flash(N40/N42) 무료, Imagen 4 Fast(N41) 유료
 */

const { callGemini } = require('../../../packages/core/lib/chunked-llm');
const { getOpenAIKey } = require('../../../packages/core/lib/llm-keys');
const OpenAI = require('openai');
const fs   = require('fs');
const path = require('path');

// ── N40: 문단별 요약 (insta-summarize) ──────────────────────────────

const SUMMARIZE_SYSTEM = `
당신은 인스타그램 콘텐츠 전문가입니다.
블로그 포스팅의 각 주요 섹션을 15~20자 이내의 임팩트 있는 한줄로 요약합니다.

규칙:
- 각 요약은 15~20자 이내 (한국어 기준)
- 이모지 1개 포함 (시작 부분)
- 호기심을 유발하는 문장
- 전문 용어는 쉽게 풀어서

응답: JSON 배열만 출력 (다른 텍스트 없이)
[
  { "section": "섹션명", "summary": "🔥 Redis가 빠른 이유", "charCount": 12 },
  ...
]
`.trim();

/**
 * 포스팅에서 인스타용 섹션 요약 생성
 * @param {string} content — 포스팅 전문
 * @param {number} count — 요약 개수 (기본 3)
 * @returns {Array<{section, summary, charCount}>}
 */
async function summarizeForInsta(content, count = 3) {
  const userPrompt = `
다음 블로그 포스팅에서 가장 핵심적인 섹션 ${count}개를 선정하고,
각 섹션을 15~20자 이내 인스타 카드용 한줄 요약으로 변환하세요.

[포스팅 본문]
${content.slice(0, 6000)}
`.trim();

  const result = await callGemini(SUMMARIZE_SYSTEM, userPrompt, 1024);

  try {
    const match = result.text.match(/\[[\s\S]*?\]/);
    return match ? JSON.parse(match[0]).slice(0, count) : [];
  } catch {
    console.warn('[소셜] 요약 파싱 실패');
    return [];
  }
}

// ── N41: 인스타 카드 이미지 생성 (insta-card) ───────────────────────

/**
 * 요약 텍스트 → 1024×1024 인스타 카드 (gpt-image-1)
 * @param {string} summary — 15~20자 요약 텍스트
 * @param {number} cardIndex — 카드 번호 (1, 2, 3)
 * @param {string} outputDir — 저장 디렉토리
 * @returns {string|null} — 저장된 파일 경로
 */
async function generateInstaCard(summary, cardIndex, outputDir) {
  const apiKey = getOpenAIKey();
  if (!apiKey) {
    console.warn('[소셜] OPENAI_API_KEY 없음 — 인스타 카드 생성 불가');
    return null;
  }

  const prompt = [
    'Minimalist Instagram card, 1024x1024, square format.',
    'Clean modern design, white/light background with subtle tech-themed gradient.',
    `Large bold Korean text centered: "${summary}"`,
    'Small bottom watermark: "승호아빠 | cafe_library".',
    'Professional IT blog aesthetic, high readability, no extra decoration.',
  ].join(' ');

  try {
    const openai = new OpenAI({ apiKey });
    const res = await openai.images.generate({
      model:   'gpt-image-1',
      prompt,
      n:       1,
      size:    '1024x1024',
      quality: 'medium',
    });

    const imageData = res.data?.[0]?.b64_json;
    if (!imageData) {
      console.warn(`[소셜] 카드 ${cardIndex}: 이미지 데이터 없음`);
      return null;
    }

    const dir = path.join(outputDir, 'insta');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `insta_card_${cardIndex}.png`);
    fs.writeFileSync(filePath, Buffer.from(imageData, 'base64'));
    console.log(`  [소셜] 카드 ${cardIndex} 저장: ${filePath}`);
    return filePath;
  } catch (e) {
    console.warn(`[소셜] 카드 ${cardIndex} 생성 실패: ${e.message}`);
    return null;
  }
}

// ── N42: 캡션 + 해시태그 생성 (insta-hashtag) ───────────────────────

const CAPTION_SYSTEM = `
당신은 인스타그램 마케팅 전문가입니다.
블로그 포스팅을 인스타그램 캡션과 해시태그로 변환합니다.

규칙:
- 캡션: 3줄 이내, 핵심 가치 전달 + CTA
- 해시태그: 15~25개, 한국어+영어 혼합
  - 필수: #개발자일상 #IT블로그 #승호아빠 #cafe_library
  - 주제별: 기술 키워드 해시태그
  - 트렌드: 인기 IT 해시태그

응답: JSON만 출력 (다른 텍스트 없이)
{
  "caption": "캡션 텍스트 (3줄)",
  "hashtags": ["#태그1", "#태그2"],
  "cta": "블로그에서 더 자세히! 👉 프로필 링크"
}
`.trim();

const REQUIRED_HASHTAGS = ['#개발자일상', '#IT블로그', '#승호아빠', '#cafe_library'];

/**
 * 인스타 캡션 + 해시태그 생성
 * @param {string} content — 포스팅 전문
 * @param {string} title — 포스팅 제목
 * @param {string} category — 카테고리
 * @returns {{ caption, hashtags, cta, fullText }}
 */
async function generateInstaCaption(content, title, category) {
  const userPrompt = `
다음 블로그 포스팅의 인스타그램 캡션과 해시태그를 생성하세요.

제목: ${title}
카테고리: ${category}

[포스팅 요약]
${content.slice(0, 3000)}
`.trim();

  const result = await callGemini(CAPTION_SYSTEM, userPrompt, 1024);

  try {
    const match  = result.text.match(/\{[\s\S]*?\}/);
    const parsed = match ? JSON.parse(match[0]) : null;
    if (!parsed) throw new Error('파싱 실패');

    const hashtags = parsed.hashtags || [];
    for (const tag of REQUIRED_HASHTAGS) {
      if (!hashtags.includes(tag)) hashtags.push(tag);
    }
    const cta      = parsed.cta || '블로그에서 더 자세히! 👉 프로필 링크';
    const fullText = `${parsed.caption}\n\n${cta}\n\n${hashtags.join(' ')}`;

    return { caption: parsed.caption, hashtags, cta, fullText };
  } catch {
    console.warn('[소셜] 캡션 파싱 실패 — 기본 템플릿 사용');
    const hashtags = [...REQUIRED_HASHTAGS, '#nodejs', '#개발공부', '#백엔드개발'];
    return {
      caption:  `📝 ${title}\n오늘의 IT 인사이트를 정리했어요!`,
      hashtags,
      cta:      '블로그에서 더 자세히! 👉 프로필 링크',
      fullText: `📝 ${title}\n오늘의 IT 인사이트를 정리했어요!\n\n블로그에서 더 자세히! 👉 프로필 링크\n\n${hashtags.join(' ')}`,
    };
  }
}

// ── 통합: 블로그 → 인스타 콘텐츠 풀세트 생성 ───────────────────────

/**
 * 블로그 포스팅 → 인스타 콘텐츠 풀세트
 * @param {string} content — 포스팅 본문
 * @param {string} title — 포스팅 제목
 * @param {string} category — 카테고리
 * @param {string} outputDir — 이미지 저장 디렉토리
 * @param {number} [cardCount] — 카드 수 (기본 3)
 * @returns {{ summaries, cards, caption, hashtags, cta, fullText, createdAt }}
 */
async function createInstaContent(content, title, category, outputDir, cardCount = 3) {
  console.log(`[소셜] 인스타 콘텐츠 생성 시작 (카드 ${cardCount}장)`);

  // N40 문단 요약
  const summaries = await summarizeForInsta(content, cardCount);
  console.log(`  요약 ${summaries.length}개 생성`);

  // N41 카드 이미지 병렬 생성
  const cardResults = await Promise.allSettled(
    summaries.map((s, i) => generateInstaCard(s.summary, i + 1, outputDir))
  );
  const cards = cardResults
    .map((r, i) => ({
      index:     i + 1,
      summary:   summaries[i]?.summary || '',
      imagePath: r.status === 'fulfilled' ? r.value : null,
    }))
    .filter(c => c.imagePath);
  console.log(`  카드 ${cards.length}/${summaries.length} 생성 성공`);

  // N42 캡션 + 해시태그
  const { caption, hashtags, cta, fullText } = await generateInstaCaption(content, title, category);
  console.log(`  캡션 완료 (해시태그 ${hashtags.length}개)`);

  // 메타데이터 저장
  const metaPath = path.join(outputDir, 'insta', 'insta-meta.json');
  fs.mkdirSync(path.dirname(metaPath), { recursive: true });
  const meta = {
    title, category, summaries, cards,
    caption, hashtags, cta, fullText,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  console.log(`[소셜] 완성: 카드 ${cards.length}장 + 해시태그 ${hashtags.length}개`);
  return meta;
}

module.exports = {
  summarizeForInsta,
  generateInstaCard,
  generateInstaCaption,
  createInstaContent,
};
