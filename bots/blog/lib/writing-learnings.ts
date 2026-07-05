// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');

const WRITING_LEARNINGS_FORMAT_VERSION = 'blog-remodel-bls1-v1';
const DEFAULT_LEARNINGS_PATH = path.join(env.PROJECT_ROOT, 'bots/blog/docs/writing-learnings.md');

function normalizeLine(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isoWeekKey(date = new Date()) {
  const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = copy.getUTCDay() || 7;
  copy.setUTCDate(copy.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(copy.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((copy - yearStart) / 86400000) + 1) / 7);
  return `${copy.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function learningKeyFor(lesson = {}) {
  return [
    normalizeLine(lesson.category || '전체'),
    normalizeLine(lesson.axis || 'unknown'),
    normalizeLine(lesson.lesson || '').toLowerCase(),
  ].join('|');
}

function summarizeLessonsForAppend(lessons = [], limit = 5) {
  const grouped = new Map();
  for (const lesson of lessons || []) {
    const key = learningKeyFor(lesson);
    if (!key.includes('|') || key.endsWith('|')) continue;
    const category = normalizeLine(lesson.category || '전체') || '전체';
    const existing = grouped.get(key) || {
      axis: normalizeLine(lesson.axis || 'unknown'),
      category,
      lesson: normalizeLine(lesson.lesson || ''),
      count: 0,
      examples: [],
    };
    existing.count += 1;
    if (existing.examples.length < 2 && lesson.title) existing.examples.push(normalizeLine(lesson.title));
    grouped.set(key, existing);
  }
  return [...grouped.values()]
    .sort((left, right) => Number(right.count || 0) - Number(left.count || 0))
    .slice(0, Math.max(1, Number(limit || 5)));
}

function renderLearningsAppendBlock({ lessons = [], generatedAt = new Date(), weekKey = null } = {}) {
  const key = weekKey || isoWeekKey(new Date(generatedAt));
  const topLessons = summarizeLessonsForAppend(lessons, 5);
  const lines = [
    `## ${key} — ${WRITING_LEARNINGS_FORMAT_VERSION}`,
    '',
  ];
  if (!topLessons.length) {
    lines.push('- 이번 주 신규 crank 진단 lesson 없음');
  } else {
    topLessons.forEach((item) => {
      const examples = item.examples.length ? ` / 예: ${item.examples.join(' · ')}` : '';
      lines.push(`- [${item.category || '전체'}] ${item.axis} (${item.count}회): ${item.lesson}${examples}`);
    });
  }
  lines.push('');
  return lines.join('\n');
}

function appendWritingLearningsSummary({ lessons = [], filePath = DEFAULT_LEARNINGS_PATH, generatedAt = new Date(), weekKey = null } = {}) {
  const key = weekKey || isoWeekKey(new Date(generatedAt));
  const marker = `## ${key} — ${WRITING_LEARNINGS_FORMAT_VERSION}`;
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  if (current.includes(marker)) {
    return { ok: true, appended: false, reason: 'already_appended', filePath, weekKey: key };
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const prefix = current.trim() ? `${current.trim()}\n\n` : '# Blog Writing Learnings\n\n';
  fs.writeFileSync(filePath, `${prefix}${renderLearningsAppendBlock({ lessons, generatedAt, weekKey: key })}`, 'utf8');
  return { ok: true, appended: true, filePath, weekKey: key };
}

function loadRecentWritingLearnings({ filePath = DEFAULT_LEARNINGS_PATH, limit = 20, category = null, env: runtimeEnv = process.env } = {}) {
  if (runtimeEnv?.BLOG_LEARNINGS_ENABLED === 'false') return [];
  try {
    if (!fs.existsSync(filePath)) return [];
    const categoryText = normalizeLine(category);
    const lines = fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '));
    return lines
      .filter((line) => !categoryText || line.includes(`[${categoryText}]`) || line.includes('[전체]') || line.includes('[all]'))
      .slice(-Math.max(1, Number(limit || 20)));
  } catch {
    return [];
  }
}

async function buildWritingLearningsPromptBlock(options = {}) {
  const lines = loadRecentWritingLearnings(options);
  if (!lines.length) return '';
  return [
    `[블로그 작법 learnings — ${WRITING_LEARNINGS_FORMAT_VERSION}]`,
    ...lines,
    '위 learnings는 반복 금지/개선 방향으로만 사용하고, 그대로 문장 복붙하지 말라.',
  ].join('\n');
}

module.exports = {
  WRITING_LEARNINGS_FORMAT_VERSION,
  DEFAULT_LEARNINGS_PATH,
  isoWeekKey,
  summarizeLessonsForAppend,
  renderLearningsAppendBlock,
  appendWritingLearningsSummary,
  loadRecentWritingLearnings,
  buildWritingLearningsPromptBlock,
};
