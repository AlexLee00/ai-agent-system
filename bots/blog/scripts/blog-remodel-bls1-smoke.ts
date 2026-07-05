#!/usr/bin/env node
// @ts-nocheck
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  WRITING_LEARNINGS_FORMAT_VERSION,
  appendWritingLearningsSummary,
  loadRecentWritingLearnings,
  buildWritingLearningsPromptBlock,
} = require('../lib/writing-learnings.ts');
const {
  selectLowestAxis,
  buildTitlePatternSummary,
  buildCrankDiagnosisLessons,
  buildCrankDiagnosisEventPayload,
  runCrankDiagnoser,
} = require('../lib/crank-diagnoser.ts');
const {
  buildBlogVaultCandidates,
  entryForCandidate,
} = require('../../sigma/scripts/runtime-sigma-blog-vault-feed.ts');

async function main() {
  const rows = [
    { post_id: 1, title: '집중력을 높이는 5가지 방법', category: 'IT정보와분석', post_type: 'general', overall: 50, dia_depth: 30, geo_citation: 40, geo_structure: 55, crank_content: 80 },
    { post_id: 2, title: '앱 이탈을 줄이는 4가지 기준', category: 'IT정보와분석', post_type: 'general', overall: 55, dia_depth: 44, geo_citation: 20, geo_structure: 50, crank_content: 90 },
    { post_id: 3, title: '권한과 안전 설정 3단계', category: 'AI와 자동화', post_type: 'lecture', overall: 56, dia_depth: 45, geo_citation: 25, geo_structure: 60, crank_content: 95 },
  ];

  const lowest = selectLowestAxis(rows[0]);
  assert.equal(lowest.axis, 'dia_depth');
  const titleSummary = buildTitlePatternSummary(rows, { threshold: 0.3 });
  assert.equal(titleSummary.top.key, 'n_list');
  assert.match(titleSummary.lesson, /제목/);

  const lessons = buildCrankDiagnosisLessons(rows, { threshold: 0.3 });
  assert.ok(lessons.some((item) => item.writer === 'pos'), 'lecture should map to pos');
  assert.ok(lessons.some((item) => item.axis === 'title_diversity'), 'title diversity lesson missing');
  const independentTitleLessons = buildCrankDiagnosisLessons([{
    post_id: 7,
    title: '기본형 제목',
    category: 'IT정보와분석',
    post_type: 'general',
    overall: 60,
    dia_depth: 50,
  }], {
    threshold: 0.5,
    titleRows: [
      { title: '업무 자동화 3가지 기준' },
      { title: '성과를 높이는 5가지 방법' },
      { title: '기획 전 확인할 4단계' },
      { title: '운영 점검 2가지' },
    ],
  });
  const titleLesson = independentTitleLessons.find((item) => item.axis === 'title_diversity');
  assert.ok(titleLesson, 'title diversity should use titleRows independent from crank rows');
  assert.equal(titleLesson.titlePatternSummary.total, 4);
  const payload = buildCrankDiagnosisEventPayload(lessons[0]);
  assert.equal(payload.format_version, WRITING_LEARNINGS_FORMAT_VERSION);
  assert.equal(payload.post_id, 1);
  assert.equal(payload.category, 'IT정보와분석');
  assert.ok(payload.lesson);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-learnings-'));
  const filePath = path.join(dir, 'writing-learnings.md');
  const append = appendWritingLearningsSummary({ lessons, filePath, weekKey: '2026-W27' });
  assert.equal(append.appended, true);
  const duplicate = appendWritingLearningsSummary({ lessons, filePath, weekKey: '2026-W27' });
  assert.equal(duplicate.appended, false);
  const loaded = loadRecentWritingLearnings({ filePath, limit: 20 });
  assert.ok(loaded.length > 0);
  const block = await buildWritingLearningsPromptBlock({ filePath, limit: 20, category: 'IT정보와분석' });
  assert.match(block, /blog-remodel-bls1-v1/);
  assert.match(block, /\[IT정보와분석\]/);

  const candidates = buildBlogVaultCandidates({
    posts: [{
      id: 9,
      title: '원본 제목',
      final_title: '최종 제목',
      post_type: 'general',
      category: 'IT정보와분석',
      status: 'published',
      content: '원본 본문',
      final_content_text: '최종 본문\n## 구조 제목\n실제 발행 후 본문입니다.',
      html_content: '<h2>구조 제목</h2><iframe src="about:blank"></iframe>',
      created_at: '2026-07-05T00:00:00.000Z',
      crank_overall: 64,
      crank_total: 70,
      dia_total: 55,
      geo_total: 60,
      crank_scored_date: '2026-07-04',
    }],
  });
  assert.equal(candidates.length, 1);
  assert.match(candidates[0].content, /최종 본문/);
  assert.equal(candidates[0].meta.structure.finalContentUsed, true);
  assert.equal(candidates[0].meta.structure.hasVideo, true);
  assert.equal(candidates[0].meta.crank.overall, 64);
  assert.equal(entryForCandidate(candidates[0]).source, 'blo');

  const runnerResult = await runCrankDiagnoser({
    rows: [rows[0]],
    titleRows: rows,
    write: false,
  });
  assert.equal(runnerResult.rows, 1);
  assert.equal(runnerResult.titleRows, 3);
  assert.ok(runnerResult.lessons.some((item) => item.axis === 'title_diversity'));

  const gemsSource = fs.readFileSync(path.join(__dirname, '../lib/gems-writer.ts'), 'utf8');
  const posSource = fs.readFileSync(path.join(__dirname, '../lib/pos-writer.ts'), 'utf8');
  assert.ok(gemsSource.includes('buildWritingLearningsPromptBlock'));
  assert.ok(posSource.includes('buildWritingLearningsPromptBlock'));

  console.log(JSON.stringify({
    ok: true,
    formatVersion: WRITING_LEARNINGS_FORMAT_VERSION,
    lessons: lessons.length,
    loadedLearnings: loaded.length,
    sigmaMeta: candidates[0].meta.structure,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
