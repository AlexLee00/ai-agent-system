// @ts-nocheck
'use strict';
const kst = require('../../../packages/core/lib/kst');
const { selectLLMChain } = require('../../../packages/core/lib/llm-model-selector');
const { getBlogLLMSelectorOverrides } = require('./runtime-config');
const env = require('../../../packages/core/lib/env');

/**
 * bots/blog/lib/star.js — 스타(STAR) 봇
 *
 * 역할:
 *   N40. 포스팅 본문 → 섹션별 15~20자 요약 (gpt-4o-mini, OpenAI)
 *   N41. 썸네일 기반 1080x1920 숏폼 렌더
 *   N42. 캡션 + 해시태그 자동 생성 (gpt-4o-mini, OpenAI)
 *
 * 비용: gpt-4o-mini(N40/N42) 유료(저렴), ffmpeg 렌더(N41) 로컬
 * 산출물: insta_content.html (Safari 복붙) + reel MP4
 */

const { callWithFallback } = require('../../../packages/core/lib/llm-fallback');
const { buildShortformPlan } = require('./shortform-planner');
const { renderShortformReel } = require('./shortform-renderer');
const fs = require('fs');
const path = require('path');

const BLOG_ROOT = path.join(env.PROJECT_ROOT, 'bots/blog');
const INSTA_DIR = path.join(BLOG_ROOT, 'output', 'images', 'insta');
const GDRIVE_DIR = process.env.GDRIVE_BLOG_INSTA || '/tmp/blog-insta';
const IMAGE_DIR = path.join(BLOG_ROOT, 'output/images');

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

async function summarizeForInsta(content, count = 3) {
  const selectorOverrides = getBlogLLMSelectorOverrides();
  const userPrompt = `
다음 블로그 포스팅에서 가장 핵심적인 섹션 ${count}개를 선정하고,
각 섹션을 15~20자 이내 인스타 카드용 한줄 요약으로 변환하세요.

[포스팅 본문]
${content.slice(0, 6000)}
`.trim();

  const result = await callWithFallback({
    chain: selectLLMChain('blog.star.summarize', {
      policyOverride: selectorOverrides['blog.star.summarize'],
    }),
    systemPrompt: SUMMARIZE_SYSTEM,
    userPrompt,
    logMeta: { team: 'blog', purpose: 'social', bot: 'social', requestType: 'insta_summarize' },
  });

  try {
    const match = result.text.match(/\[[\s\S]*?\]/);
    return match ? JSON.parse(match[0]).slice(0, count) : [];
  } catch {
    console.warn('[소셜] 요약 파싱 실패');
    return [];
  }
}

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

async function generateInstaCaption(content, title, category) {
  const selectorOverrides = getBlogLLMSelectorOverrides();
  const userPrompt = `
다음 블로그 포스팅의 인스타그램 캡션과 해시태그를 생성하세요.

제목: ${title}
카테고리: ${category}

[포스팅 요약]
${content.slice(0, 3000)}
`.trim();

  const result = await callWithFallback({
    chain: selectLLMChain('blog.star.caption', {
      policyOverride: selectorOverrides['blog.star.caption'],
    }),
    systemPrompt: CAPTION_SYSTEM,
    userPrompt,
    logMeta: { team: 'blog', purpose: 'social', bot: 'social', requestType: 'insta_caption' },
  });

  try {
    const match = result.text.match(/\{[\s\S]*?\}/);
    const parsed = match ? JSON.parse(match[0]) : null;
    if (!parsed) throw new Error('파싱 실패');

    const hashtags = parsed.hashtags || [];
    for (const tag of REQUIRED_HASHTAGS) {
      if (!hashtags.includes(tag)) hashtags.push(tag);
    }
    const cta = parsed.cta || '블로그에서 더 자세히! 👉 프로필 링크';
    const fullText = `${parsed.caption}\n\n${cta}\n\n${hashtags.join(' ')}`;

    return { caption: parsed.caption, hashtags, cta, fullText };
  } catch {
    console.warn('[소셜] 캡션 파싱 실패 — 기본 템플릿 사용');
    const hashtags = [...REQUIRED_HASHTAGS, '#nodejs', '#개발공부', '#백엔드개발'];
    return {
      caption: `📝 ${title}\n오늘의 IT 인사이트를 정리했어요!`,
      hashtags,
      cta: '블로그에서 더 자세히! 👉 프로필 링크',
      fullText: `📝 ${title}\n오늘의 IT 인사이트를 정리했어요!\n\n블로그에서 더 자세히! 👉 프로필 링크\n\n${hashtags.join(' ')}`,
    };
  }
}

function resolveThumbPath(title = '', explicitThumbPath = null) {
  if (explicitThumbPath && fs.existsSync(explicitThumbPath)) return explicitThumbPath;
  if (!fs.existsSync(IMAGE_DIR)) return null;

  const safeTitle = String(title || '').replace(/[^\p{L}\p{N}]+/gu, '_');
  const thumbs = fs
    .readdirSync(IMAGE_DIR)
    .filter((name) => name.endsWith('_thumb.png'))
    .map((name) => path.join(IMAGE_DIR, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  const matching = thumbs.find((fullPath) => path.basename(fullPath).includes(safeTitle.slice(0, 12)));
  return matching || thumbs[0] || null;
}

async function createInstaContent(content, title, category, cardCount = 3, options = {}) {
  console.log(`[소셜] 인스타 콘텐츠 생성 시작 (릴스 중심)`);

  const today = kst.today();
  const safeSlug = (title || '').replace(/[^가-힣a-zA-Z0-9]/g, '_').slice(0, 30);
  const slug = `${today}_${safeSlug}`;

  const summaries = await summarizeForInsta(content, cardCount);
  console.log(`  요약 ${summaries.length}개 생성`);

  const { caption, hashtags, cta, fullText } = await generateInstaCaption(content, title, category);
  console.log(`  캡션 완료 (해시태그 ${hashtags.length}개)`);

  const thumbPath = resolveThumbPath(title, options.thumbPath || null);
  let reel = null;
  let plan = null;
  if (thumbPath) {
    plan = buildShortformPlan({
      title,
      category,
      thumbPath,
      blogUrl: options.blogUrl || '',
      durationSec: options.durationSec || 10,
      content,
    });
    const render = await renderShortformReel({
      thumbPath: plan.thumbPath,
      outputPath: plan.outputPath,
      durationSec: plan.durationSec,
    });
    reel = {
      ...render,
      storyboard: plan.storyboard,
      thumbPath: plan.thumbPath,
      hook: plan.hook,
      cta: plan.cta,
    };
    console.log(`  릴스 렌더 완료 (${render.durationSec}초)`);
  } else {
    console.warn('  ⚠️ 숏폼용 썸네일을 찾지 못해 릴스 렌더를 건너뜁니다');
  }

  const meta = {
    title, category, slug, summaries, reel,
    caption, hashtags, cta, fullText,
    createdAt: new Date().toISOString(),
  };

  if (!fs.existsSync(INSTA_DIR)) fs.mkdirSync(INSTA_DIR, { recursive: true });

  const escHtml = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const htmlContent = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'unsafe-inline'">
<title>📸 ${escHtml(title)} — 인스타</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 16px; line-height: 1.8; color: #222; }
  h1 { font-size: 1.2rem; border-bottom: 2px solid #e1306c; padding-bottom: 8px; }
  h2 { font-size: 1rem; margin-top: 20px; }
  .caption { background: #fafafa; border-left: 4px solid #e1306c; padding: 12px; margin: 8px 0; white-space: pre-wrap; }
  .hashtags { color: #00376b; word-wrap: break-word; line-height: 2; background: #f0f7ff; padding: 12px; border-radius: 8px; }
  .card-info { background: #f0f0f0; padding: 8px 12px; margin: 6px 0; border-radius: 8px; font-size: 0.9rem; }
  .copy-btn { background: #e1306c; color: white; border: none; padding: 10px 20px; border-radius: 8px; font-size: 0.95rem; margin: 6px 4px 0; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  footer { color: #aaa; font-size: 0.78rem; margin-top: 24px; padding-top: 12px; border-top: 1px solid #eee; }
</style>
</head>
<body>
<h1>📸 ${escHtml(title)}</h1>

<h2>📝 캡션</h2>
<div class="caption" id="cap">${escHtml(caption)}</div>
<button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('cap').textContent).then(()=>alert('캡션 복사됨!'))">캡션 복사</button>

<h2>#️⃣ 해시태그</h2>
<div class="hashtags" id="tags">${escHtml(hashtags.join(' '))}</div>
<button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('tags').textContent).then(()=>alert('해시태그 복사됨!'))">해시태그 복사</button>

<h2>📣 CTA</h2>
<div class="caption" id="cta">${escHtml(cta || '')}</div>
<button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('cta').textContent).then(()=>alert('CTA 복사됨!'))">CTA 복사</button>

<h2>🎬 릴스 결과</h2>
${reel ? `<div class="card-info">릴스 파일: ${escHtml(reel.outputPath)}</div>` : '<div class="card-info">릴스 미생성</div>'}
${(reel?.storyboard || []).map((step, i) => `<div class="card-info">구간 ${i + 1}: ${step.overlay || ''}</div>`).join('\n')}

<footer>생성: ${new Date().toLocaleString('ko-KR')} | 팀 제이 스타 봇</footer>
</body>
</html>`;
  const htmlFilename = `${slug}_insta.html`;
  fs.writeFileSync(path.join(INSTA_DIR, htmlFilename), htmlContent, 'utf8');

  try {
    if (!fs.existsSync(GDRIVE_DIR)) fs.mkdirSync(GDRIVE_DIR, { recursive: true });
    fs.writeFileSync(path.join(GDRIVE_DIR, htmlFilename), htmlContent, 'utf8');
    console.log(`  📱 [스타] 구글드라이브 동기화: html${reel?.outputPath ? ' + 릴스 1개' : ''}`);
  } catch (e) {
    console.warn(`  ⚠️ [스타] 구글드라이브 복사 실패: ${e.message}`);
  }

  console.log(`[소셜] 완성: 릴스 ${reel ? '1개' : '0개'} + 해시태그 ${hashtags.length}개`);
  return meta;
}

module.exports = {
  summarizeForInsta,
  generateInstaCaption,
  createInstaContent,
};
