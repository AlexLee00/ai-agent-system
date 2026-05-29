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
    '통계에 따르면 오늘 글은 말단 포맷 오류가 최종 발행을 막는 상황을 재현합니다.',
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
  assert(!/업계 통계|통계에 따르면|조사에 따르면|연구에 따르면/.test(repaired), 'unsupported statistical trigger phrases should be rewritten');
  assert.strictEqual((repaired.slice(-1500).match(/\*\*/g) || []).length % 2, 0, 'bold markers should be balanced');
  assert(
    !after.issues.some((issue) => String(issue.msg).includes('강조 마커'))
      && !after.issues.some((issue) => String(issue.msg).includes('_THE_END_ 이후')),
    'terminal quality issues should be repaired'
  );

  const sourced = [
    '일반 포스팅 제목',
    '',
    'McKinsey 보고서 연구에 따르면 팀 운영 자동화는 반복 업무를 줄이는 데 도움이 됩니다.',
    '',
    '[해시태그]',
    '#블로그 #자동화 #운영',
    '_THE_END_',
    '마감 뒤에 잘못 붙은 본문',
  ].join('\n');
  const sourcedRepaired = repairTerminalQualityArtifacts(sourced);
  assert(sourcedRepaired.includes('McKinsey 보고서 연구에 따르면'), 'sourced statistical phrasing should be preserved');
  assert(!sourcedRepaired.includes('마감 뒤에 잘못 붙은 본문'), 'sourced fixture overflow should still be removed');

  const boldHashtagOverflow = [
    '일반 포스팅 제목',
    '',
    '[AI 스니펫 요약]',
    '해시태그 섹션이 굵은 글씨로 출력된 뒤 본문이 다시 이어지는 상황을 재현합니다.',
    '',
    '**[해시태그]**',
    '#블로그 #자동화 #운영',
    '',
    '**[본론 섹션 2] 뒤늦게 붙은 본문**',
    '이 문단은 해시태그 뒤에 오면 안 됩니다.',
  ].join('\n');
  const boldBefore = await checkQuality(boldHashtagOverflow, 'general');
  assert(
    boldBefore.issues.some((issue) => String(issue.msg).includes('해시태그 이후')),
    'bold hashtag marker overflow should be detected'
  );
  const boldRepaired = repairTerminalQualityArtifacts(boldHashtagOverflow);
  assert(!boldRepaired.includes('뒤늦게 붙은 본문'), 'bold marker overflow should be removed');

  const htmlHashtagOverflow = [
    '<html><body>',
    '<p><strong>[해시태그]</strong></p>',
    '<p class="hashtags"><span class="hashtag">#블로그</span></p>',
    '<h2 class="section-title">본론 섹션 2] 뒤늦게 붙은 본문</h2>',
    '<p>이 문단은 해시태그 뒤에 오면 안 됩니다.</p>',
    '</body></html>',
  ].join('\n');
  const htmlBefore = await checkQuality(htmlHashtagOverflow, 'general');
  assert(
    htmlBefore.issues.some((issue) => String(issue.msg).includes('해시태그 이후')),
    'HTML bold hashtag marker overflow should be detected'
  );

  console.log(JSON.stringify({ ok: true, repairedLength: repaired.length }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
