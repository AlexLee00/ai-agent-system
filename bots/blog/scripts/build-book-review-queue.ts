#!/usr/bin/env node
'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');
const { buildBlogCliInsight } = require('../lib/cli-insight.ts');
const {
  buildBookReviewQueue,
  listBookReviewQueue,
} = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/skills/blog/book-review-book.js'));

function parseArgs(argv = []) {
  const args = {
    json: argv.includes('--json'),
    listOnly: argv.includes('--list'),
    limit: 5,
    status: 'queued',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--limit') args.limit = Number(argv[i + 1] || args.limit);
    if (token === '--status') args.status = String(argv[i + 1] || args.status);
  }

  return args;
}

function printRows(rows = []) {
  for (const row of rows) {
    console.log(
      `[book_queue] ${row.priority} | ${row.status} | ${row.category} | ${row.title} | ${row.author} | ${row.isbn || '-'}`
    );
  }
}

function buildBookQueueFallback(payload = {}) {
  // @ts-ignore checkJs default-param inference is too narrow here
  if (payload.action === 'list') {
    // @ts-ignore checkJs default-param inference is too narrow here
    if (Number(payload.count || 0) === 0) return '현재 대기 중인 도서 리뷰 큐가 없어, 신규 적재나 상태 점검이 필요합니다.';
    // @ts-ignore checkJs default-param inference is too narrow here
    return `도서 리뷰 큐 ${payload.count || 0}건이 대기 중이며, 우선순위 상단 항목부터 순차 처리하면 됩니다.`;
  }
  // @ts-ignore checkJs default-param inference is too narrow here
  if (Number(payload.inserted || 0) > 0) {
    // @ts-ignore checkJs default-param inference is too narrow here
    return `도서 리뷰 후보를 ${payload.inserted || 0}건 적재해, 다음 리뷰 파이프라인 입력이 확보됐습니다.`;
  }
  // @ts-ignore checkJs default-param inference is too narrow here
  return `새로 적재된 도서 리뷰 후보는 없고, 기존 큐 ${payload.count || 0}건 상태를 유지하면 됩니다.`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.listOnly) {
    const rows = await listBookReviewQueue({ limit: args.limit, status: args.status });
    const aiSummary = await buildBlogCliInsight({
      bot: 'book-review-queue',
      requestType: 'book-review-queue-list',
      title: '도서 리뷰 큐 목록',
      data: {
        action: 'list',
        count: rows.length,
        status: args.status,
        limit: args.limit,
        rows: rows.slice(0, 5),
      },
      fallback: buildBookQueueFallback({ action: 'list', count: rows.length }),
    });
    if (args.json) {
      console.log(JSON.stringify({ action: 'list', count: rows.length, rows, aiSummary }, null, 2));
      return;
    }
    console.log(`🔍 AI: ${aiSummary}`);
    printRows(rows);
    return;
  }

  const result = await buildBookReviewQueue({ limit: args.limit });
  const aiSummary = await buildBlogCliInsight({
    bot: 'book-review-queue',
    requestType: 'book-review-queue-build',
    title: '도서 리뷰 큐 생성',
    data: {
      action: 'build',
      limit: args.limit,
      inserted: result.inserted,
      scanned: result.scanned,
      rows: (result.rows || []).slice(0, 5),
    },
    fallback: buildBookQueueFallback({
      action: 'build',
      inserted: result.inserted,
      scanned: result.scanned,
      count: (result.rows || []).length,
    }),
  });
  if (args.json) {
    console.log(JSON.stringify({ action: 'build', ...result, aiSummary }, null, 2));
    return;
  }
  console.log(`🔍 AI: ${aiSummary}`);
  console.log(`[book_queue] ${result.inserted}건 적재, 후보 ${result.scanned}건 스캔`);
  printRows(result.rows || []);
}

main().catch((error) => {
  console.error('[book_queue] 실패:', error?.message || error);
  process.exit(1);
});
