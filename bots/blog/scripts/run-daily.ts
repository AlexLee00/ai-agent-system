#!/usr/bin/env node
'use strict';

/**
 * 블로그팀 일간 실행 스크립트
 * launchd 또는 수동 실행
 *
 * 실행: node bots/blog/scripts/run-daily.ts
 */

const { initHubConfig } = require('../../../packages/core/lib/llm-keys');
const { run } = require('../lib/blo.ts');

const dryRun = process.argv.includes('--dry-run');
const verifyOnly = process.argv.includes('--verify');
const phase1FastDryRun =
  process.argv.includes('--phase1-fast-dry-run')
  || process.env.BLOG_PHASE1_FAST_DRY_RUN === '1';
const json = process.argv.includes('--json');

initHubConfig()
  .then(() => run({ dryRun, verifyOnly, phase1FastDryRun }))
  .then((results) => {
    if (json) {
      console.log(JSON.stringify({ dryRun, verifyOnly, phase1FastDryRun, results }, null, 2));
      process.exit(0);
    }

    const ok = results.filter((r) => !r.error && !r.skipped).length;
    const err = results.filter((r) => r.error).length;
    const modeLabel = verifyOnly ? 'verify' : (dryRun ? 'dry-run' : 'live');
    console.log(`\n완료[${modeLabel}]: ✅${ok}편 생성, ❌${err}편 실패`);
    process.exit(0);
  })
  .catch((e) => {
    console.error('❌ 블로그팀 실행 실패:', e.message);
    process.exit(1);
  });
