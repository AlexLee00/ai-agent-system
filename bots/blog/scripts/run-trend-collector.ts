#!/usr/bin/env tsx
// @ts-nocheck
'use strict';
/**
 * 트렌드 수집기 — 매일 06:00 KST 자동 실행 (ai.blog.reddit-trends)
 * 1. IT 외부 트렌드 수집 (HN/Naver/dev.to)
 * 2. 결과를 blog.trend_topics 테이블에 저장
 * 베스트셀러: ai.blog.bestseller-sync (매주 월요일 07:00) 별도 처리
 *
 * 실행: npx tsx bots/blog/scripts/run-trend-collector.ts
 */

const path     = require('path');
const env      = require('../../../packages/core/lib/env');
const pgPool   = require('../../../packages/core/lib/pg-pool');
const {
  ensureBlogV3Tables,
} = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/blog-v3-unified.ts'));
const {
  runItTrendsCollector,
  saveItTrendTopics,
} = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/it-trends-collector.ts'));

async function ensureTrendTopicsTable() {
  await ensureBlogV3Tables();
}

function parseArgs(argv) {
  const args = new Set(argv.slice(2));
  const sourceArg = argv.find((arg) => arg.startsWith('--source='));
  return {
    dryRun: args.has('--dry-run'),
    json: args.has('--json'),
    fixture: args.has('--fixture'),
    noFail: args.has('--no-fail'),
    source: sourceArg ? sourceArg.split('=')[1] : 'all',
  };
}

function normalizeSourceArg(source = 'all') {
  const value = String(source || 'all').toLowerCase();
  if (value === 'reddit') return 'hn';
  if (value === 'naver') return 'naver_it';
  if (value === 'hackernews' || value === 'hacker_news') return 'hn';
  if (value === 'dev.to' || value === 'dev_to') return 'devto';
  return value;
}

async function main() {
  const options = parseArgs(process.argv);
  console.log(`[트렌드수집] 시작: ${new Date().toISOString()} ${options.dryRun ? '(dry-run)' : ''}`);

  if (!options.dryRun) {
    await ensureTrendTopicsTable();
  }

  const result = {
    ok: true,
    dryRun: options.dryRun,
    shadowMode: true,
    sources: {},
    startedAt: new Date().toISOString(),
  };

  const source = normalizeSourceArg(options.source);
  const it = await runItTrendsCollector({
    ...options,
    source,
    dryRun: options.dryRun,
    save: false,
  });
  const saved = await saveItTrendTopics(it.items, { dryRun: options.dryRun });
  result.sources = Object.fromEntries(Object.entries(saved).map(([key, value]) => [
    key,
    {
      ...(it.sourceStatus[key] || {}),
      ...value,
    },
  ]));
  result.genre = it.genre;
  result.collected = it.collected;
  result.bySource = it.bySource;
  result.sample = it.items.slice(0, 3).map((item) => ({
    source: item.source,
    title: item.title,
    title_pattern: item.title_pattern,
    url: item.url,
    genre: item.genre,
  }));
  console.log(`[트렌드수집] IT 토픽 ${options.dryRun ? '후보' : '저장'}: ${it.collected}개`);

  // 2. 오래된 토픽 정리 (30일 이상)
  // 베스트셀러는 ai.blog.bestseller-sync (매주 월요일 07:00) 에서 별도 처리
  if (!options.dryRun) {
    await pgPool.run('blog', `
      DELETE FROM blog.trend_topics
      WHERE date < CURRENT_DATE - INTERVAL '30 days'
    `).catch(() => {});
  }

  result.finishedAt = new Date().toISOString();
  console.log('[트렌드수집] 완료!');
  if (options.json) console.log(JSON.stringify(result));
  process.exit(0);
}

main().catch(e => {
  console.error('[트렌드수집] 오류:', e.message);
  process.exit(process.argv.includes('--no-fail') ? 0 : 1);
});
