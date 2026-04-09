'use strict';

const pgPool = require('../../../packages/core/lib/pg-pool');

const GENERAL_CATEGORIES = [
  '자기계발', '도서리뷰', '성장과성공', '홈페이지와App',
  '최신IT트렌드', 'IT정보와분석', '개발기획과컨설팅',
];

async function getNextGeneralCategory() {
  const row = await pgPool.get('blog', `
    SELECT current_index FROM blog.category_rotation
    WHERE rotation_type = 'general_category' LIMIT 1
  `);
  const idx = row?.current_index ?? 0;
  return {
    category: GENERAL_CATEGORIES[idx % GENERAL_CATEGORIES.length],
    index: idx,
    nextIndex: (idx + 1) % GENERAL_CATEGORIES.length,
  };
}

async function advanceGeneralCategory() {
  await pgPool.run('blog', `
    UPDATE blog.category_rotation
    SET current_index = (current_index + 1) % 7, updated_at = NOW()
    WHERE rotation_type = 'general_category'
  `);
}

async function getNextLectureNumber() {
  const row = await pgPool.get('blog', `
    SELECT current_index, series_name FROM blog.category_rotation
    WHERE rotation_type = 'lecture_series' LIMIT 1
  `);
  return {
    number: (row?.current_index ?? 0) + 1,
    seriesName: row?.series_name ?? 'nodejs_120',
  };
}

async function advanceLectureNumber() {
  const current = await pgPool.get('blog', `
    SELECT current_index, series_name FROM blog.category_rotation
    WHERE rotation_type = 'lecture_series' LIMIT 1
  `);
  if (!current) return;

  const nextNumber = (current.current_index ?? 0) + 1;
  const published = await pgPool.get('blog', `
    SELECT id FROM blog.posts
    WHERE post_type = 'lecture'
      AND lecture_number = $1
      AND status = 'published'
    LIMIT 1
  `, [nextNumber]);

  if (!published) {
    console.warn(`[category-rotation] ⚠️ ${nextNumber}강 미발행 — 인덱스 증가 스킵`);
    return;
  }

  await pgPool.run('blog', `
    UPDATE blog.category_rotation
    SET current_index = current_index + 1, updated_at = NOW()
    WHERE rotation_type = 'lecture_series'
  `);
}

async function resetLectureNumber(currentIndex = 55) {
  await pgPool.run('blog', `
    UPDATE blog.category_rotation
    SET current_index = $1, updated_at = NOW()
    WHERE rotation_type = 'lecture_series'
  `, [Number(currentIndex || 0)]);
}

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

async function getLectureTitle(number: number, seriesName = 'nodejs_120') {
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
  resetLectureNumber,
  isSeriesComplete,
  getLectureTitle,
};
