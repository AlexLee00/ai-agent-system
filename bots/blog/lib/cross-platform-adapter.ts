'use strict';

const { loadStrategyBundle, normalizeExecutionDirectives } = require('./strategy-loader.ts');

/**
 * bots/blog/lib/cross-platform-adapter.ts
 * 네이버 블로그 → 인스타그램/페이스북 크로스 플랫폼 변환기
 *
 * Phase 4: 하나의 블로그 글을 플랫폼별 최적 형태로 변환
 */

/**
 * 네이버 블로그 콘텐츠에서 핵심 포인트 추출 (LLM 없이 규칙 기반)
 * @param {string} content 블로그 본문
 * @param {number} maxPoints 최대 추출 포인트
 */
function extractKeyPoints(content, maxPoints = 5) {
  if (!content) return [];

  // 번호 목록 패턴 추출 (1. 2. 3. / ① ② ③ / - •)
  const numberedItems = content.match(/(?:^|\n)\s*(?:\d+[.)]\s+|[①-⑩]\s+|[-•]\s+)(.+)/gm) || [];
  const points = numberedItems
    .map((line) => line.replace(/^\s*(?:\d+[.)]\s+|[①-⑩]\s+|[-•]\s+)/, '').trim())
    .filter((p) => p.length > 10 && p.length < 200)
    .slice(0, maxPoints);

  if (points.length >= 3) return points;

  // 문단 첫 문장 추출 (폴백)
  const sentences = content.split(/\n\n+/).map((para) => {
    const firstSentence = para.split(/[.!?]/)[0]?.trim();
    return firstSentence && firstSentence.length > 20 ? firstSentence : null;
  }).filter(Boolean).slice(0, maxPoints);

  return sentences;
}

/**
 * 블로그 본문 → 인스타그램 캡션 변환
 * @param {object} blogPost { title, content, hashtags, category }
 * @param {number} maxChars 최대 글자 수
 */
function blogToInstagramCaption(blogPost, maxChars = 2200, strategy = null) {
  const { title, content, hashtags = [] } = blogPost;
  const plan = strategy || loadStrategyBundle().plan;
  const directives = normalizeExecutionDirectives(plan);

  // 핵심 포인트 3개 추출
  const keyPoints = extractKeyPoints(content || '', 3);
  const pointsStr = keyPoints.length > 0
    ? '\n\n' + keyPoints.slice(0, 3).map((p, i) => `${i + 1}. ${p}`).join('\n')
    : '';

  // 해시태그 (최대 30개)
  const baseHashtags = directives.hashtagPolicy.mode === 'aggressive'
    ? ['#스터디카페', '#공부', '#자기계발', '#집중력', '#릴스', '#바이럴']
    : directives.hashtagPolicy.mode === 'conversion'
      ? ['#스터디카페', '#집중력', '#예약문의', '#상담문의']
      : ['#스터디카페', '#공부', '#자기계발', '#집중력'];
  const allHashtags = [...new Set([
    ...baseHashtags,
    ...directives.hashtagPolicy.focusTags,
    ...directives.hashtagPolicy.platformTags,
    ...(hashtags || []).slice(0, 26),
  ])]
    .slice(0, 30)
    .map((h) => h.startsWith('#') ? h : `#${h}`)
    .join(' ');

  const toneLine = directives.titlePolicy.tone === 'conversion'
    ? '\n\n지금 바로 적용 포인트부터 짧게 확인해보세요.'
    : directives.titlePolicy.tone === 'amplify'
      ? '\n\n저장해두고 다시 볼 포인트만 모았습니다.'
      : '';
  const caption = [title, pointsStr, toneLine, '\n\n', allHashtags].join('');
  return caption.slice(0, maxChars);
}

/**
 * 블로그 본문 → 페이스북 포스트 변환
 * @param {object} blogPost { title, content, url, naver_url }
 * @param {number} maxChars 최대 글자 수
 */
function blogToFacebookPost(blogPost, maxChars = 200, strategy = null) {
  const { title, content, naver_url, url } = blogPost;
  const plan = strategy || loadStrategyBundle().plan;
  const directives = normalizeExecutionDirectives(plan);

  // 첫 문장 요약 (80~200자)
  const firstSentence = (content || '')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/[.!?]/)[0]
    ?.trim() || '';

  const summary = firstSentence.length > 50
    ? firstSentence.slice(0, maxChars)
    : title;
  const message = directives.creativePolicy.ctaStyle === 'conversion'
    ? `${summary}\n지금 적용 포인트와 예약 흐름까지 함께 점검해보세요.`
    : summary;

  return {
    message,
    link: naver_url || url || '',
    title,
    hashtags: [...new Set(['#스터디카페', '#자기계발', ...directives.hashtagPolicy.focusTags])].slice(0, 5),
  };
}

/**
 * 블로그 → 릴스 스크립트 (Hook + Problem + Solution + CTA)
 * 30~60초 분량 (약 150~300자)
 */
function blogToReelScript(blogPost, strategy = null) {
  const { title, content, category } = blogPost;
  const plan = strategy || loadStrategyBundle().plan;
  const directives = normalizeExecutionDirectives(plan);
  const keyPoints = extractKeyPoints(content || '', 3);

  const hook = directives.creativePolicy.hookStyle === 'scroll_stop'
    ? `${title} 여기서 결과가 갈립니다`
    : directives.creativePolicy.hookStyle === 'problem_first'
      ? `${title} 보통 여기서 놓칩니다`
      : `${title}에 대해 알고 계셨나요?`;
  const problem = keyPoints[0] ? `많은 분들이 ${keyPoints[0]}을(를) 어렵게 느끼시는데요.` : '';
  const solution = keyPoints.slice(1, 3).join(' ') || '지금 바로 실천해보세요.';
  const cta = directives.creativePolicy.ctaStyle === 'conversion'
    ? '블로그에서 적용 포인트를 확인하고 바로 다음 행동까지 이어가세요!'
    : category === '도서리뷰'
    ? '이 책이 궁금하다면 블로그 링크를 확인해보세요!'
    : '스터디카페에서 집중 환경을 경험해보세요!';

  return {
    hook,
    problem,
    solution,
    cta,
    full_script: [hook, problem, solution, cta].filter(Boolean).join(' '),
    estimated_duration_sec: 45,
  };
}

module.exports = {
  extractKeyPoints,
  blogToInstagramCaption,
  blogToFacebookPost,
  blogToReelScript,
};
