#!/usr/bin/env node
// @ts-nocheck
'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');
const {
  listBookCatalog,
  updateBookCatalogEntry,
} = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/skills/blog/book-review-book.js'));

function parseArgs(argv = []) {
  const args = {
    json: argv.includes('--json'),
    limit: 20,
    action: 'list',
    reviewed: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--limit') args.limit = Number(argv[i + 1] || args.limit);
    if (token === '--isbn') args.isbn = argv[i + 1];
    if (token === '--title') args.title = argv[i + 1];
    if (token === '--priority') args.priority = Number(argv[i + 1]);
    if (token === '--category') args.category = argv[i + 1];
    if (token === '--source') args.source = argv[i + 1];
    if (token === '--cover-url') args.coverUrl = argv[i + 1];
    if (token === '--description') args.descriptionSnippet = argv[i + 1];
    if (token === '--recommended-by') args.recommendedBy = argv[i + 1];
    if (token === '--list') args.action = 'list';
    if (token === '--set-priority') args.action = 'set-priority';
    if (token === '--mark-reviewed') args.action = 'mark-reviewed';
    if (token === '--unmark-reviewed') args.action = 'unmark-reviewed';
    if (token === '--update-meta') args.action = 'update-meta';
    if (token === '--reviewed') args.reviewed = true;
    if (token === '--not-reviewed') args.reviewed = false;
  }

  return args;
}

function printRows(rows = []) {
  for (const row of rows) {
    console.log(
      `[book_catalog] ${row.priority} | ${row.reviewed ? 'reviewed' : 'pending'} | ${row.title} | ${row.author} | ${row.isbn || '-'} | ${row.source}`
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.action === 'list') {
    const rows = await listBookCatalog({
      limit: args.limit,
      reviewed: args.reviewed,
      category: args.category,
      source: args.source,
    });
    if (args.json) {
      console.log(JSON.stringify({ action: 'list', count: rows.length, rows }, null, 2));
      return;
    }
    printRows(rows);
    return;
  }

  const payload = {
    isbn: args.isbn,
    title: args.title,
  };

  if (args.action === 'set-priority') payload.priority = args.priority;
  if (args.action === 'mark-reviewed') payload.reviewed = true;
  if (args.action === 'unmark-reviewed') payload.reviewed = false;
  if (args.action === 'update-meta') {
    if (args.category) payload.category = args.category;
    if (args.coverUrl) payload.coverUrl = args.coverUrl;
    if (args.descriptionSnippet) payload.descriptionSnippet = args.descriptionSnippet;
    if (args.recommendedBy) payload.recommendedBy = args.recommendedBy;
  }

  const result = await updateBookCatalogEntry(payload);
  if (args.json) {
    console.log(JSON.stringify({ action: args.action, ...result }, null, 2));
    return;
  }
  console.log(`[book_catalog] ${args.action} ${result.updated ? '완료' : '변경 없음'}${result.id ? ` (id=${result.id})` : ''}`);
}

main().catch((error) => {
  console.error('[book_catalog manage] 실패:', error?.message || error);
  process.exit(1);
});
