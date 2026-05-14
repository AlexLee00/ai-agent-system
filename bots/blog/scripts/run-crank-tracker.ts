#!/usr/bin/env tsx
// @ts-nocheck
'use strict';
/**
 * C-Rank 점수 추적기 실행 스크립트 — 매일 07:30 KST 자동 실행 (ai.blog.crank-tracker)
 *
 * 1. 최근 14일 발행 포스팅의 SEO 점수 계산 (C-Rank + D.I.A.+ + GEO)
 * 2. blog.crank_scores 테이블에 저장
 * 3. ±10점 이상 변화 시 텔레그램 알림
 *
 * 실행: npx tsx bots/blog/scripts/run-crank-tracker.ts [--dry-run]
 */

const path = require('path');
const env = require('../../../packages/core/lib/env');
const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');
const { runCrankTracker, formatCrankReport } = require(
  path.join(env.PROJECT_ROOT, 'bots/blog/lib/crank-score-tracker.ts')
);

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`[크랭크트래커] 시작: ${new Date().toISOString()} ${dryRun ? '(dry-run)' : ''}`);

  const result = await runCrankTracker(14, { dryRun });
  const report = await formatCrankReport(result);

  console.log('[크랭크트래커]', report);

  if (!dryRun && result.alerts.length > 0) {
    await postAlarm({
      message: report,
      team: 'blog',
      bot: 'crank-tracker',
      level: 'info',
    }).catch((e: any) => console.warn('[크랭크트래커] 알람 전송 실패:', e.message));
  }

  console.log('[크랭크트래커] 완료!');
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({
      ok: true,
      dryRun,
      shadowMode: true,
      processed: result.processed,
      alerts: result.alerts,
      summary: result.summary,
    }));
  }
  process.exit(0);
}

main().catch(e => {
  console.error('[크랭크트래커] 오류:', e.message);
  process.exit(1);
});
