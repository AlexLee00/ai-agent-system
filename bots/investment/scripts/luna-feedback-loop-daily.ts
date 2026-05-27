#!/usr/bin/env node
// @ts-nocheck
/**
 * 매일 06:00 KST — Closed-loop 일간 피드백 루프
 * launchd: ai.luna.feedback-loop-daily-0600.plist
 */

import { runDailyFeedbackLoop } from '../shared/luna-feedback-loop-orchestrator.ts';

const MARKETS = ['crypto', 'stocks'];

async function main() {
  const date = new Date().toISOString().split('T')[0];
  console.log(`[FeedbackLoopDaily] ${date} 시작`);

  for (const market of MARKETS) {
    try {
      const result = await runDailyFeedbackLoop(market);
      console.log(`[FeedbackLoopDaily] ${market}: mutations=${result.mutationsGenerated}, curriculum=${result.curriculumUpdated}, resource=${result.resourceFeedbackAnalyzed}`);
      if (result.errors.length > 0) {
        console.warn(`[FeedbackLoopDaily] ${market} 오류:`, result.errors.join(', '));
      }
    } catch (err) {
      console.error(`[FeedbackLoopDaily] ${market} 치명 오류:`, err?.message);
    }
  }

  console.log(`[FeedbackLoopDaily] 완료`);
}

main().catch(err => {
  console.error('[FeedbackLoopDaily] 실행 실패:', err?.message);
  process.exit(1);
});
