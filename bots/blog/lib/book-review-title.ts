// @ts-nocheck
'use strict';

const BOOK_REVIEW_TITLE_PATTERNS = Object.freeze([
  (title) => `${title}에서 지금 다시 붙잡을 질문`,
  (title) => `${title}, 일과 삶에 어떻게 옮길까`,
  (title) => `${title}를 읽기 전과 후 달라진 판단`,
  (title) => `${title}, 줄거리보다 오래 남은 적용 포인트`,
]);

function stablePatternIndex(bookInfo = {}) {
  const isbn = String(bookInfo.isbn || '').replace(/\D/g, '');
  if (isbn) return Number(BigInt(isbn) % BigInt(BOOK_REVIEW_TITLE_PATTERNS.length));
  const key = String(bookInfo.title || '');
  let hash = 0;
  for (const char of key) hash = ((hash * 31) + char.codePointAt(0)) >>> 0;
  return hash % BOOK_REVIEW_TITLE_PATTERNS.length;
}

function buildBookReviewTitleCandidate(bookInfo = {}) {
  const title = String(bookInfo.title || '').trim();
  if (!title) return '';
  return BOOK_REVIEW_TITLE_PATTERNS[stablePatternIndex(bookInfo)](title);
}

module.exports = {
  BOOK_REVIEW_TITLE_PATTERNS,
  buildBookReviewTitleCandidate,
  stablePatternIndex,
};
