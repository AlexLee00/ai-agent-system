#!/usr/bin/env node
// @ts-nocheck
/**
 * 매일 06:10 KST — 하네스 자율 조정 실행
 * launchd: ai.luna.harness-daily-0600.plist
 */

import { runHarnessAutoAdjustment } from '../shared/luna-harness-auto-adjustment.ts';
import { maybeSkipForMemory } from '../shared/memory-pressure-guard.ts';

const MARKETS = ['crypto', 'stocks'];
const WRITE_ENABLED = process.env.LUNA_HARNESS_AUTO_ADJUST_WRITE_ENABLED === 'true';

function parseArgs(argv = process.argv.slice(2)) {
  return {
    dryRun: argv.includes('--dry-run') || !WRITE_ENABLED,
    json: argv.includes('--json'),
  };
}

async function main() {
  const options = parseArgs();
  if (maybeSkipForMemory('luna.harness', { json: options.json })) return;

  const date = new Date().toISOString().split('T')[0];
  const prefix = options.dryRun ? '[HarnessDaily][DRY-RUN]' : '[HarnessDaily]';
  console.log(`${prefix} ${date} 시작`);
  if (options.dryRun && !process.argv.includes('--dry-run')) {
    console.log(`${prefix} LUNA_HARNESS_AUTO_ADJUST_WRITE_ENABLED=false — mutation INSERT 생략`);
  }

  const results = [];
  for (const market of MARKETS) {
    try {
      const result = await runHarnessAutoAdjustment(market, { dryRun: options.dryRun, write: !options.dryRun });
      results.push(result);
      console.log(`${prefix} ${market}: ${result.summary}`);

      if (result.configAdjustments.length > 0) {
        console.log(`${prefix} ${market} 조정 제안:`);
        for (const adj of result.configAdjustments) {
          console.log(`  [${adj.severity}] ${adj.paramName}: ${adj.reason}`);
        }
      }
    } catch (err) {
      console.error(`${prefix} ${market} 오류:`, err?.message);
      results.push({ market, error: err?.message || String(err), dryRun: options.dryRun });
    }
  }

  console.log(`${prefix} 완료`);
  if (options.json) {
    console.log(JSON.stringify({ ok: true, dryRun: options.dryRun, writeEnabled: WRITE_ENABLED, results }, null, 2));
  }
}

main().catch(err => {
  console.error('[HarnessDaily] 실행 실패:', err?.message);
  process.exit(1);
});
