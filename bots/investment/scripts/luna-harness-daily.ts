#!/usr/bin/env node
// @ts-nocheck
/**
 * 매일 06:10 KST — 하네스 자율 조정 실행
 * launchd: ai.luna.harness-daily-0600.plist
 */

import { runHarnessAutoAdjustment } from '../shared/luna-harness-auto-adjustment.ts';

const MARKETS = ['crypto', 'stocks'];

async function main() {
  const date = new Date().toISOString().split('T')[0];
  console.log(`[HarnessDaily] ${date} 시작`);

  for (const market of MARKETS) {
    try {
      const result = await runHarnessAutoAdjustment(market);
      console.log(`[HarnessDaily] ${market}: ${result.summary}`);

      if (result.configAdjustments.length > 0) {
        console.log(`[HarnessDaily] ${market} 조정 제안:`);
        for (const adj of result.configAdjustments) {
          console.log(`  [${adj.severity}] ${adj.paramName}: ${adj.reason}`);
        }
      }
    } catch (err) {
      console.error(`[HarnessDaily] ${market} 오류:`, err?.message);
    }
  }

  console.log(`[HarnessDaily] 완료`);
}

main().catch(err => {
  console.error('[HarnessDaily] 실행 실패:', err?.message);
  process.exit(1);
});
