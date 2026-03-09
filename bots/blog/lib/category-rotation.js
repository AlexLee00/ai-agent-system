'use strict';

/**
 * category-rotation.js — 카테고리 순환 관리
 */

const pgPool = require('../../../packages/core/lib/pg-pool');

// 7개 일반 카테고리 순환
const GENERAL_CATEGORIES = [
  '자기계발', '도서리뷰', '성장과성공', '홈페이지와App',
  '최신IT트렌드', 'IT정보와분석', '개발기획과컨설팅',
];

/**
 * 오늘 일반 포스팅 카테고리 조회 (순환)
 */
async function getNextGeneralCategory() {
  const row = await pgPool.get('blog', `
    SELECT current_index FROM blog.category_rotation
    WHERE rotation_type = 'general_category' LIMIT 1
  `);
  const idx = row?.current_index ?? 0;
  return {
    category:  GENERAL_CATEGORIES[idx % GENERAL_CATEGORIES.length],
    index:     idx,
    nextIndex: (idx + 1) % GENERAL_CATEGORIES.length,
  };
}

/**
 * 일반 카테고리 인덱스 증가 (발행 후 호출)
 */
async function advanceGeneralCategory() {
  await pgPool.run('blog', `
    UPDATE blog.category_rotation
    SET current_index = (current_index + 1) % 7, updated_at = NOW()
    WHERE rotation_type = 'general_category'
  `);
}

/**
 * 다음 강의 번호 조회 (current_index = 완료된 마지막 강의)
 */
async function getNextLectureNumber() {
  const row = await pgPool.get('blog', `
    SELECT current_index, series_name FROM blog.category_rotation
    WHERE rotation_type = 'lecture_series' LIMIT 1
  `);
  return {
    number:     (row?.current_index ?? 0) + 1,
    seriesName: row?.series_name ?? 'nodejs_120',
  };
}

/**
 * 강의 번호 증가 (발행 후 호출)
 */
async function advanceLectureNumber() {
  await pgPool.run('blog', `
    UPDATE blog.category_rotation
    SET current_index = current_index + 1, updated_at = NOW()
    WHERE rotation_type = 'lecture_series'
  `);
}

/**
 * 현재 시리즈 완료 여부 체크
 */
async function isSeriesComplete() {
  const row = await pgPool.get('blog', `
    SELECT cr.current_index,
           (SELECT MAX(lecture_number)
            FROM blog.curriculum
            WHERE series_name = cr.series_name) AS max_lecture
    FROM blog.category_rotation cr
    WHERE cr.rotation_type = 'lecture_series'
  `);
  if (!row) return false;
  return row.current_index >= (row.max_lecture || 120);
}

/**
 * 커리큘럼에서 강의 제목 조회
 */
async function getLectureTitle(number, seriesName = 'nodejs_120') {
  const row = await pgPool.get('blog', `
    SELECT title FROM blog.curriculum
    WHERE series_name = $1 AND lecture_number = $2
  `, [seriesName, number]);
  return row?.title || null;
}

module.exports = {
  GENERAL_CATEGORIES,
  getNextGeneralCategory,
  advanceGeneralCategory,
  getNextLectureNumber,
  advanceLectureNumber,
  isSeriesComplete,
  getLectureTitle,
};
