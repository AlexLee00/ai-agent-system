'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');
const {
  resolveData4LibraryKey,
} = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/news-credentials.legacy.js'));
const {
  searchData4LibraryPopular,
  syncPopularBooksToCatalog,
} = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/skills/blog/book-review-book.js'));

function parseArgs(argv = []) {
  const args = {
    json: argv.includes('--json'),
    dryRun: argv.includes('--dry-run'),
    kdc: '0',
    limit: 10,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--kdc') args.kdc = argv[i + 1] || args.kdc;
    if (token === '--limit') {
      const parsed = Number(argv[i + 1]);
      if (Number.isFinite(parsed) && parsed > 0) {
        args.limit = Math.min(parsed, 20);
      }
    }
  }

  return args;
}

function summarizeBooks(books = [], limit = 10) {
  return books.slice(0, limit).map((book, index) => ({
    rank: index + 1,
    title: book.title || '',
    author: book.author || '',
    isbn: book.isbn || '',
    loanCount: Number(book.loanCount || 0),
    source: book.source || 'data4library',
  }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const data4libraryKey = await resolveData4LibraryKey();

  if (!data4libraryKey) {
    const payload = {
      ok: false,
      reason: 'missing_data4library_key',
      note: '정보나루 인증키가 없거나 읽히지 않습니다.',
    };
    if (args.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log('[book_catalog sync] 정보나루 인증키가 없습니다.');
    return;
  }

  if (args.dryRun) {
    const popular = await searchData4LibraryPopular({ kdc: args.kdc });
    const payload = {
      ok: true,
      dryRun: true,
      kdc: args.kdc,
      scanned: Array.isArray(popular) ? popular.length : 0,
      preview: summarizeBooks(popular, args.limit),
      note: '정보나루는 승인 완료 전까지 결과가 비어 있을 수 있습니다.',
    };

    if (args.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(`[book_catalog sync] dry-run scanned=${payload.scanned} kdc=${payload.kdc}`);
    if (payload.note) console.log(`[book_catalog sync] note=${payload.note}`);
    for (const item of payload.preview) {
      console.log(`[book_catalog sync] #${item.rank} ${item.title} | ${item.author} | loan=${item.loanCount}`);
    }
    return;
  }

  const result = await syncPopularBooksToCatalog({ kdc: args.kdc });
  const payload = {
    ok: true,
    dryRun: false,
    kdc: args.kdc,
    scanned: Number(result?.scanned || 0),
    inserted: Number(result?.inserted || 0),
    note: '정보나루는 승인 완료 전까지 결과가 비어 있을 수 있습니다.',
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`[book_catalog sync] inserted=${payload.inserted} scanned=${payload.scanned} kdc=${payload.kdc}`);
  if (payload.note) console.log(`[book_catalog sync] note=${payload.note}`);
}

main().catch((error) => {
  console.error('[book_catalog sync] 실패:', error?.message || error);
  process.exit(1);
});
