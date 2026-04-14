'use strict';

const pgPool = require('../../../packages/core/lib/pg-pool');
const { loadLatestStrategy } = require('./strategy-loader.ts');

const GENERAL_CATEGORIES = [
  '자기계발', '도서리뷰', '성장과성공', '홈페이지와App',
  '최신IT트렌드', 'IT정보와분석', '개발기획과컨설팅',
];

function _scoreGeneralCategory(category, distance, strategyPlan = null) {
  let score = 100 - distance;
  if (!strategyPlan) return score;

  if (strategyPlan.preferredCategory && category === strategyPlan.preferredCategory) {
    score += 8;
  }
  if (strategyPlan.suppressedCategory && category === strategyPlan.suppressedCategory) {
    score -= 4;
  }
  if (
    strategyPlan.hardSuppressTitlePattern &&
    strategyPlan.preferredCategory &&
    category !== strategyPlan.preferredCategory
  ) {
    score -= 1;
  }
  return score;
}

function _pickGeneralCategory(startIndex = 0, strategyPlan = null) {
  const total = GENERAL_CATEGORIES.length;
  const candidates = GENERAL_CATEGORIES.map((category, absoluteIndex) => {
    const distance = (absoluteIndex - startIndex + total) % total;
    return {
      category,
      absoluteIndex,
      distance,
      score: _scoreGeneralCategory(category, distance, strategyPlan),
    };
  }).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.distance - b.distance;
  });

  return candidates[0] || {
    category: GENERAL_CATEGORIES[startIndex % total],
    absoluteIndex: startIndex % total,
    distance: 0,
    score: 100,
  };
}

async function getNextGeneralCategory(strategyPlan = null) {
  try {
    const row = await pgPool.get('blog', `
      SELECT current_index FROM blog.category_rotation
      WHERE rotation_type = 'general_category' LIMIT 1
    `);
    const idx = row?.current_index ?? 0;
    const effectiveStrategy = strategyPlan || loadLatestStrategy();
    const picked = _pickGeneralCategory(idx % GENERAL_CATEGORIES.length, effectiveStrategy);
    return {
      category: picked.category,
      index: idx,
      selectedIndex: picked.absoluteIndex,
      nextIndex: (picked.absoluteIndex + 1) % GENERAL_CATEGORIES.length,
      distance: picked.distance,
      strategyApplied: Boolean(effectiveStrategy?.preferredCategory || effectiveStrategy?.suppressedCategory),
    };
  } catch {
    return {
      category: GENERAL_CATEGORIES[0],
      index: 0,
      selectedIndex: 0,
      nextIndex: 1,
      distance: 0,
      strategyApplied: false,
    };
  }
}

async function advanceGeneralCategory(selectedCategory = null) {
  if (selectedCategory && GENERAL_CATEGORIES.includes(selectedCategory)) {
    const targetIndex = GENERAL_CATEGORIES.indexOf(selectedCategory);
    await pgPool.run('blog', `
      UPDATE blog.category_rotation
      SET current_index = $1, updated_at = NOW()
      WHERE rotation_type = 'general_category'
    `, [(targetIndex + 1) % GENERAL_CATEGORIES.length]);
    return;
  }

  await pgPool.run('blog', `
    UPDATE blog.category_rotation
    SET current_index = (current_index + 1) % 7, updated_at = NOW()
    WHERE rotation_type = 'general_category'
  `);
}

async function getNextLectureNumber() {
  try {
    const row = await pgPool.get('blog', `
      SELECT current_index, series_name FROM blog.category_rotation
      WHERE rotation_type = 'lecture_series' LIMIT 1
    `);
    return {
      number: (row?.current_index ?? 0) + 1,
      seriesName: row?.series_name ?? 'nodejs_120',
    };
  } catch {
    return {
      number: 1,
      seriesName: 'nodejs_120',
    };
  }
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
      AND status IN ('ready', 'published')
    LIMIT 1
  `, [nextNumber]);

  if (!published) {
    console.warn(`[category-rotation] ⚠️ ${nextNumber}강 ready/published 포스트 없음 — 인덱스 증가 스킵`);
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
  try {
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
  } catch {
    return false;
  }
}

async function getLectureTitle(number: number, seriesName = 'nodejs_120') {
  try {
    const row = await pgPool.get('blog', `
      SELECT title FROM blog.curriculum
      WHERE series_name = $1 AND lecture_number = $2
    `, [seriesName, number]);
    return row?.title || null;
  } catch {
    return null;
  }
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
