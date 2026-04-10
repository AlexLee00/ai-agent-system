#!/usr/bin/env node
// @ts-nocheck
'use strict';

const { diagnoseWeeklyPerformance } = require('../lib/performance-diagnostician');
const { evolveStrategy } = require('../lib/strategy-evolver');

const dryRun = process.argv.includes('--dry-run');
const json = process.argv.includes('--json');

async function main() {
  console.log('\n📊 [블로] 주간 전략 진화 시작');
  if (dryRun) {
    console.log('[블로][dry-run] 전략 파일 저장 없이 진단만 실행');
  }

  const diagnosis = await diagnoseWeeklyPerformance(7);
  const evolution = await evolveStrategy(diagnosis, { dryRun });

  const result = {
    dryRun,
    diagnosis,
    evolution,
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`[블로] 주간 진단: 최근 포스트 ${diagnosis.postCount}건 / 실행 이력 ${diagnosis.executionCount}건`);
  console.log(`[블로] 주요 약점: ${diagnosis.primaryWeakness?.message || '없음'}`);
  console.log(`[블로] 다음 주 초점: ${(evolution.plan?.focus || []).join(' | ')}`);
}

main().catch((error) => {
  console.error('❌ 주간 전략 진화 실패:', error.message);
  process.exit(1);
});
