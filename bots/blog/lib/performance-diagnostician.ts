// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const pgPool = require('../../../packages/core/lib/pg-pool');

const BLOG_OUTPUT_DIR = path.join(env.PROJECT_ROOT, 'bots/blog/output');

function safeReadDir(dirPath) {
  try {
    return fs.readdirSync(dirPath);
  } catch {
    return [];
  }
}

function parseOutputFilename(filename = '') {
  const lecture = filename.match(/^(\d{4}-\d{2}-\d{2}).*?_lecture_(.+)\.html$/);
  if (lecture) {
    const [, dateString, rawTitle] = lecture;
    return {
      dateString,
      postType: 'lecture',
      category: 'lecture',
      title: String(rawTitle || '').trim(),
      filename,
    };
  }

  const general = filename.match(/^(\d{4}-\d{2}-\d{2}|[A-Z][a-z]{2} .+?)_general_([^ ]+)\s+(.+)\.html$/);
  if (general) {
    const [, dateString, category, rawTitle] = general;
    return {
      dateString: String(dateString || '').slice(0, 10),
      postType: 'general',
      category: String(category || '').trim(),
      title: String(rawTitle || '').trim(),
      filename,
    };
  }

  return null;
}

function isWithinDays(dateString, days = 7) {
  if (!dateString) return false;
  const target = new Date(`${dateString}T00:00:00+09:00`);
  if (Number.isNaN(target.getTime())) return false;
  const now = new Date();
  const diff = now.getTime() - target.getTime();
  return diff >= 0 && diff <= (days * 24 * 60 * 60 * 1000);
}

function detectTitlePattern(title = '') {
  const text = String(title || '').trim();
  if (!text) return 'unknown';
  if (/^왜\s/.test(text)) return 'why';
  if (/(체크리스트|점검해야 할|확인할)/.test(text)) return 'checklist';
  if (/(트렌드|2026년|요즘)/.test(text)) return 'trend';
  if (/(직접|해보고|운영하며|배운)/.test(text)) return 'experience';
  if (/(실수|막힐 때|늦는 이유)/.test(text)) return 'warning';
  return 'default';
}

function groupCount(items = [], getKey = (item) => item) {
  const map = new Map();
  for (const item of items) {
    const key = getKey(item);
    if (!key) continue;
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);
}

async function getRecentExecutionRows(days = 7) {
  try {
    const rows = await pgPool.query('blog', `
      SELECT run_date, post_type, variations, created_at
        FROM blog.execution_history
       WHERE run_date >= CURRENT_DATE - ($1::int || ' days')::interval
       ORDER BY run_date DESC, created_at DESC
    `, [days]);
    return rows || [];
  } catch {
    return [];
  }
}

function getRecentOutputPosts(days = 7) {
  return safeReadDir(BLOG_OUTPUT_DIR)
    .map(parseOutputFilename)
    .filter(Boolean)
    .filter((post) => isWithinDays(post.dateString, days))
    .sort((a, b) => String(b.dateString).localeCompare(String(a.dateString)));
}

function summarizeCategoryPerformance(posts = []) {
  return groupCount(
    posts.filter((post) => post.postType === 'general'),
    (post) => post.category
  );
}

function summarizeTitlePatterns(posts = []) {
  return groupCount(posts, (post) => detectTitlePattern(post.title));
}

function summarizeCategoryPatternHotspots(posts = []) {
  const generalPosts = posts.filter((post) => post.postType === 'general');
  const grouped = new Map();

  for (const post of generalPosts) {
    const category = post.category || 'unknown';
    const pattern = detectTitlePattern(post.title);
    if (!grouped.has(category)) grouped.set(category, []);
    grouped.get(category).push(pattern);
  }

  return [...grouped.entries()]
    .map(([category, patterns]) => {
      const counts = groupCount(patterns, (item) => item);
      const top = counts[0] || null;
      const total = patterns.length;
      return {
        category,
        total,
        topPattern: top?.key || null,
        topCount: top?.count || 0,
        topRatio: total > 0 ? Number(((top?.count || 0) / total).toFixed(4)) : 0,
        patterns: counts,
      };
    })
    .sort((a, b) => {
      if ((b.topRatio || 0) !== (a.topRatio || 0)) return (b.topRatio || 0) - (a.topRatio || 0);
      return (b.total || 0) - (a.total || 0);
    });
}

function summarizeVariationUsage(rows = []) {
  return {
    greeting: groupCount(rows, (row) => row?.variations?.greetingStyle),
    cafePosition: groupCount(rows, (row) => row?.variations?.cafePosition),
    listStyle: groupCount(rows, (row) => row?.variations?.listStyle),
  };
}

function identifyPrimaryWeakness({ categoryStats, patternStats, categoryPatternHotspots, posts }) {
  const generalPosts = posts.filter((post) => post.postType === 'general');
  if (generalPosts.length >= 3 && categoryStats[0] && (categoryStats[0].count / generalPosts.length) >= 0.6) {
    return {
      code: 'category_bias',
      message: `일반 글이 ${categoryStats[0].key} 카테고리에 편중됨`,
    };
  }

  const hotspot = categoryPatternHotspots.find((item) => item.topPattern === 'default' && item.total >= 3 && item.topRatio >= 0.65);
  if (hotspot) {
    return {
      code: 'category_title_pattern_bias',
      message: `${hotspot.category} 카테고리에서 default 제목 패턴 비중이 높음`,
      category: hotspot.category,
      pattern: hotspot.topPattern,
      ratio: hotspot.topRatio,
    };
  }

  if (posts.length >= 4 && patternStats[0] && (patternStats[0].count / posts.length) >= 0.65) {
    return {
      code: 'title_pattern_bias',
      message: `${patternStats[0].key} 제목 패턴 비중이 높음`,
    };
  }

  if (generalPosts.length >= 3 && new Set(generalPosts.map((post) => post.category)).size < 2) {
    return {
      code: 'low_category_diversity',
      message: '일반 글 카테고리 다양성이 부족함',
    };
  }

  return {
    code: 'stable',
    message: '이번 주 전략 분포는 비교적 안정적임',
  };
}

function buildRecommendations({ categoryStats, patternStats, categoryPatternHotspots, variationStats, weakness }) {
  const recommendations = [];

  if (weakness.code === 'category_bias' && categoryStats[0]) {
    recommendations.push(`다음 주 일반 글은 ${categoryStats[0].key} 외 카테고리를 1편 이상 우선 배정하세요.`);
  }

  if (weakness.code === 'category_title_pattern_bias' && weakness.category) {
    recommendations.push(`${weakness.category} 카테고리에서는 default 대신 checklist·experience 패턴을 우선 배정하세요.`);
  }

  if (weakness.code === 'title_pattern_bias' && patternStats[0]) {
    recommendations.push(`${patternStats[0].key} 패턴 대신 체크리스트형·경험형 제목 비중을 늘리세요.`);
  }

  if (variationStats.greeting[0] && variationStats.greeting[0].count >= 3) {
    recommendations.push(`도입부 인사말은 ${variationStats.greeting[0].key} 외 스타일을 다음 실행에서 우선 사용하세요.`);
  }

  if (variationStats.cafePosition[0] && variationStats.cafePosition[0].count >= 3) {
    recommendations.push(`카페 홍보 위치는 ${variationStats.cafePosition[0].key} 대신 다른 위치를 우선 배정하세요.`);
  }

  if (!recommendations.length) {
    recommendations.push('현재 전략을 유지하되, 다음 주에는 제목 패턴과 카테고리만 한 단계씩 바꿔 테스트하세요.');
  }

  const secondaryHotspot = categoryPatternHotspots.find((item) => item.topPattern === 'default' && item.total >= 3);
  if (secondaryHotspot && weakness.code !== 'category_title_pattern_bias') {
    recommendations.push(`${secondaryHotspot.category} 카테고리도 default 제목이 반복돼, 다음 회차엔 패턴을 한 단계 바꿔 검증하는 편이 좋습니다.`);
  }

  return recommendations;
}

async function diagnoseWeeklyPerformance(days = 7) {
  const [posts, executionRows] = await Promise.all([
    Promise.resolve(getRecentOutputPosts(days)),
    getRecentExecutionRows(days),
  ]);

  const categoryStats = summarizeCategoryPerformance(posts);
  const patternStats = summarizeTitlePatterns(posts);
  const categoryPatternHotspots = summarizeCategoryPatternHotspots(posts);
  const variationStats = summarizeVariationUsage(executionRows);
  const weakness = identifyPrimaryWeakness({ categoryStats, patternStats, categoryPatternHotspots, posts });
  const recommendations = buildRecommendations({
    categoryStats,
    patternStats,
    categoryPatternHotspots,
    variationStats,
    weakness,
  });

  return {
    periodDays: days,
    postCount: posts.length,
    executionCount: executionRows.length,
    byCategory: categoryStats,
    byTitlePattern: patternStats,
    byCategoryPattern: categoryPatternHotspots,
    byVariation: variationStats,
    primaryWeakness: weakness,
    recommendations,
    sampledTitles: posts.slice(0, 5).map((post) => ({
      title: post.title,
      category: post.category,
      pattern: detectTitlePattern(post.title),
    })),
  };
}

module.exports = {
  diagnoseWeeklyPerformance,
  detectTitlePattern,
};
