'use strict';

/**
 * quality-checker.js — 포스팅 품질 검증
 */

const MIN_CHARS  = { lecture: 8000, general: 7000 };
const GOAL_CHARS = { lecture: 9500, general: 9000 };

const REQUIRED_SECTIONS = {
  lecture: ['인사말', '브리핑', '실무 인사이트', '코드', 'FAQ', '해시태그'],
  general: ['스니펫', '인사말', '해시태그'],
};

/**
 * @param {string} content  — 포스팅 본문
 * @param {'lecture'|'general'} type
 * @returns {{ passed, charCount, hashtagCount, issues }}
 */
function checkQuality(content, type) {
  const issues    = [];
  const charCount = content.length;
  const minChars  = MIN_CHARS[type]  || 7000;
  const goalChars = GOAL_CHARS[type] || 9000;

  // 1. 글자수 체크
  if (charCount < minChars) {
    issues.push({ severity: 'error', msg: `글자수 부족: ${charCount}자 (최소 ${minChars}자)` });
  } else if (charCount < goalChars) {
    issues.push({ severity: 'warn', msg: `글자수 목표 미달: ${charCount}자 (목표 ${goalChars}자)` });
  }

  // 2. 필수 섹션 체크 (대소문자 무관)
  for (const section of REQUIRED_SECTIONS[type] || []) {
    if (!content.includes(section)) {
      issues.push({ severity: 'warn', msg: `섹션 누락 가능: "${section}"` });
    }
  }

  // 3. 커피랑도서관 홍보 포함 여부
  if (!content.includes('커피랑도서관') && !content.includes('분당서현')) {
    issues.push({ severity: 'warn', msg: '스터디카페 홍보 미포함' });
  }

  // 4. 해시태그 수 체크
  const hashtagMatch = content.match(/#[^\s#\n]+/g);
  const hashtagCount = hashtagMatch?.length || 0;
  const minHashtags  = type === 'lecture' ? 20 : 25;
  if (hashtagCount < 15) {
    issues.push({ severity: 'warn', msg: `해시태그 부족: ${hashtagCount}개 (최소 15개)` });
  }

  return {
    passed:      !issues.some(i => i.severity === 'error'),
    charCount,
    hashtagCount,
    issues,
  };
}

module.exports = { checkQuality, MIN_CHARS, GOAL_CHARS };
