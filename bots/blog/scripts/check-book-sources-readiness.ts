'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');
const {
  resolveData4LibraryKey,
  resolveKakaoApiKey,
} = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/news-credentials.legacy.js'));
const {
  searchData4LibraryPopular,
  searchKakaoBook,
  searchOpenLibrary,
} = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/skills/blog/book-review-book.js'));

function parseArgs(argv = []) {
  const args = {
    json: argv.includes('--json'),
    query: '클린 코드',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--query') args.query = argv[i + 1] || args.query;
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const [data4libraryKey, kakaoKey] = await Promise.all([
    resolveData4LibraryKey(),
    resolveKakaoApiKey(),
  ]);

  const [data4libraryResults, kakaoResults, openLibraryResults] = await Promise.all([
    data4libraryKey ? searchData4LibraryPopular({ kdc: '0' }) : Promise.resolve([]),
    kakaoKey ? searchKakaoBook(args.query) : Promise.resolve([]),
    searchOpenLibrary(args.query),
  ]);

  const payload = {
    query: args.query,
    sources: {
      data4library: {
        configured: Boolean(data4libraryKey),
        count: Array.isArray(data4libraryResults) ? data4libraryResults.length : 0,
        note: data4libraryKey
          ? '인증키가 있어도 정보나루는 별도 승인 완료 전까지 결과가 비어 있을 수 있습니다.'
          : '인증키 미등록',
      },
      kakao: {
        configured: Boolean(kakaoKey),
        count: Array.isArray(kakaoResults) ? kakaoResults.length : 0,
      },
      openlibrary: {
        configured: true,
        count: Array.isArray(openLibraryResults) ? openLibraryResults.length : 0,
      },
    },
    ready: {
      phase1: Array.isArray(openLibraryResults) && openLibraryResults.length >= 0,
      phase2KeysPresent: Boolean(data4libraryKey) && Boolean(kakaoKey),
    },
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`[도서 소스 readiness] query=${payload.query}`);
  console.log(`[도서 소스 readiness] data4library configured=${payload.sources.data4library.configured ? 'yes' : 'no'} count=${payload.sources.data4library.count}`);
  console.log(`[도서 소스 readiness] kakao configured=${payload.sources.kakao.configured ? 'yes' : 'no'} count=${payload.sources.kakao.count}`);
  console.log(`[도서 소스 readiness] openlibrary configured=yes count=${payload.sources.openlibrary.count}`);
  console.log(`[도서 소스 readiness] phase1=${payload.ready.phase1 ? 'ready' : 'not-ready'} phase2Keys=${payload.ready.phase2KeysPresent ? 'ready' : 'missing'}`);
  if (payload.sources.data4library.note) {
    console.log(`[도서 소스 readiness] note=${payload.sources.data4library.note}`);
  }
}

main().catch((error) => {
  console.error('[도서 소스 readiness] 실패:', error?.message || error);
  process.exit(1);
});
