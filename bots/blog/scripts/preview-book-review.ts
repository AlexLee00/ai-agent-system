#!/usr/bin/env node
// @ts-nocheck
'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');
const { blog: blogSkills } = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/skills/index.js'));

function parseArgs(argv = []) {
  const args = {
    json: argv.includes('--json'),
    topic: '일과 삶을 함께 돌아보게 만드는 책',
    limit: 6,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--topic') args.topic = argv[i + 1] || args.topic;
    if (token === '--limit') {
      const parsed = Number(argv[i + 1]);
      if (Number.isFinite(parsed) && parsed > 0) args.limit = Math.min(parsed, 12);
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const [catalogBooks, reviewedHistory] = await Promise.all([
    blogSkills.bookReviewBook.loadCatalogBooks(),
    blogSkills.bookReviewBook.loadReviewedBookHistory(),
  ]);

  const preferredBooks = blogSkills.bookReviewBook.buildDiversePreferredBooks(
    catalogBooks,
    args.limit,
    reviewedHistory,
  );

  const selected = await blogSkills.bookReviewBook.resolveBookForReview({
    topic: args.topic,
    keywords: [
      '인문학',
      '요즘 많이 읽는 책',
      '삶을 돌아보는 책',
      '베스트셀러 소설',
      ...preferredBooks.map((book) => [book.title, book.author].filter(Boolean).join(' ')),
    ],
    preferredBooks,
  });

  const payload = {
    topic: args.topic,
    reviewedHistoryCount: Array.isArray(reviewedHistory) ? reviewedHistory.length : 0,
    preferredBooks: preferredBooks.map((book) => ({
      title: book.title,
      author: book.author,
      category: book.category,
      priority: book.priority,
      source: book.source,
    })),
    selected,
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`[book-review preview] topic=${payload.topic}`);
  console.log(`[book-review preview] reviewedHistory=${payload.reviewedHistoryCount}`);
  for (const book of payload.preferredBooks) {
    console.log(`[book-review preview] preferred ${book.category} | ${book.priority} | ${book.title} | ${book.author}`);
  }
  if (payload.selected?.title) {
    console.log(`[book-review preview] selected=${payload.selected.title} | ${payload.selected.author} | ${payload.selected.source}`);
  } else {
    console.log('[book-review preview] selected=none');
  }
}

main().catch((error) => {
  console.error('[book-review preview] 실패:', error?.message || error);
  process.exit(1);
});
