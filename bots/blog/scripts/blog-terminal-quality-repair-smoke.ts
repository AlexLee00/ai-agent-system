#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const {
  checkQuality,
  repairTerminalQualityArtifacts,
} = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/quality-checker.ts'));

async function main() {
  const broken = [
    '일반 포스팅 제목',
    '',
    '[AI 스니펫 요약]',
    '오늘 글은 말단 포맷 오류가 최종 발행을 막는 상황을 재현합니다.',
    '',
    '[해시태그]',
    '#블로그 #자동화 #품질검사',
    '',
    '**닫히지 않은 강조',
    '_THE_END_',
    '마감 뒤에 잘못 붙은 본문',
  ].join('\n');

  const before = await checkQuality(broken, 'general');
  assert(
    before.issues.some((issue) => String(issue.msg).includes('강조 마커'))
      || before.issues.some((issue) => String(issue.msg).includes('_THE_END_ 이후')),
    'fixture should reproduce a terminal quality issue'
  );

  const repaired = repairTerminalQualityArtifacts(broken);
  const after = await checkQuality(repaired, 'general');

  assert(!repaired.includes('_THE_END_'), 'terminal sentinel should be stripped');
  assert(!repaired.includes('마감 뒤에 잘못 붙은 본문'), 'overflow after sentinel should be removed');
  assert.strictEqual((repaired.slice(-1500).match(/\*\*/g) || []).length % 2, 0, 'bold markers should be balanced');
  assert(
    !after.issues.some((issue) => String(issue.msg).includes('강조 마커'))
      && !after.issues.some((issue) => String(issue.msg).includes('_THE_END_ 이후')),
    'terminal quality issues should be repaired'
  );

  console.log(JSON.stringify({ ok: true, repairedLength: repaired.length }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
