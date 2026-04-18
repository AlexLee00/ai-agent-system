'use strict';

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
function blogToInstagramCaption(blogPost, maxChars = 2200) {
  const { title, content, hashtags = [] } = blogPost;

  // 핵심 포인트 3개 추출
  const keyPoints = extractKeyPoints(content || '', 3);
  const pointsStr = keyPoints.length > 0
    ? '\n\n' + keyPoints.slice(0, 3).map((p, i) => `${i + 1}. ${p}`).join('\n')
    : '';

  // 해시태그 (최대 30개)
  const baseHashtags = ['#스터디카페', '#공부', '#자기계발', '#집중력'];
  const allHashtags = [...new Set([...baseHashtags, ...(hashtags || []).slice(0, 26)])]
    .slice(0, 30)
    .map((h) => h.startsWith('#') ? h : `#${h}`)
    .join(' ');

  const caption = [title, pointsStr, '\n\n', allHashtags].join('');
  return caption.slice(0, maxChars);
}

/**
 * 블로그 본문 → 페이스북 포스트 변환
 * @param {object} blogPost { title, content, url, naver_url }
 * @param {number} maxChars 최대 글자 수
 */
function blogToFacebookPost(blogPost, maxChars = 200) {
  const { title, content, naver_url, url } = blogPost;

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

  return {
    message: summary,
    link: naver_url || url || '',
    title,
    hashtags: ['#스터디카페', '#자기계발'].slice(0, 5),
  };
}

/**
 * 블로그 → 릴스 스크립트 (Hook + Problem + Solution + CTA)
 * 30~60초 분량 (약 150~300자)
 */
function blogToReelScript(blogPost) {
  const { title, content, category } = blogPost;
  const keyPoints = extractKeyPoints(content || '', 3);

  const hook = `${title}에 대해 알고 계셨나요?`;
  const problem = keyPoints[0] ? `많은 분들이 ${keyPoints[0]}을(를) 어렵게 느끼시는데요.` : '';
  const solution = keyPoints.slice(1, 3).join(' ') || '지금 바로 실천해보세요.';
  const cta = category === '도서리뷰'
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
