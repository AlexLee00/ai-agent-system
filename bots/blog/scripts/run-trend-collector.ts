#!/usr/bin/env tsx
// @ts-nocheck
'use strict';
/**
 * 트렌드 수집기 — 매일 06:00 KST 자동 실행 (ai.blog.reddit-trends)
 * 1. Reddit 트렌드 분석 (Python PRAW)
 * 2. 결과를 blog.trend_topics 테이블에 저장
 * 베스트셀러: ai.blog.bestseller-sync (매주 월요일 07:00) 별도 처리
 *
 * 실행: npx tsx bots/blog/scripts/run-trend-collector.ts
 */

const path     = require('path');
const { execFileSync } = require('child_process');
const env      = require('../../../packages/core/lib/env');
const pgPool   = require('../../../packages/core/lib/pg-pool');
const { fetchHubSecrets } = require('../../../packages/core/lib/hub-client');
const {
  buildNaverTrendTopics,
  ensureBlogV3Tables,
  saveTrendTopics,
} = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/blog-v3-unified.ts'));

async function ensureTrendTopicsTable() {
  await ensureBlogV3Tables();
}

async function injectRedditSecrets() {
  try {
    const secrets = await fetchHubSecrets('blog', 3000, { silentStatuses: [404] }).catch(() => null);
    let injected = 0;
    if (secrets?.REDDIT_CLIENT_ID && !process.env.REDDIT_CLIENT_ID) {
      process.env.REDDIT_CLIENT_ID = secrets.REDDIT_CLIENT_ID;
      injected++;
    }
    if (secrets?.REDDIT_CLIENT_SECRET && !process.env.REDDIT_CLIENT_SECRET) {
      process.env.REDDIT_CLIENT_SECRET = secrets.REDDIT_CLIENT_SECRET;
      injected++;
    }
    if (injected === 0 && (!process.env.REDDIT_CLIENT_ID || !process.env.REDDIT_CLIENT_SECRET)) {
      console.log('[트렌드수집] Reddit API 키 미설정 — 선택 소스 reddit 수집을 건너뜁니다');
    }
  } catch (e: any) {
    console.warn('[트렌드수집] Hub 시크릿 로드 실패:', e.message);
  }
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

async function runRedditAnalyzer(options = {}) {
  const scriptPath = path.join(env.PROJECT_ROOT, 'bots/blog/python/reddit_trend_analyzer.py');
  const outputPath = path.join(env.PROJECT_ROOT, 'bots/blog/output/reddit-trends-latest.json');

  if (!options.fixture) {
    await injectRedditSecrets();
  }

  if (!options.fixture && (!process.env.REDDIT_CLIENT_ID || !process.env.REDDIT_CLIENT_SECRET)) {
    console.log('[트렌드수집] Reddit API 키 없음 — 트렌드 수집 건너뜀');
    return { ok: false, status: 'blocked', reason: 'missing_secret:reddit', topics: [] };
  }

  try {
    console.log('[트렌드수집] Reddit 분석기 실행...');
    const pyArgs = [scriptPath];
    if (options.dryRun) pyArgs.push('--dry-run');
    if (options.fixture) pyArgs.push('--fixture');
    if (options.json || options.dryRun) pyArgs.push('--json');
    if (options.fixture) pyArgs.push('--max-llm-calls=0');

    const stdout = execFileSync('python3', pyArgs, {
      env: { ...process.env },
      stdio: options.json || options.dryRun ? ['ignore', 'pipe', 'inherit'] : 'inherit',
      timeout: 120_000,
    });

    const data = (options.json || options.dryRun)
      ? JSON.parse(String(stdout || '{}'))
      : JSON.parse(require('fs').readFileSync(outputPath, 'utf8'));
    return { ok: data.ok !== false, status: data.status || 'ok', reason: data.reason || null, topics: data.topics || [] };
  } catch (e: any) {
    console.warn('[트렌드수집] Reddit 분석기 실패:', e.message);
    return { ok: false, status: 'failed', reason: e.message, topics: [] };
  }
}

async function runNaverTrendCollector(options = {}) {
  if (options.fixture) {
    return { ok: true, status: 'fixture', reason: null, topics: buildNaverTrendTopics() };
  }
  if (process.env.BLOG_SIGNAL_COLLECTOR_ENABLED !== 'true') {
    return { ok: false, status: 'blocked', reason: 'BLOG_SIGNAL_COLLECTOR_ENABLED!=true', topics: [] };
  }
  try {
    const collector = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/signals/naver-trend-collector.ts'));
    const raw = await collector.collectBlogKeywordTrends();
    return { ok: true, status: 'ok', reason: null, topics: buildNaverTrendTopics(raw || []) };
  } catch (e: any) {
    return { ok: false, status: 'failed', reason: e.message, topics: [] };
  }
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

  if (options.source === 'all' || options.source === 'reddit') {
    const reddit = await runRedditAnalyzer(options);
    const saved = await saveTrendTopics(reddit.topics, 'reddit', { dryRun: options.dryRun, addedBy: 'reddit-trend-collector' });
    result.sources.reddit = { ...reddit, ...saved };
    console.log(`[트렌드수집] Reddit 토픽 ${options.dryRun ? '후보' : '저장'}: ${saved.candidates || 0}/${saved.inserted || 0}개`);
  }

  if (options.source === 'all' || options.source === 'naver') {
    const naver = await runNaverTrendCollector(options);
    const saved = await saveTrendTopics(naver.topics, 'naver', { dryRun: options.dryRun, addedBy: 'naver-trend-collector' });
    result.sources.naver = { ...naver, ...saved };
    console.log(`[트렌드수집] Naver 토픽 ${options.dryRun ? '후보' : '저장'}: ${saved.candidates || 0}/${saved.inserted || 0}개`);
  }

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
