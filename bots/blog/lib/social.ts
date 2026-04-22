'use strict';
const kst = require('../../../packages/core/lib/kst');
const { selectLLMChain } = require('../../../packages/core/lib/llm-model-selector');
const { getBlogLLMSelectorOverrides } = require('./runtime-config.ts');

/**
 * bots/blog/lib/social.ts — 소셜(SOCIAL) 봇
 *
 * 역할:
 *   N40. 포스팅 본문 → 섹션별 15~20자 요약 (gpt-4o-mini, OpenAI)
 *   N41. 요약 텍스트 → 1024×1024 인스타 카드 (img-gen: Nano Banana 메인 + OpenAI High 폴백)
 *   N42. 캡션 + 해시태그 자동 생성 (gpt-4o-mini, OpenAI)
 *
 * 비용: gpt-4o-mini(N40/N42) 유료(저렴), Nano Banana(N41) 무료 → OpenAI High 폴백 유료
 */

const { callWithFallback } = require('../../../packages/core/lib/llm-fallback');
const { generateInstaCard } = require('./img-gen.ts');
const { loadStrategyBundle, normalizeExecutionDirectives } = require('./strategy-loader.ts');
const env = require('../../../packages/core/lib/env');
const fs = require('fs');
const path = require('path');

const INSTA_DIR = path.join(env.PROJECT_ROOT, 'bots', 'blog', 'output', 'images', 'insta');
const GDRIVE_DIR = process.env.GDRIVE_BLOG_INSTA || '/tmp/blog-insta';

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
    chain: selectLLMChain('blog.social.summarize', {
      policyOverride: selectorOverrides['blog.social.summarize'],
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

function resolveInstagramCardCount(cardCount = 0, strategy = null) {
  const directives = normalizeExecutionDirectives(strategy);
  const instagramPriority = directives.channelPriority.instagram;
  const imageAggro = directives.creativePolicy.imageAggro;
  const reelAggro = directives.creativePolicy.reelAggro;
  const explicit = Number(cardCount || 0);
  if (explicit > 0) return Math.max(2, Math.min(6, explicit));

  let derived = instagramPriority === 'primary' ? 5 : instagramPriority === 'secondary' ? 4 : 3;
  if (imageAggro === 'high') derived += 1;
  if (imageAggro === 'low') derived -= 1;
  if (reelAggro === 'high' && instagramPriority !== 'supporting') derived += 0.5;
  return Math.max(2, Math.min(6, Math.round(derived)));
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

function buildStrategyCaptionHint(strategy = null) {
  const directives = normalizeExecutionDirectives(strategy);
  return [
    `채널 우선순위: 네이버=${directives.channelPriority.naverBlog}, 인스타=${directives.channelPriority.instagram}, 페이스북=${directives.channelPriority.facebook}`,
    `실행 목표: 블로그 ${directives.executionTargets.blogRegistrationsPerCycle} / 인스타 ${directives.executionTargets.instagramRegistrationsPerCycle} / 페이스북 ${directives.executionTargets.facebookRegistrationsPerCycle}`,
    `반응 목표: 답글 ${directives.executionTargets.replyTargetPerCycle} / 이웃댓글 ${directives.executionTargets.neighborCommentTargetPerCycle} / 공감 ${directives.executionTargets.sympathyTargetPerCycle}`,
    `제목 톤: ${directives.titlePolicy.tone}`,
    `해시태그 모드: ${directives.hashtagPolicy.mode}`,
    `이미지 어그로: ${directives.creativePolicy.imageAggro}, 릴스 훅: ${directives.creativePolicy.hookStyle}, CTA: ${directives.creativePolicy.ctaStyle}`,
  ].join('\n');
}

function buildFallbackHashtags(category = '', strategy = null) {
  const directives = normalizeExecutionDirectives(strategy);
  const categoryTags = {
    '최신IT트렌드': ['#IT트렌드', '#AI트렌드', '#기술분석'],
    'IT정보와분석': ['#IT분석', '#실무인사이트', '#디지털전략'],
    '홈페이지와App': ['#UX개선', '#전환율', '#앱기획'],
    '개발기획과컨설팅': ['#기획실무', '#개발협업', '#PM인사이트'],
    '성장과성공': ['#성장전략', '#성과관리', '#실행력'],
  };
  const modeTags = directives.hashtagPolicy.mode === 'aggressive'
    ? ['#릴스', '#바이럴', '#콘텐츠마케팅']
    : directives.hashtagPolicy.mode === 'conversion'
      ? ['#예약문의', '#상담문의', '#전환콘텐츠']
      : ['#브랜딩', '#블로그운영', '#콘텐츠전략'];

  return [
    ...REQUIRED_HASHTAGS,
    ...(categoryTags[category] || ['#개발공부', '#실무팁']),
    ...modeTags,
    ...directives.hashtagPolicy.focusTags,
    ...directives.hashtagPolicy.platformTags,
  ].filter(Boolean);
}

function buildStrategyCta(title = '', strategy = null) {
  const directives = normalizeExecutionDirectives(strategy);
  if (directives.creativePolicy.ctaStyle === 'conversion') {
    return '블로그에서 체크포인트를 확인하고 바로 예약/문의 흐름까지 이어가세요 👉 프로필 링크';
  }
  if (directives.creativePolicy.ctaStyle === 'engagement') {
    return '이 포인트가 도움 됐다면 저장하고, 블로그에서 전체 전략을 이어서 확인하세요 👉 프로필 링크';
  }
  return title && /체크|포인트|방법|전략/.test(title)
    ? '블로그에서 더 자세한 실행 포인트를 확인하세요 👉 프로필 링크'
    : '블로그에서 더 자세히! 👉 프로필 링크';
}

async function generateInstaCaption(content, title, category, strategy = null) {
  const selectorOverrides = getBlogLLMSelectorOverrides();
  const plan = strategy || loadStrategyBundle().plan;
  const userPrompt = `
다음 블로그 포스팅의 인스타그램 캡션과 해시태그를 생성하세요.

제목: ${title}
카테고리: ${category}

[현재 전략]
${buildStrategyCaptionHint(plan)}

[포스팅 요약]
${content.slice(0, 3000)}
`.trim();

  const result = await callWithFallback({
    chain: selectLLMChain('blog.social.caption', {
      policyOverride: selectorOverrides['blog.social.caption'],
    }),
    systemPrompt: CAPTION_SYSTEM,
    userPrompt,
    logMeta: { team: 'blog', purpose: 'social', bot: 'social', requestType: 'insta_caption' },
  });

  try {
    const match = result.text.match(/\{[\s\S]*?\}/);
    const parsed = match ? JSON.parse(match[0]) : null;
    if (!parsed) throw new Error('파싱 실패');

    const hashtags = Array.isArray(parsed.hashtags) ? parsed.hashtags : [];
    for (const tag of REQUIRED_HASHTAGS) {
      if (!hashtags.includes(tag)) hashtags.push(tag);
    }
    for (const tag of buildFallbackHashtags(category, plan)) {
      if (!hashtags.includes(tag)) hashtags.push(tag);
    }
    const cta = parsed.cta || buildStrategyCta(title, plan);
    const fullText = `${parsed.caption}\n\n${cta}\n\n${hashtags.join(' ')}`;

    return { caption: parsed.caption, hashtags, cta, fullText };
  } catch {
    console.warn('[소셜] 캡션 파싱 실패 — 기본 템플릿 사용');
    const hashtags = [...new Set(buildFallbackHashtags(category, plan))];
    return {
      caption: `📝 ${title}\n${normalizeExecutionDirectives(plan).titlePolicy.tone === 'conversion' ? '바로 적용할 포인트만 짧게 정리했어요!' : '오늘의 IT 인사이트를 짧게 정리했어요!'}`,
      hashtags,
      cta: buildStrategyCta(title, plan),
      fullText: `📝 ${title}\n${normalizeExecutionDirectives(plan).titlePolicy.tone === 'conversion' ? '바로 적용할 포인트만 짧게 정리했어요!' : '오늘의 IT 인사이트를 짧게 정리했어요!'}\n\n${buildStrategyCta(title, plan)}\n\n${hashtags.join(' ')}`,
    };
  }
}

async function createInstaContent(content, title, category, cardCount = 3) {
  const plan = loadStrategyBundle().plan;
  const effectiveCardCount = resolveInstagramCardCount(cardCount, plan);
  console.log(`[소셜] 인스타 콘텐츠 생성 시작 (카드 ${effectiveCardCount}장)`);

  const today = kst.today();
  const safeSlug = (title || '').replace(/[^가-힣a-zA-Z0-9]/g, '_').slice(0, 30);
  const slug = `${today}_${safeSlug}`;

  const summaries = await summarizeForInsta(content, effectiveCardCount);
  console.log(`  요약 ${summaries.length}개 생성`);

  if (!fs.existsSync(INSTA_DIR)) fs.mkdirSync(INSTA_DIR, { recursive: true });
  const cardResults = await Promise.allSettled(
    summaries.map(async (s, i) => {
      const filename = `${slug}_card${i + 1}.png`;
      const outputPath = path.join(INSTA_DIR, filename);
      const filePath = await generateInstaCard(s.summary, i + 1, outputPath);
      if (filePath) {
        try {
          if (!fs.existsSync(GDRIVE_DIR)) fs.mkdirSync(GDRIVE_DIR, { recursive: true });
          fs.copyFileSync(outputPath, path.join(GDRIVE_DIR, filename));
        } catch {
          // ignore
        }
      }
      return filePath;
    })
  );
  const cards = cardResults
    .map((r, i) => ({
      index: i + 1,
      summary: summaries[i]?.summary || '',
      imagePath: r.status === 'fulfilled' ? r.value : null,
    }))
    .filter((c) => c.imagePath);
  console.log(`  카드 ${cards.length}/${summaries.length} 생성 성공`);

  const { caption, hashtags, cta, fullText } = await generateInstaCaption(content, title, category, plan);
  console.log(`  캡션 완료 (해시태그 ${hashtags.length}개)`);

  const meta = {
    title, category, slug, summaries, cards,
    caption, hashtags, cta, fullText,
    strategyExecution: normalizeExecutionDirectives(plan),
    effectiveCardCount,
    createdAt: new Date().toISOString(),
  };
  const metaFilename = `${slug}_insta-meta.json`;
  if (!fs.existsSync(INSTA_DIR)) fs.mkdirSync(INSTA_DIR, { recursive: true });
  fs.writeFileSync(path.join(INSTA_DIR, metaFilename), JSON.stringify(meta, null, 2));
  try {
    if (!fs.existsSync(GDRIVE_DIR)) fs.mkdirSync(GDRIVE_DIR, { recursive: true });
    fs.writeFileSync(path.join(GDRIVE_DIR, metaFilename), JSON.stringify(meta, null, 2));
  } catch {
    // ignore
  }

  console.log(`[소셜] 완성: 카드 ${cards.length}장 + 해시태그 ${hashtags.length}개`);
  return meta;
}

module.exports = {
  summarizeForInsta,
  generateInstaCaption,
  createInstaContent,
};
