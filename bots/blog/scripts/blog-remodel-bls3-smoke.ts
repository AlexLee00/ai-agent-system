#!/usr/bin/env node
// @ts-nocheck
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildItTrendTopics,
  fixtureItTrendItems,
  runItTrendsCollector,
  saveItTrendTopics,
} = require('../lib/it-trends-collector.ts');
const {
  buildBookTrendTopics,
  fixtureBookReviewItems,
  runBookReviewCollector,
  saveBookTrendTopics,
} = require('../lib/book-review-collector.ts');
const {
  calculateTrendFusionScore,
  normalizeSource,
  SOURCE_LABELS,
} = require('../lib/blog-v3-unified.ts');
const {
  appendWritingLearningsSummary,
  buildWritingLearningsPromptBlock,
  loadRecentWritingLearnings,
  learningLineGenre,
} = require('../lib/writing-learnings.ts');
const {
  buildGenreTitlePatternLessons,
} = require('../lib/external-trend-learnings.ts');

function dbRowForTopic(topic, index = 1, source = 'hn') {
  return {
    id: index,
    source,
    topic_ko: topic.topic_ko,
    meta: {
      raw: topic.meta,
    },
    created_at: '2026-07-05T00:00:00.000Z',
  };
}

async function main() {
  const sigma = await import('../../sigma/scripts/runtime-sigma-blog-vault-feed.ts');

  const it = await runItTrendsCollector({ fixture: true, dryRun: true });
  assert.equal(it.genre, 'it');
  assert.ok(it.items.length >= 3, 'IT fixture should collect HN/Naver/dev.to');
  assert.ok(it.items.every((item) => item.genre === 'it'), 'IT items must carry genre=it');
  assert.ok(!it.items.some((item) => /book|도서|서평/i.test(String(item.genre || item.source || ''))), 'IT items must not carry book genre/source');

  const itTopics = buildItTrendTopics(it.items);
  assert.ok(itTopics.length >= 3, 'IT topics missing');
  assert.ok(itTopics.every((topic) => topic.meta.genre === 'it'), 'IT topic meta.raw payload must carry genre=it before save');
  assert.ok(itTopics.every((topic) => topic.is_book_topic === false), 'IT topics must not be book topics');
  const itSaved = await saveItTrendTopics(it.items, { dryRun: true });
  assert.ok(Object.keys(itSaved).length >= 3, 'IT dry-run save should keep source separation');
  assert.ok(Object.values(itSaved).every((item) => item.dryRun === true && item.inserted === 0), 'IT dry-run save must not insert');

  const book = await runBookReviewCollector({ fixture: true, dryRun: true });
  assert.equal(book.genre, 'book');
  assert.ok(book.items.length >= 2, 'book fixture should collect Aladin/Naver review');
  assert.ok(book.items.every((item) => item.genre === 'book'), 'book items must carry genre=book');
  assert.ok(!book.items.some((item) => item.genre === 'it'), 'book items must not carry IT genre');

  const bookTopics = buildBookTrendTopics(book.items);
  assert.ok(bookTopics.length >= 2, 'book topics missing');
  assert.ok(bookTopics.every((topic) => topic.meta.genre === 'book'), 'book topic meta.raw payload must carry genre=book before save');
  assert.ok(bookTopics.every((topic) => topic.is_book_topic === true), 'book topics must be book topics');
  const bookSaved = await saveBookTrendTopics(book.items, { dryRun: true });
  assert.ok(Object.values(bookSaved).every((item) => item.dryRun === true && item.inserted === 0), 'book dry-run save must not insert');

  assert.equal(normalizeSource('hn'), 'hn');
  assert.equal(normalizeSource('dev.to'), 'devto');
  assert.equal(normalizeSource('naver_it'), 'naver_it');
  assert.equal(normalizeSource('aladin_blogbest'), 'aladin_blogbest');
  assert.ok(SOURCE_LABELS.hn.includes('Hacker'), 'HN source label missing');
  assert.ok(calculateTrendFusionScore({ source: 'hn', trend_score: 80, korea_relevance: 75 }).sourceWeight > calculateTrendFusionScore({ source: 'reddit', trend_score: 80, korea_relevance: 75 }).sourceWeight, 'HN should outrank legacy Reddit source');

  const externalRows = [
    dbRowForTopic(itTopics[0], 1, 'hn'),
    dbRowForTopic(bookTopics[0], 2, 'aladin_blogbest'),
  ];
  const candidates = sigma.buildBlogVaultCandidates({ externalTrends: externalRows });
  assert.equal(candidates.length, 2, 'Sigma external trend candidates missing');
  const itCandidate = candidates.find((item) => item.meta.genre === 'it');
  const bookCandidate = candidates.find((item) => item.meta.genre === 'book');
  assert.ok(itCandidate.filePath.includes('/external/it/'), 'IT vault path must be isolated');
  assert.ok(bookCandidate.filePath.includes('/external/book/'), 'book vault path must be isolated');
  assert.ok(itCandidate.tags.includes('genre:it'), 'IT vault tags must include genre:it');
  assert.ok(bookCandidate.tags.includes('genre:book'), 'book vault tags must include genre:book');
  assert.equal(sigma.entryForCandidate(itCandidate).meta.libraryCoords.validation_state, 'unverified');

  const trendLessons = buildGenreTitlePatternLessons([
    ...itTopics.slice(0, 2).map((topic, index) => dbRowForTopic(topic, index + 10, 'hn')),
    ...bookTopics.slice(0, 2).map((topic, index) => dbRowForTopic(topic, index + 20, 'aladin_blogbest')),
  ], { minSamples: 1, threshold: 0.1 });
  assert.ok(trendLessons.some((item) => item.genre === 'it'), 'IT external title lesson missing');
  assert.ok(trendLessons.some((item) => item.genre === 'book'), 'book external title lesson missing');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-bls3-learnings-'));
  const filePath = path.join(dir, 'writing-learnings.md');
  appendWritingLearningsSummary({
    filePath,
    weekKey: '2026-W27',
    lessons: [
      { category: 'IT정보와분석', genre: 'it', axis: 'external_title_pattern', lesson: 'IT 제목은 질문형을 섞어라', title: 'AI 에이전트 질문형' },
      { category: '도서리뷰', genre: 'book', axis: 'external_title_pattern', lesson: '도서 제목은 경험서사형을 섞어라', title: '책을 읽고 남긴 질문' },
    ],
  });
  const itLearnings = loadRecentWritingLearnings({ filePath, category: 'IT정보와분석', genre: 'it' });
  const bookLearnings = loadRecentWritingLearnings({ filePath, category: '도서리뷰', genre: 'book' });
  assert.equal(itLearnings.length, 1, 'IT writer should load only IT learnings');
  assert.equal(bookLearnings.length, 1, 'book writer should load only book learnings');
  assert.equal(learningLineGenre(itLearnings[0]), 'it');
  assert.equal(learningLineGenre(bookLearnings[0]), 'book');
  const itPrompt = await buildWritingLearningsPromptBlock({ filePath, category: 'IT정보와분석', genre: 'it' });
  assert.ok(itPrompt.includes('IT 제목은 질문형'), 'IT prompt must include IT learning');
  assert.ok(!itPrompt.includes('도서 제목'), 'IT prompt must not include book learning');

  console.log(JSON.stringify({
    ok: true,
    it: { collected: it.collected, bySource: it.bySource, sample: it.items.slice(0, 3).map((item) => ({ source: item.source, title: item.title, genre: item.genre })) },
    book: { collected: book.collected, bySource: book.bySource, sample: book.items.slice(0, 3).map((item) => ({ source: item.source, title: item.review_title, genre: item.genre })) },
    sigmaCandidates: candidates.map((item) => ({ sourceKind: item.sourceKind, genre: item.meta.genre, filePath: item.filePath })),
    trendLessons: trendLessons.map((item) => ({ genre: item.genre, topLabel: item.topLabel, count: item.count })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
