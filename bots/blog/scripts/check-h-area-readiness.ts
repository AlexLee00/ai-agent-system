#!/usr/bin/env tsx
// @ts-nocheck
'use strict';
/**
 * H영역 준비 상태 진단 — Reddit 트렌드 + 베스트셀러 통합
 * 실행: npx tsx bots/blog/scripts/check-h-area-readiness.ts
 */

const path = require('path');
const env = require('../../../packages/core/lib/env');
const pgPool = require('../../../packages/core/lib/pg-pool');
const { fetchHubSecrets } = require('../../../packages/core/lib/hub-client');

type CheckResult = { ok: boolean; label: string; detail: string };

function pass(label: string, detail: string): CheckResult {
  return { ok: true, label, detail };
}
function fail(label: string, detail: string): CheckResult {
  return { ok: false, label, detail };
}

async function checkRedditSecrets(): Promise<CheckResult> {
  const secrets = await fetchHubSecrets('blog').catch(() => null);
  const hasId = !!(secrets?.REDDIT_CLIENT_ID || process.env.REDDIT_CLIENT_ID);
  const hasSecret = !!(secrets?.REDDIT_CLIENT_SECRET || process.env.REDDIT_CLIENT_SECRET);
  if (hasId && hasSecret) return pass('Reddit API 키', '✅ REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET 설정됨');
  const missing = [!hasId && 'REDDIT_CLIENT_ID', !hasSecret && 'REDDIT_CLIENT_SECRET'].filter(Boolean).join(', ');
  return fail('Reddit API 키', `❌ 누락: ${missing}\n     → secrets-store.json blog 섹션에 추가하세요`);
}

async function checkAladinSecret(): Promise<CheckResult> {
  const secrets = await fetchHubSecrets('blog').catch(() => null);
  const hasKey = !!(secrets?.ALADIN_TTB_KEY || process.env.ALADIN_TTB_KEY);
  if (hasKey) return pass('Aladin TTB 키', '✅ ALADIN_TTB_KEY 설정됨');
  return fail('Aladin TTB 키', '❌ 누락: ALADIN_TTB_KEY\n     → secrets-store.json blog 섹션에 추가하세요\n     → 가입: https://www.aladin.co.kr/ttb/wblog_manage.aspx');
}

async function checkPrawInstalled(): Promise<CheckResult> {
  const { execSync } = require('child_process');
  try {
    execSync('python3 -c "import praw"', { stdio: 'pipe', timeout: 10_000 });
    return pass('Python praw 패키지', '✅ praw 설치됨');
  } catch {
    return fail('Python praw 패키지', '❌ praw 미설치\n     → 실행: pip install praw');
  }
}

async function checkTrendTopicsTable(): Promise<CheckResult> {
  try {
    const rows = await pgPool.query('blog', `
      SELECT COUNT(*) as total,
             SUM(CASE WHEN date >= CURRENT_DATE - 7 THEN 1 ELSE 0 END) as recent_7d,
             SUM(CASE WHEN source = 'reddit' THEN 1 ELSE 0 END) as reddit_count,
             SUM(CASE WHEN source = 'bestseller' THEN 1 ELSE 0 END) as bestseller_count
      FROM blog.trend_topics
    `);
    const r = rows[0];
    const total = Number(r.total);
    const recent = Number(r.recent_7d);
    const reddit = Number(r.reddit_count);
    const bestseller = Number(r.bestseller_count);
    const detail = `total:${total} / 최근7일:${recent} / reddit:${reddit} / bestseller:${bestseller}`;
    if (recent === 0) return fail('trend_topics DB', `⚠️  최근 7일 트렌드 없음 (${detail})\n     → API 키 설정 후 수동 실행: npx tsx bots/blog/scripts/run-trend-collector.ts`);
    return pass('trend_topics DB', `✅ ${detail}`);
  } catch (e: any) {
    return fail('trend_topics DB', `❌ 테이블 조회 실패: ${e.message}`);
  }
}

async function checkBookReviewQueue(): Promise<CheckResult> {
  try {
    const rows = await pgPool.query('blog', `
      SELECT status, COUNT(*) as cnt FROM blog.book_review_queue GROUP BY status ORDER BY cnt DESC
    `);
    const summary = rows.map((r: any) => `${r.status}:${r.cnt}`).join(', ');
    const queued = rows.find((r: any) => r.status === 'queued')?.cnt || 0;
    if (Number(queued) === 0) return fail('book_review_queue', `⚠️  대기 중 도서 없음 (${summary})\n     → npx tsx bots/blog/scripts/run-bestseller-sync.ts --dry-run`);
    return pass('book_review_queue', `✅ ${summary}`);
  } catch (e: any) {
    return fail('book_review_queue', `❌ 테이블 조회 실패: ${e.message}`);
  }
}

async function checkLaunchd(): Promise<CheckResult> {
  const { execSync } = require('child_process');
  try {
    const out = execSync('launchctl list 2>/dev/null | grep "ai.blog"', { encoding: 'utf8', timeout: 5_000 });
    const hasReddit = out.includes('ai.blog.reddit-trends');
    const hasBestseller = out.includes('ai.blog.bestseller-sync');
    if (hasReddit && hasBestseller) return pass('launchd', '✅ ai.blog.reddit-trends + ai.blog.bestseller-sync 로드됨');
    const missing = [!hasReddit && 'ai.blog.reddit-trends', !hasBestseller && 'ai.blog.bestseller-sync'].filter(Boolean).join(', ');
    return fail('launchd', `❌ 미로드: ${missing}`);
  } catch {
    return fail('launchd', '❌ launchctl 확인 실패');
  }
}

async function checkTopicSelectorIntegration(): Promise<CheckResult> {
  const selectorPath = path.join(env.PROJECT_ROOT, 'bots/blog/lib/topic-selector.ts');
  const fs = require('fs');
  try {
    const src = fs.readFileSync(selectorPath, 'utf8');
    const hasFetch = src.includes('fetchTrendTopicCandidates');
    const hasTrendTopics = src.includes('trend_topics');
    if (hasFetch && hasTrendTopics) return pass('topic-selector 통합', '✅ fetchTrendTopicCandidates + trend_topics 연동 확인');
    return fail('topic-selector 통합', '❌ topic-selector.ts에 trend_topics 통합 코드 없음');
  } catch (e: any) {
    return fail('topic-selector 통합', `❌ 파일 읽기 실패: ${e.message}`);
  }
}

async function main() {
  console.log('\n🔍 H영역 준비 상태 진단\n' + '='.repeat(50));

  const checks = await Promise.all([
    checkRedditSecrets(),
    checkAladinSecret(),
    checkPrawInstalled(),
    checkTrendTopicsTable(),
    checkBookReviewQueue(),
    checkLaunchd(),
    checkTopicSelectorIntegration(),
  ]);

  let passed = 0;
  let failed = 0;

  for (const c of checks) {
    const icon = c.ok ? '✅' : '❌';
    console.log(`\n${icon} ${c.label}`);
    console.log(`   ${c.detail}`);
    c.ok ? passed++ : failed++;
  }

  console.log('\n' + '='.repeat(50));
  console.log(`결과: ${passed}/${checks.length} 통과`);

  if (failed > 0) {
    console.log('\n📌 다음 단계:');
    console.log('  1. secrets-store.json blog 섹션에 API 키 추가');
    console.log('  2. Reddit: https://www.reddit.com/prefs/apps → create app (script 타입)');
    console.log('  3. Aladin: https://www.aladin.co.kr/ttb/wblog_manage.aspx → TTB 키 발급');
    console.log('  4. 키 추가 후 수동 테스트: npx tsx bots/blog/scripts/run-trend-collector.ts');
    console.log('  5. 베스트셀러 테스트: npx tsx bots/blog/scripts/run-bestseller-sync.ts --dry-run');
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('진단 실패:', e.message);
  process.exit(1);
});
