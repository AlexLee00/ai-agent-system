#!/usr/bin/env node
// @ts-nocheck
/**
 * 매주 일요일 02:00 KST — FinRL-X 주간 학습 실행
 * launchd: ai.luna.finrl-weekly-training.plist
 */

import { runWeeklyFinRLTraining } from '../shared/luna-finrl-orchestrator.ts';
import { maybeSkipForMemory } from '../shared/memory-pressure-guard.ts';

const MARKETS = ['crypto', 'stocks'];

async function main() {
  if (maybeSkipForMemory('luna.finrl-weekly-training')) return;
  const date = new Date().toISOString().split('T')[0];
  console.log(`[FinRLWeekly] ${date} 주간 학습 시작`);

  for (const market of MARKETS) {
    try {
      const result = await runWeeklyFinRLTraining(market);
      console.log(`[FinRLWeekly] ${market}: success=${result.overallSuccess}, ${result.totalDurationMs}ms`);
      if (result.learningReport) {
        const report = result.learningReport as any;
        console.log(`[FinRLWeekly] ${market}: velocity=${report.learningVelocity}, experts=${report.expertAgents?.length}, next=${report.nextWeekFocus}`);
      }
    } catch (err) {
      console.error(`[FinRLWeekly] ${market} 치명 오류:`, err?.message);
    }
  }

  console.log(`[FinRLWeekly] 완료`);
}

main().catch(err => {
  console.error('[FinRLWeekly] 실행 실패:', err?.message);
  process.exit(1);
});
