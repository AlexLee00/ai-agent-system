#!/usr/bin/env tsx
// @ts-nocheck
'use strict';
/**
 * 베스트셀러 동기화 — 매주 월요일 07:00 KST 자동 실행
 * 알라딘 Open API로 베스트셀러 수집 후 blog.book_review_queue에 추가.
 *
 * 실행: npx tsx bots/blog/scripts/run-bestseller-sync.ts [--dry-run]
 */

const path = require('path');
const env  = require('../../../packages/core/lib/env');

async function main() {
  console.log(`[베스트셀러동기화] 시작: ${new Date().toISOString()}`);

  const dryRun = process.argv.includes('--dry-run');
  const { runBestsellerFetch } = require(
    path.join(env.PROJECT_ROOT, 'bots/blog/lib/bestseller-fetcher.ts')
  );

  const result = await runBestsellerFetch({ dryRun });
  console.log(`[베스트셀러동기화] 완료 — 원본:${result.total} 필터:${result.filtered} 추가:${result.inserted}`);

  process.exit(0);
}

main().catch(e => {
  console.error('[베스트셀러동기화] 오류:', e.message);
  process.exit(1);
});
