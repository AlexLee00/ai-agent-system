#!/usr/bin/env node
'use strict';

const { buildRetiredFeatureResult } = require('../lib/retirement-policy.ts');

async function main() {
  const retired = buildRetiredFeatureResult('facebook-publishing');
  if (process.argv.includes('--json')) console.log(JSON.stringify(retired, null, 2));
  else console.log('[facebook] 블로팀 SNS 발행 기능이 은퇴되어 실행하지 않습니다.');
  return retired;
}

main().catch((error) => {
  console.error('[facebook] 은퇴 상태 확인 실패:', error?.message || error);
  process.exitCode = 1;
});
