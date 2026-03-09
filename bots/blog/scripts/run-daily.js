#!/usr/bin/env node
'use strict';

/**
 * 블로그팀 일간 실행 스크립트
 * launchd 또는 수동 실행
 *
 * 실행: node bots/blog/scripts/run-daily.js
 */

const { run } = require('../lib/blo');

run()
  .then(results => {
    const ok  = results.filter(r => !r.error && !r.skipped).length;
    const err = results.filter(r => r.error).length;
    console.log(`\n완료: ✅${ok}편 생성, ❌${err}편 실패`);
    process.exit(0);
  })
  .catch(e => {
    console.error('❌ 블로그팀 실행 실패:', e.message);
    process.exit(1);
  });
