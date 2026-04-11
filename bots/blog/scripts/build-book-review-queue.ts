#!/usr/bin/env node
// @ts-nocheck
'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');
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

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.listOnly) {
    const rows = await listBookReviewQueue({ limit: args.limit, status: args.status });
    if (args.json) {
      console.log(JSON.stringify({ action: 'list', count: rows.length, rows }, null, 2));
      return;
    }
    printRows(rows);
    return;
  }

  const result = await buildBookReviewQueue({ limit: args.limit });
  if (args.json) {
    console.log(JSON.stringify({ action: 'build', ...result }, null, 2));
    return;
  }
  console.log(`[book_queue] ${result.inserted}건 적재, 후보 ${result.scanned}건 스캔`);
  printRows(result.rows || []);
}

main().catch((error) => {
  console.error('[book_queue] 실패:', error?.message || error);
  process.exit(1);
});
