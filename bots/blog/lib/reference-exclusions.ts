'use strict';

const EXCLUDED_REFERENCE_POST_IDS = new Set([111, 112, 113]);

const EXCLUDED_REFERENCE_TITLES = [
  '[홈페이지와App] 왜 홈페이지와 앱은 빨라지는 것보다 지금 무슨 일이 일어나는지 먼저 설명해야 신뢰를 얻을까',
  '왜 홈페이지와 앱은 빨라지는 것보다 지금 무슨 일이 일어나는지 먼저 설명해',
  '[도서리뷰] 도서 정보 검증이 완료되지 않아 이번 리뷰는 진행하지 않겠습니다',
  '[Node.js 62강] NestJS 입문 2: 데코레이터와 파이프(Pipe)를 이용한 선언적 프로그래밍',
];

const EXCLUDED_REFERENCE_FILENAMES = new Set([
  'Fri Apr 10 2026 00:00:00 GMT+0900 (Korean Standard Time)_general_홈페이지와App 왜 홈페이지와 앱은 빨라지는 것보다 지금 무슨 일이 일어나는지 먼저 설명해.html',
  '2026-04-10_general_홈페이지와App 왜 홈페이지와 앱은 빨라지는 것보다 지금 무슨 일이 일어나는지 먼저 설명해.html',
  '2026-04-09_general_도서리뷰 도서 정보 검증이 완료되지 않아 이번 리뷰는 진행하지 않겠습니다.html',
  '2026-04-09_lecture_Nodejs 62강 NestJS 입문 2 데코레이터와 파이프Pipe를 이용한 선언적 프로그.html',
]);

function normalizeReferenceText(value = '') {
  return String(value || '')
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const EXCLUDED_REFERENCE_NORMALIZED_TITLES = new Set(
  EXCLUDED_REFERENCE_TITLES.map(normalizeReferenceText).filter(Boolean),
);

function isExcludedReferenceTitle(title = '') {
  return EXCLUDED_REFERENCE_NORMALIZED_TITLES.has(normalizeReferenceText(title));
}

function isExcludedReferenceFilename(filename = '') {
  return EXCLUDED_REFERENCE_FILENAMES.has(String(filename || '').trim());
}

/**
 * @param {{ id?: number|string, title?: string, filename?: string, metadata?: { filename?: string, fileName?: string } }} [post]
 */
function isExcludedReferencePost(post = {}) {
  // @ts-ignore JS checkJs default-param inference is too narrow here
  const id = Number(post?.id || 0);
  if (id && EXCLUDED_REFERENCE_POST_IDS.has(id)) return true;
  // @ts-ignore JS checkJs default-param inference is too narrow here
  if (isExcludedReferenceTitle(post?.title)) return true;
  // @ts-ignore JS checkJs default-param inference is too narrow here
  if (isExcludedReferenceFilename(post?.filename)) return true;
  // @ts-ignore JS checkJs default-param inference is too narrow here
  const metadataFilename = post?.metadata?.filename || post?.metadata?.fileName;
  if (isExcludedReferenceFilename(metadataFilename)) return true;
  return false;
}

module.exports = {
  isExcludedReferenceTitle,
  isExcludedReferenceFilename,
  isExcludedReferencePost,
};
