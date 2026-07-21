#!/usr/bin/env node
// @ts-nocheck
'use strict';

const assert = require('node:assert/strict');
const {
  buildTitleCandidatePrompt,
  loadTitleCorrelationProfile,
  runTitleFeedbackLoop,
  selectTitleCandidate,
  summarizeTitleFeatureCorrelations,
  validateTitleCandidate,
} = require('../lib/title-feedback-loop.ts');
const { buildContentHarnessReport } = require('../lib/content-harness.ts');
const { _testOnly: bloTest } = require('../lib/blo.ts');

function buildHarnessFixture() {
  const body = Array.from({ length: 70 }, (_, index) => (
    `제가 ${index + 1}분 동안 직접 확인한 과정입니다. 처음에는 설정이 실패했지만 로그를 비교한 뒤 다시 바꿨습니다.`
  )).join('\n');

  return [
    '[IT정보와분석] 회의록 자동화 실패를 줄이는 4가지 기준',
    '회의가 끝난 뒤 실행 항목이 사라지는 문제를 먼저 살펴봅니다.',
    '이 글을 읽으면 30분 안에 확인할 기준을 정리할 수 있습니다.',
    '작은 팀에서 회의 기록을 직접 관리하는 분을 위한 글입니다.',
    '[본론 섹션 1]',
    body,
    '[본론 섹션 2]',
    body,
    '[본론 섹션 3]',
    body,
    '[마무리 제언]',
    '3줄 요약으로 핵심을 정리합니다. 오늘 바로 회의 메모 하나를 확인해보세요.',
  ].join('\n');
}

function buildSeoFixture() {
  return [
    '[IT정보와분석] 회의록 자동화 4가지 방법',
    '<h2>첫째</h2>',
    '<h2>둘째</h2>',
    '<h2>셋째</h2>',
    '회의록 업무를 직접 점검한 자동화 사례입니다.',
  ].join('\n');
}

async function main() {
  const prompt = buildTitleCandidatePrompt({
    category: '개발기획과컨설팅',
    baseTitle: '[개발기획과컨설팅] AI 기능 도입 전 합의해야 할 것들',
    topic: 'AI 기능 도입 전 합의할 범위와 지표',
    topicTitleCandidate: 'AI 기능 도입 전 합의할 범위 지표 책임',
    requiredPhrase: 'AI 기능',
    content: buildSeoFixture(),
  });
  assert.match(prompt, /최종 제목 전체가 35자 이하/);
  assert.match(prompt, /제목 본문은 최대 24자/);
  assert.match(prompt, /숫자.*도구명.*구체 결과.*방법.*실제 사례/s);
  assert.match(prompt, /AI 기능 도입 전 합의할 범위 지표 책임/);
  assert.match(prompt, /topic_alignment.*0\.20.*0\.40/s);
  assert.match(prompt, /AI 기능.*바꾸거나 축약하지 않/s);

  const title35 = `AI ${'가'.repeat(32)}`;
  const title36 = `AI ${'가'.repeat(33)}`;
  const length35 = validateTitleCandidate(title35, {
    baseTitle: title35,
    content: `${title35}\n${buildSeoFixture()}`,
  });
  const length36 = validateTitleCandidate(title36, {
    baseTitle: title35,
    content: `${title35}\n${buildSeoFixture()}`,
  });
  assert.ok(!length35.seoIssues.some((issue) => issue.includes('35자 이하')));
  assert.ok(length36.seoIssues.some((issue) => issue.includes('35자 이하')));

  const recentFailureInput = {
    category: '개발기획과컨설팅',
    baseTitle: '[개발기획과컨설팅] AI 기능 도입 전 합의해야 할 것들',
    topic: 'AI 기능 도입 전 합의할 범위와 지표',
    topicTitleCandidate: 'AI 기능 도입 전 합의할 범위 지표 책임',
    content: buildSeoFixture(),
  };
  const replayProfile = {
    sample_size: 20,
    eligible_features: ['has_number'],
    features: { has_number: { delta: 1 } },
  };
  const recentBefore = await runTitleFeedbackLoop(recentFailureInput, {
    generateCandidates: async () => [
      '챗봇·생성형 AI, 개발 전 꼭 정할 항목',
      'AI 기능 추가 전 일정이 흔들리지 않게 합의할 것',
      'AI 도입 전 범위·지표·운영책임을 정했나요?',
    ],
    loadCorrelationProfile: async () => replayProfile,
    assertDistinctTitle: () => {},
  });
  assert.match(recentBefore.metadata.title_selected_reason, /^fallback_existing_title:candidate_count_below_3/);
  assert.equal(recentBefore.metadata.title_candidates.length, 1);

  const recentAfter = await runTitleFeedbackLoop(recentFailureInput, {
    generateCandidates: async () => [
      'AI 도입 전 합의 3가지',
      'AI 기능 범위 정하는 법',
      'AI 도입 지표 4개 점검법',
      'AI 운영 책임 3단계',
    ],
    loadCorrelationProfile: async () => replayProfile,
    assertDistinctTitle: () => {},
  });
  assert.ok(recentAfter.metadata.title_candidates.length >= 3);
  assert.doesNotMatch(recentAfter.metadata.title_selected_reason, /^fallback_existing_title:/);

  const history = [
    { title: '[IT정보와분석] 자동화 실패를 줄이는 4가지 기준', crank_total: 72 },
    { title: '[홈페이지와App] 첫 화면 이탈을 막는 5가지 신호', crank_total: 70 },
    { title: '[자기계발] 집중력을 되찾는 환경 설정', crank_total: 51 },
    { title: '[성장과성공] 흔들리지 않는 목표 정렬법', crank_total: 53 },
  ];
  const profile = summarizeTitleFeatureCorrelations(history, {
    minSamplesPerSide: 2,
    minAbsoluteDelta: 1,
  });
  assert.equal(profile.sample_size, 4);
  assert.ok(profile.features.has_number.delta > 0);

  const selection = selectTitleCandidate([
    '[IT정보와분석] 회의록 자동화를 시작하기 전에 확인할 기준',
    '[IT정보와분석] 회의록 자동화 실패를 줄이는 4가지 기준',
    '[IT정보와분석] 회의록 자동화는 왜 자꾸 막힐까?',
  ], profile);
  assert.equal(selection.title, '[IT정보와분석] 회의록 자동화 실패를 줄이는 4가지 기준');
  assert.match(selection.reason, /has_number/);

  const labels = ['가', '나', '다', '라', '마'];
  const scopedHistory = [
    ...labels.map((label) => ({ category: '자기계발', title: `[자기계발] 아침 루틴 ${label} 3가지 기준`, crank_total: 50 })),
    ...labels.map((label) => ({ category: '자기계발', title: `[자기계발] 아침 루틴 ${label} 점검 방법`, crank_total: 60 })),
    ...labels.map((label) => ({ category: '도서리뷰', title: `[도서리뷰] 독서 기록 ${label} 3가지 기준`, crank_total: 80 })),
    ...labels.map((label) => ({ category: '도서리뷰', title: `[도서리뷰] 독서 기록 ${label} 점검 방법`, crank_total: 60 })),
  ];
  const profilePool = { query: async () => scopedHistory };
  const selfHelpProfile = await loadTitleCorrelationProfile({
    category: '자기계발',
    noCache: true,
    pool: profilePool,
  });
  assert.equal(selfHelpProfile.profile_scope, 'category');
  assert.equal(selfHelpProfile.profile_category, '자기계발');
  assert.equal(selfHelpProfile.features.has_number.delta, -10);
  const selfHelpSelection = selectTitleCandidate([
    '[자기계발] 아침 루틴 3가지 기준',
    '[자기계발] 아침 루틴 점검 방법',
  ], selfHelpProfile);
  assert.equal(selfHelpSelection.title, '[자기계발] 아침 루틴 점검 방법');
  assert.match(selfHelpSelection.reason, /scope=category:자기계발/);

  const bookProfile = await loadTitleCorrelationProfile({
    category: '도서리뷰',
    noCache: true,
    pool: profilePool,
  });
  assert.equal(bookProfile.profile_scope, 'category');
  assert.equal(bookProfile.profile_category, '도서리뷰');
  assert.equal(bookProfile.features.has_number.delta, 20);

  const fallbackProfile = await loadTitleCorrelationProfile({
    category: '성장과성공',
    noCache: true,
    pool: profilePool,
  });
  assert.equal(fallbackProfile.profile_scope, 'global_fallback');
  assert.equal(fallbackProfile.profile_category, '성장과성공');
  assert.equal(fallbackProfile.features.has_number.delta, 5);
  const fallbackProfileSelection = selectTitleCandidate([
    '[성장과성공] 목표 점검 3가지 기준',
    '[성장과성공] 목표 점검 방법',
  ], fallbackProfile);
  assert.match(fallbackProfileSelection.reason, /scope=global_fallback:성장과성공/);

  const titleLoop = await runTitleFeedbackLoop({
    category: 'IT정보와분석',
    baseTitle: '[IT정보와분석] 회의록 자동화를 시작하기 전에 확인할 기준',
    topic: '회의록 자동화',
    content: buildHarnessFixture(),
  }, {
    generateCandidates: async () => [
      '회의록 자동화를 시작하기 전에 확인할 기준',
      '회의록 자동화 실패를 줄이는 4가지 기준',
      '회의록 자동화는 왜 자꾸 막힐까?',
      '회의록 자동화에서 직접 확인한 설정 순서',
    ],
    loadCorrelationProfile: async () => profile,
  });
  assert.equal(titleLoop.title, '[IT정보와분석] 회의록 자동화 실패를 줄이는 4가지 기준');
  assert.equal(titleLoop.metadata.title_candidates.length, 4);
  assert.match(titleLoop.metadata.title_selected_reason, /crank30d/);
  assert.ok(titleLoop.content.startsWith(`${titleLoop.title}\n`));

  const shortTitleProfile = {
    sample_size: 20,
    eligible_features: ['length_1_20'],
    features: { length_1_20: { delta: 5 } },
  };
  const qualityFilteredLoop = await runTitleFeedbackLoop({
    category: 'IT정보와분석',
    baseTitle: '[IT정보와분석] 회의록 자동화를 시작하기 전에 확인할 기준',
    topic: '회의록 자동화',
    content: buildHarnessFixture(),
  }, {
    generateCandidates: async () => [
      '새로운 업무 흐름을 바라보는 관점',
      '회의록 자동화 4가지 기준',
      '회의록 자동화는 왜 자꾸 막힐까?',
      '회의록 자동화에서 직접 확인한 설정 순서',
    ],
    loadCorrelationProfile: async () => shortTitleProfile,
  });
  assert.equal(qualityFilteredLoop.title, '[IT정보와분석] 회의록 자동화 4가지 기준');
  assert.ok(!qualityFilteredLoop.metadata.title_candidates.some((candidate) => candidate.title.includes('새로운 업무 흐름')));

  const seoFilteredLoop = await runTitleFeedbackLoop({
    category: 'IT정보와분석',
    baseTitle: '[IT정보와분석] 회의록 자동화 4가지 방법',
    topic: '회의록 자동화',
    content: buildSeoFixture(),
  }, {
    generateCandidates: async () => [
      '업무 자동화 실제 사례: 현장의 관점',
      '회의록 자동화 3가지 기준',
      '회의록 자동화 5단계 점검 방법',
      '회의록 자동화 오류 2가지는 무엇일까?',
    ],
    loadCorrelationProfile: async () => ({
      sample_size: 20,
      eligible_features: ['two_part'],
      features: { two_part: { delta: 5 } },
    }),
    assertDistinctTitle: () => {},
  });
  assert.equal(seoFilteredLoop.title, '[IT정보와분석] 회의록 자동화 4가지 방법');
  assert.ok(!seoFilteredLoop.metadata.title_candidates.some((candidate) => candidate.title.includes('현장의 관점')));
  assert.ok(seoFilteredLoop.metadata.title_candidates.some((candidate) => candidate.title.includes('3가지 기준')));
  assert.ok(seoFilteredLoop.metadata.title_rejected_candidates.some((candidate) => (
    candidate.title.includes('현장의 관점') && candidate.reasons.includes('seo_level_drop:fair->poor')
  )));

  const topicAlignedLoop = await runTitleFeedbackLoop({
    category: 'IT정보와분석',
    baseTitle: '[IT정보와분석] 회의록 자동화 4가지 방법',
    topic: '회의록 자동화',
    topicTitleCandidate: '회의록 자동화 실행 항목을 지키는 4가지 방법',
    content: buildSeoFixture(),
  }, {
    generateCandidates: async () => [
      '엑셀 함수 오류 7가지: 실제 점검 가이드',
      '회의록 자동화 3가지 기준',
      '회의록 자동화 5단계 점검 방법',
      '회의록 자동화 오류 2가지는 무엇일까?',
    ],
    loadCorrelationProfile: async () => ({
      sample_size: 20,
      eligible_features: ['two_part'],
      features: { two_part: { delta: 5 } },
    }),
    assertDistinctTitle: () => {},
  });
  assert.equal(topicAlignedLoop.title, '[IT정보와분석] 회의록 자동화 4가지 방법');
  assert.ok(!topicAlignedLoop.metadata.title_candidates.some((candidate) => candidate.title.includes('엑셀 함수 오류')));
  assert.ok(topicAlignedLoop.metadata.title_candidates.some((candidate) => candidate.title.includes('회의록 자동화 3가지 기준')));
  assert.ok(topicAlignedLoop.metadata.title_rejected_candidates.some((candidate) => (
    candidate.title.includes('엑셀 함수 오류') && candidate.reasons.some((reason) => reason.startsWith('topic_alignment_error:'))
  )));

  const allMisalignedFallback = await runTitleFeedbackLoop({
    category: 'IT정보와분석',
    baseTitle: '[IT정보와분석] 회의록 자동화 4가지 방법',
    topic: '회의록 자동화',
    topicTitleCandidate: '회의록 자동화 실행 항목을 지키는 4가지 방법',
    content: buildSeoFixture(),
  }, {
    generateCandidates: async () => [
      '엑셀 함수 오류 7가지: 실제 점검 가이드',
      '클라우드 비용 5가지 절감 방법',
      '터미널 명령어 3단계 실습 가이드',
      '프로젝트 일정 지연 4가지 판단 기준',
    ],
    loadCorrelationProfile: async () => ({
      sample_size: 20,
      eligible_features: ['has_number'],
      features: { has_number: { delta: 5 } },
    }),
    assertDistinctTitle: () => {},
  });
  assert.equal(allMisalignedFallback.title, '[IT정보와분석] 회의록 자동화 4가지 방법');
  assert.match(allMisalignedFallback.metadata.title_selected_reason, /^fallback_existing_title:candidate_count_below_3/);
  assert.equal(allMisalignedFallback.metadata.title_rejected_candidates.length, 4);

  const numberProfile = {
    sample_size: 20,
    eligible_features: ['has_number'],
    features: { has_number: { delta: 5 } },
  };
  const distinctFilteredLoop = await runTitleFeedbackLoop({
    category: 'IT정보와분석',
    baseTitle: '[IT정보와분석] 회의록 자동화를 시작하기 전에 확인할 기준',
    topic: '회의록 자동화',
    content: buildHarnessFixture(),
  }, {
    generateCandidates: async () => [
      '회의록 자동화 실패를 줄이는 4가지 기준',
      '회의록 자동화 오류를 막는 3단계 점검',
      '회의록 자동화는 어떤 기준으로 점검할까?',
      '회의록 자동화에서 직접 확인한 설정 순서',
    ],
    loadCorrelationProfile: async () => numberProfile,
    assertDistinctTitle: (_category, title) => {
      if (title.includes('실패를 줄이는 4가지 기준')) throw new Error('recent title overlap');
    },
  });
  assert.equal(distinctFilteredLoop.title, '[IT정보와분석] 회의록 자동화 오류를 막는 3단계 점검');
  assert.ok(!distinctFilteredLoop.metadata.title_candidates.some((candidate) => candidate.title.includes('실패를 줄이는 4가지 기준')));

  const allRecentFallback = await runTitleFeedbackLoop({
    category: 'IT정보와분석',
    baseTitle: '[IT정보와분석] 기존 회의록 자동화 점검 방법',
    topic: '회의록 자동화',
    content: buildHarnessFixture(),
  }, {
    generateCandidates: async () => [
      '회의록 자동화 실패를 줄이는 4가지 기준',
      '회의록 자동화 오류를 막는 3단계 점검',
      '회의록 자동화는 어떤 기준으로 점검할까?',
      '회의록 자동화에서 직접 확인한 설정 순서',
    ],
    loadCorrelationProfile: async () => numberProfile,
    assertDistinctTitle: (_category, title) => {
      if (!title.includes('기존 회의록 자동화 점검 방법')) throw new Error('recent title overlap');
    },
  });
  assert.equal(allRecentFallback.title, '[IT정보와분석] 기존 회의록 자동화 점검 방법');
  assert.match(allRecentFallback.metadata.title_selected_reason, /^fallback_existing_title:candidate_count_below_3/);

  const fallback = await runTitleFeedbackLoop({
    category: 'IT정보와분석',
    baseTitle: '[IT정보와분석] 기존 단일 제목',
    topic: '기존 주제',
    content: '[IT정보와분석] 기존 단일 제목\n본문',
  }, {
    generateCandidates: async () => {
      throw new Error('fixture generation failure');
    },
    loadCorrelationProfile: async () => profile,
  });
  assert.equal(fallback.title, '[IT정보와분석] 기존 단일 제목');
  assert.equal(fallback.metadata.title_candidates.length, 1);
  assert.match(fallback.metadata.title_selected_reason, /^fallback_existing_title/);

  const harness = buildContentHarnessReport({
    title: titleLoop.title,
    content: buildHarnessFixture(),
    postType: 'general',
  });
  assert.equal(harness.mode, 'report');
  assert.equal(harness.blocking_enabled, false);
  assert.equal(harness.rules.length, 6);
  assert.equal(harness.score, 100);
  assert.deepEqual(harness.violations, []);

  const prePublishDryRun = await bloTest._publishAndTrack({
    title: titleLoop.title,
    content: buildHarnessFixture(),
    category: 'IT정보와분석',
    postType: 'general',
    metadata: titleLoop.metadata,
  }, null, { trace_id: 'title-loop-harness-smoke' }, { type: 'general' }, { dryRun: true });
  assert.equal(prePublishDryRun.dryRun, true);
  assert.equal(prePublishDryRun.metadata.harness_report.mode, 'report');
  assert.equal(prePublishDryRun.metadata.harness_report.blocking_enabled, false);
  assert.equal(prePublishDryRun.metadata.title_candidates.length, 4);

  const weakHarness = buildContentHarnessReport({
    title: '[IT정보와분석] 효과적인 자동화 전략',
    content: 'AI가 작성한 짧은 초안입니다.',
    postType: 'general',
  });
  assert.equal(weakHarness.mode, 'report');
  assert.equal(weakHarness.blocking_enabled, false);
  assert.equal(weakHarness.would_block, true);
  assert.ok(weakHarness.violations.some((item) => item.rule === 'R6'));

  console.log(JSON.stringify({
    ok: true,
    suite: 'blog-title-loop-harness',
    recentFailureReplay: {
      beforePassedCandidates: recentBefore.metadata.title_candidates.length,
      afterPassedCandidates: recentAfter.metadata.title_candidates.length,
    },
    titleCandidates: titleLoop.metadata.title_candidates,
    titleSelectedReason: titleLoop.metadata.title_selected_reason,
    harness,
    prePublishMetadataKeys: Object.keys(prePublishDryRun.metadata),
    fallbackReason: fallback.metadata.title_selected_reason,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
