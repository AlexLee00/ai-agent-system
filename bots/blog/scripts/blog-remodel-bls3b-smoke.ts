#!/usr/bin/env node
// @ts-nocheck
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const env = require('../../../packages/core/lib/env');
const bookReviewBook = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/skills/blog/book-review-book.js'));

async function withMockPg(mock, fn) {
  const restore = bookReviewBook.setBookReviewQueuePgForTest({
    run: mock.run || (async () => ({ rowCount: 0 })),
    get: mock.get || (async () => null),
    query: mock.query || (async () => []),
  });
  try {
    return await fn();
  } finally {
    restore();
  }
}

async function testUpsertDedupeUpdateOnly() {
  const sqls = [];
  const result = await withMockPg({
    query: async (schema, sql) => {
      if (sql.includes('FROM blog.book_review_queue') && sql.includes('WHERE isbn')) {
        return [{ id: 42, title: '클린 코드', isbn: '9788966260959', status: 'queued', metadata: { existing: true } }];
      }
      return [];
    },
    run: async (schema, sql) => {
      sqls.push(sql);
      return { rowCount: sql.includes('UPDATE blog.book_review_queue') ? 1 : 0 };
    },
  }, () => bookReviewBook.upsertBookReviewQueueEntry({
    title: '클린 코드',
    author: '로버트 마틴',
    isbn: '978-89-6626-095-9',
    priority: 80,
    source: 'canonical',
  }));

  assert.equal(result.inserted, false, 'duplicate ISBN must not insert');
  assert.equal(result.updated, true, 'duplicate ISBN should update priority/meta');
  assert.ok(sqls.some((sql) => sql.includes('UPDATE blog.book_review_queue')), 'update SQL missing');
  assert.ok(!sqls.some((sql) => sql.includes('INSERT INTO blog.book_review_queue')), 'duplicate path must not insert');
}

async function testUpsertDoesNotMutateConsumedRows() {
  const sqls = [];
  const result = await withMockPg({
    query: async (schema, sql) => {
      if (sql.includes('FROM blog.book_review_queue') && sql.includes('WHERE isbn')) {
        return [{ id: 77, title: '아몬드', isbn: '9791190090018', status: 'done', metadata: { done_at: '2026-07-05T00:00:00.000Z' } }];
      }
      return [];
    },
    run: async (schema, sql) => {
      sqls.push(sql);
      return { rowCount: 0 };
    },
  }, () => bookReviewBook.upsertBookReviewQueueEntry({
    title: '아몬드',
    author: '손원평',
    isbn: '9791190090018',
    priority: 100,
    source: 'bestseller',
  }));

  assert.equal(result.inserted, false, 'done duplicate must not insert');
  assert.equal(result.updated, false, 'done duplicate must not mutate historical row');
  assert.equal(result.reason, 'existing_done');
  assert.ok(!sqls.some((sql) => sql.includes('UPDATE blog.book_review_queue')), 'done duplicate path must not update');
}

async function testDoneMarkingPrefersSelectedRow() {
  const updatedIds = [];
  await withMockPg({
    query: async (schema, sql) => {
      if (sql.includes('FROM blog.book_review_queue') && sql.includes('WHERE isbn')) {
        return [
          { id: 10, title: '클린 코드', isbn: '9788966260959', status: 'queued', queue_date: '2026-07-05', metadata: {} },
          { id: 20, title: '클린 코드', isbn: '9788966260959', status: 'selected', queue_date: '2026-07-04', metadata: { selected_at: '2026-07-04T00:00:00.000Z' } },
        ];
      }
      return [];
    },
    run: async (schema, sql, params = []) => {
      if (sql.includes('UPDATE blog.book_review_queue')) updatedIds.push(params[params.length - 1]);
      return { rowCount: 1 };
    },
  }, () => bookReviewBook.updateBookReviewQueueEntry({
    isbn: '9788966260959',
    title: '클린 코드',
    status: 'done',
    postId: 456,
    note: 'smoke_done_selected_priority',
  }));

  assert.deepEqual(updatedIds, [20], 'done transition must update the selected row before queued duplicates');
}

async function testQueueMarkingTransitions() {
  const metadataWrites = [];
  await withMockPg({
    query: async () => [
      { id: 11, title: '공부머리 독서법', status: 'queued', metadata: {} },
    ],
    run: async (schema, sql, params = []) => {
      if (sql.includes('UPDATE blog.book_review_queue') && params.some((param) => String(param || '').includes('selected_at'))) {
        metadataWrites.push(JSON.parse(params.find((param) => String(param || '').includes('selected_at'))));
      }
      return { rowCount: sql.includes('UPDATE blog.book_review_queue') ? 1 : 0 };
    },
  }, () => bookReviewBook.updateBookReviewQueueEntry({
    title: '공부머리 독서법',
    status: 'selected',
    note: 'smoke_selected',
  }));

  await withMockPg({
    query: async () => [
      { id: 11, title: '공부머리 독서법', status: 'selected', metadata: { selected_at: '2026-07-05T00:00:00.000Z' } },
    ],
    run: async (schema, sql, params = []) => {
      if (sql.includes('UPDATE blog.book_review_queue') && params.some((param) => String(param || '').includes('done_at'))) {
        metadataWrites.push(JSON.parse(params.find((param) => String(param || '').includes('done_at'))));
      }
      return { rowCount: sql.includes('UPDATE blog.book_review_queue') ? 1 : 0 };
    },
  }, () => bookReviewBook.updateBookReviewQueueEntry({
    title: '공부머리 독서법',
    status: 'done',
    postId: 123,
    note: 'smoke_done',
  }));

  assert.ok(metadataWrites[0].selected_at, 'selected transition must stamp selected_at');
  assert.ok(metadataWrites[1].done_at, 'done transition must stamp done_at');
  assert.equal(metadataWrites[1].postId, 123, 'done transition must preserve post id');
}

function testCleanupDryPlan() {
  const plan = bookReviewBook.buildBookReviewQueueCleanupPlan([
    { id: 1, title: '클린 코드', isbn: '9788966260959', status: 'queued', created_at: '2026-07-05T00:00:00Z' },
    { id: 2, title: 'Clean Code', isbn: '9788966260959', status: 'queued', created_at: '2026-07-06T00:00:00Z' },
    { id: 3, title: '공부머리 독서법', isbn: '', status: 'queued', created_at: '2026-07-05T00:00:00Z' },
    { id: 4, title: '공부머리 독서법', isbn: '', status: 'queued', created_at: '2026-07-04T00:00:00Z' },
  ]);
  assert.equal(plan.duplicateRows, 2, 'cleanup plan should detect duplicate rows');
  assert.ok(plan.groups.some((group) => group.keepId === 2 && group.duplicateIds.includes(1)), 'ISBN duplicate should keep newest row');
  assert.ok(plan.groups.some((group) => group.keepId === 3 && group.duplicateIds.includes(4)), 'title duplicate should keep newest row');
}

function testBalancedSeeds() {
  const seeds = bookReviewBook.buildBalancedBookReviewSeeds({
    queuedBooks: [
      { id: 1, title: '공부머리 독서법', author: '최승필', priority: 99, source: 'queue' },
      { id: 2, title: '공부머리 독서법', author: '최승필', priority: 98, source: 'queue' },
      { id: 3, title: '클린 코드', author: '로버트 마틴', isbn: '9788966260959', priority: 97, source: 'queue' },
      { id: 4, title: '함께 자라기', author: '김창준', priority: 96, source: 'queue' },
    ],
    catalogBooks: [
      { title: '공부머리 독서법', author: '최승필', category: '자기계발', priority: 90 },
      { title: '사피엔스', author: '유발 하라리', category: '인문학', priority: 89 },
      { title: '아몬드', author: '손원평', category: '소설', priority: 88 },
      { title: '소프트웨어 장인', author: '산드로 만쿠소', category: 'IT', priority: 87 },
    ],
    reviewedHistory: [],
  });
  assert.equal(seeds.length, 6, 'seed list should fill 6 items');
  assert.equal(seeds.filter((seed) => seed.fromQueue === true).length, 3, 'seed list should use top 3 unique queue items');
  assert.equal(seeds.filter((seed) => seed.title === '공부머리 독서법').length, 1, 'seed list must dedupe repeated queue/catalog title');
}

async function testReviewDemandScore() {
  const demand = await bookReviewBook.fetchNaverBookReviewDemand('클린 코드', {
    credentials: { clientId: 'id', clientSecret: 'secret' },
    fetchJson: async () => ({ total: 1234, items: [] }),
    weight: 5,
  });
  assert.equal(demand.total, 1234, 'Naver blog total should be parsed');
  assert.ok(demand.boost > 0, 'review demand should add positive boost');

  const enriched = await bookReviewBook.enrichBooksWithReviewDemand([
    { title: '클린 코드', priority: 50 },
  ], {
    credentials: { clientId: 'id', clientSecret: 'secret' },
    fetchJson: async () => ({ total: 9999, items: [] }),
    delayMs: 0,
  });
  assert.ok(enriched[0].priority > 50, 'review demand boost should affect priority');
  assert.equal(enriched[0].reviewDemand.total, 9999, 'review demand metadata missing');
}

async function main() {
  await testUpsertDedupeUpdateOnly();
  await testUpsertDoesNotMutateConsumedRows();
  await testDoneMarkingPrefersSelectedRow();
  await testQueueMarkingTransitions();
  testCleanupDryPlan();
  testBalancedSeeds();
  await testReviewDemandScore();
  console.log(JSON.stringify({
    ok: true,
    checks: [
      'queue_upsert_dedupe_update_only',
      'queue_upsert_consumed_no_mutation',
      'done_marking_prefers_selected_row',
      'queue_selected_done_marking',
      'cleanup_dry_plan',
      'balanced_seed_3_plus_3',
      'naver_review_demand_score',
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
