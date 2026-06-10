#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const {
  checkQuality,
  repairTerminalQualityArtifacts,
} = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/quality-checker.ts'));

type QualityIssue = {
  msg?: unknown;
};

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
    before.issues.some((issue: QualityIssue) => String(issue.msg).includes('강조 마커'))
      || before.issues.some((issue: QualityIssue) => String(issue.msg).includes('_THE_END_ 이후')),
    'fixture should reproduce a terminal quality issue'
  );

  const repaired = repairTerminalQualityArtifacts(broken);
  const after = await checkQuality(repaired, 'general');

  assert(!repaired.includes('_THE_END_'), 'terminal sentinel should be stripped');
  assert(!repaired.includes('마감 뒤에 잘못 붙은 본문'), 'overflow after sentinel should be removed');
  assert(!/업계 통계|통계에 따르면|조사에 따르면|연구에 따르면/.test(repaired), 'unsupported statistical trigger phrases should be rewritten');
  assert.strictEqual((repaired.slice(-1500).match(/\*\*/g) || []).length % 2, 0, 'bold markers should be balanced');
  assert(
    !after.issues.some((issue: QualityIssue) => String(issue.msg).includes('강조 마커'))
      && !after.issues.some((issue: QualityIssue) => String(issue.msg).includes('_THE_END_ 이후')),
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

  const multiSentinel = [
    '[핵심 요약]',
    '강의 청크 중간에 종료 마커가 잘못 섞인 상황입니다.',
    '_THE_END_',
    '[마무리 인사]',
    '중간 마커 뒤에 있는 필수 마감 섹션은 보존되어야 합니다.',
    '[해시태그]',
    '#Nodejs #강의 #프롬프트엔지니어링',
    '_THE_END_',
    '마지막 종료 마커 뒤에 붙은 쓰레기 본문',
  ].join('\n');
  const multiRepaired = repairTerminalQualityArtifacts(multiSentinel);
  assert(multiRepaired.includes('[마무리 인사]'), 'sections after an intermediate sentinel should be preserved');
  assert(!multiRepaired.includes('_THE_END_'), 'all terminal sentinels should be stripped');
  assert(!multiRepaired.includes('쓰레기 본문'), 'overflow after the last sentinel should be removed');

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
    boldBefore.issues.some((issue: QualityIssue) => String(issue.msg).includes('해시태그 이후')),
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
    htmlBefore.issues.some((issue: QualityIssue) => String(issue.msg).includes('해시태그 이후')),
    'HTML bold hashtag marker overflow should be detected'
  );

  const falseCafeClaims = [
    '일반 포스팅 제목',
    '',
    '[AI 스니펫 요약]',
    '카페온 스터디카페에서 할인행사를 진행한다는 문구는 사실이 아니므로 차단되어야 합니다.',
    '',
    '[해시태그]',
    '#커피랑도서관 #분당서현 #스터디카페',
  ].join('\n');
  const falseCafeBefore = await checkQuality(falseCafeClaims, 'general');
  assert(
    falseCafeBefore.issues.some((issue: QualityIssue) => String(issue.msg).includes('허위 매장명')),
    'CafeOn false brand claims should be blocked'
  );
  assert(
    falseCafeBefore.issues.some((issue: QualityIssue) => String(issue.msg).includes('할인/이벤트')),
    'unsupported cafe discount/event claims should be blocked'
  );

  const renderedGeneralSections = [
    '<html><body>',
    '<h1 class="post-title">[IT정보와분석] 개발자 계정 탈취 뉴스, 무엇을 먼저 봐야 하나</h1>',
    '<h2 class="section-title">핵심 요약</h2>',
    '<p>오늘 기준으로 계정 보안 흐름을 차분히 정리합니다.</p>',
    '<h2 class="section-title">이 글에서 배울 수 있는 것</h2>',
    '<p>- 개발자 계정 탈취 이슈를 실무 관점으로 해석합니다.</p>',
    '<h2 class="section-title">시작하며</h2>',
    '<p>저도 실제 운영 점검을 하다 보면, 계정 보안은 작게 보여도 가장 인상적으로 리스크가 커지는 지점이라고 느낍니다.</p>',
    '<h2 class="section-title">개발자 계정 탈취는 왜 단순 로그인 문제가 아닌가</h2>',
    `<p>${'운영 권한과 배포 키가 연결된 계정은 작은 침해가 전체 서비스 신뢰 문제로 번질 수 있습니다. '.repeat(24)}</p>`,
    '<h2 class="section-title">오픈소스 도구와 자동화가 공격 경로가 되는 방식</h2>',
    `<p>${'자동화 토큰과 저장소 권한은 편리하지만, 회수 기준이 없으면 침해 후 복구 비용이 커집니다. '.repeat(24)}</p>`,
    '<h2 class="section-title">실무자가 오늘 바로 점검할 체크리스트</h2>',
    `<p>${'권한 범위, 토큰 만료, 관리자 승인 흐름을 나누어 점검하면 우선순위가 분명해집니다. '.repeat(24)}</p>`,
    '<h2 class="section-title">질문형 Q&A</h2>',
    '<p>Q. 가장 먼저 확인할 것은 무엇인가요?</p><p>A. 관리자 권한과 배포 토큰 보관 위치입니다.</p>',
    '<p>Q. 자동화 도구는 위험한가요?</p><p>A. 도구보다 권한 범위와 회수 절차가 핵심입니다.</p>',
    '<p>Q. 오늘 바로 할 수 있는 일은 무엇인가요?</p><p>A. 오래된 토큰과 미사용 계정을 정리하는 것입니다.</p>',
    '<h2 class="section-title">생각을 정리하기 좋은 환경</h2>',
    '<p>커피랑도서관 분당서현점처럼 조용한 공간에서 보안 점검 목록을 차분히 정리해보는 것도 좋습니다.</p>',
    '<h2 class="section-title">마무리</h2>',
    '<p>핵심 메시지: 계정 보안은 로그인 문제가 아니라 운영 신뢰 문제입니다.</p>',
    '<h2 class="section-title">해시태그</h2>',
    '<p>#보안 #개발자보안 #계정탈취 #GitHub #오픈소스 #자동화 #토큰관리 #권한관리 #IT정보 #보안점검 #운영관리 #개발팀 #리스크관리 #분당서현 #커피랑도서관</p>',
    '</body></html>',
  ].join('\n');
  const renderedGeneralQuality = await checkQuality(renderedGeneralSections, 'general');
  for (const marker of ['본론 섹션 1', '본론 섹션 2', '본론 섹션 3']) {
    assert(
      !renderedGeneralQuality.issues.some((issue: QualityIssue) => String(issue.msg).includes(`필수 섹션 누락: "${marker}"`)),
      `rendered general body headings should satisfy ${marker}`
    );
  }

  const renderedLectureTechBriefing = [
    '<html><body>',
    '<h1 class="post-title">[실전 AI 구현 입문 2강] Codex와 Claude Code 비교</h1>',
    '<h2 class="section-title">핵심 요약</h2>',
    '<p>오늘 기준으로 초급자가 따라갈 수 있는 실습 흐름을 정리합니다.</p>',
    '<h2 class="section-title">이 글에서 배울 수 있는 것</h2>',
    '<p>- AI 코딩 도구를 비교하는 기준을 이해합니다.</p>',
    '<h2 class="section-title">시작하며</h2>',
    '<p>제가 처음 이런 도구를 비교했을 때도, 설치보다 결과 확인 습관이 더 인상적으로 중요했습니다.</p>',
    '<h2 class="section-title" data-marker-key="lecture-tech-briefing">실습 전 준비</h2>',
    `<p>${'계정 상태와 실행 환경을 먼저 확인하고, 프롬프트를 넣은 뒤 결과를 검증하는 순서로 접근합니다. '.repeat(20)}</p>`,
    '<h2 class="section-title">두 도구를 아주 쉬운 비유로 이해하기</h2>',
    `<p>${'Codex는 프로젝트 맥락에서 변경을 제안하고 Claude Code는 터미널 흐름에서 실행을 돕는 식으로 비교할 수 있습니다. '.repeat(20)}</p>`,
    '<h2 class="section-title">그대로 복사해서 넣어볼 첫 프롬프트</h2>',
    `<p>${'작은 파일 하나를 대상으로 설명, 수정, 검증을 요청하면 차이를 안전하게 볼 수 있습니다. '.repeat(20)}</p>`,
    '<h2 class="section-title">질문형 Q&A</h2>',
    '<p>Q. 무엇부터 하면 되나요?</p><p>A. 작은 예제로 결과를 확인하는 것부터 시작합니다.</p>',
    '<p>Q. 둘 중 하나만 쓰면 되나요?</p><p>A. 목적에 맞게 하나만 써도 충분하고, 나중에 비교하면 됩니다.</p>',
    '<p>Q. 결과를 그대로 믿어도 되나요?</p><p>A. 실행 결과와 테스트를 확인해야 합니다.</p>',
    '<h2 class="section-title">마무리</h2>',
    '<p>핵심 메시지: 도구 비교보다 검증 습관이 먼저입니다.</p>',
    '<h2 class="section-title">함께 읽으면 좋은 글</h2>',
    '<p>• 실전 AI 구현 입문 1강</p>',
    '<h2 class="section-title">해시태그</h2>',
    '<p>#AI코딩 #Codex #ClaudeCode #실습 #프롬프트 #개발입문 #업무자동화 #검증 #테스트 #코딩도구 #생성AI #초보개발 #터미널 #프로젝트 #커피랑도서관</p>',
    '</body></html>',
  ].join('\n');
  const renderedLectureQuality = await checkQuality(renderedLectureTechBriefing, 'lecture');
  assert(
    !renderedLectureQuality.issues.some((issue: QualityIssue) => String(issue.msg).includes('필수 섹션 누락: "최신 기술 브리핑"')),
    'lecture tech briefing marker key should satisfy required tech briefing section'
  );

  console.log(JSON.stringify({ ok: true, repairedLength: repaired.length }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
