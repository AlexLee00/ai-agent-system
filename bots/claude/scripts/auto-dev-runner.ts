// @ts-nocheck
'use strict';

/**
 * scripts/auto-dev-runner.ts — docs/auto_dev 자동 구현 파이프라인 실행기
 */

process.env.PG_DIRECT = process.env.PG_DIRECT || 'true';

const pipeline = require('../lib/auto-dev-pipeline');

const args = process.argv.slice(2);
const once = args.includes('--once');
const test = args.includes('--test');
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runOnce() {
  const result = await pipeline.runAutoDevPipeline({ once, test, dryRun, force });
  console.log(JSON.stringify({
    ok: result.ok,
    count: result.count,
    docs: result.results.map(item => ({
      ok: item.ok,
      skipped: item.skipped,
      relPath: item.job?.relPath,
      stage: item.job?.stage,
      error: item.error,
    })),
  }, null, 2));
  return result;
}

async function main() {
  const enabled = process.env.CLAUDE_AUTO_DEV_ENABLED === 'true' || once || test;
  if (!enabled) {
    console.log('[auto-dev] Kill Switch OFF — CLAUDE_AUTO_DEV_ENABLED=true 설정 필요');
    return;
  }

  if (once || test) {
    const result = await runOnce();
    process.exit(result.ok ? 0 : 1);
  }

  const intervalMs = Number(process.env.CLAUDE_AUTO_DEV_INTERVAL_MS || 5 * 60 * 1000);
  console.log(`[auto-dev] 시작 — docs/auto_dev 감시 (${intervalMs}ms)`);

  while (true) {
    await runOnce();
    await sleep(intervalMs);
  }
}

main().catch(error => {
  console.error('[auto-dev] Fatal:', error.message);
  process.exit(1);
});
