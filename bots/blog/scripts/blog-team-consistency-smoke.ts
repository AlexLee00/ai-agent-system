#!/usr/bin/env node
// @ts-nocheck
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const env = require('../../../packages/core/lib/env');
const {
  BLOG_ENGAGEMENT_POLICY,
  COMMENT_SYMPATHY_ACTION_TYPES,
  STANDALONE_SYMPATHY_ACTION_TYPES,
  SYMPATHY_ACTION_TYPES,
  buildEvenDailySchedule,
} = require('../lib/engagement-policy.ts');
const {
  buildRetiredFeatureResult,
  isBlogMarketingRetired,
  isBlogSnsPublishingRetired,
} = require('../lib/retirement-policy.ts');
const { isBlogMarketingEnabled } = require('../lib/marketing-enabled.ts');
const { normalizeExecutionDirectives } = require('../lib/strategy-loader.ts');
const { buildBookReviewTitleCandidate } = require('../lib/book-review-title.ts');
const {
  regenerateTitleAfterConflict,
  replaceTitleLine,
  runTitleFeedbackLoop,
} = require('../lib/title-feedback-loop.ts');
const {
  assertFinalGeneralTitle,
  buildTitleGuardEventDetails,
  buildTitleHistorySnapshot,
  resolveFinalGeneralTitle,
} = require('../lib/final-title-guard.ts');
const { isTooCloseToRecentTitle } = require('../lib/topic-title-guard.ts');
const { acquireEngagementLock, releaseEngagementLock } = require('../lib/engagement-process-lock.ts');
const { trackWeeklyAutonomy } = require('../lib/autonomy-tracker.ts');

async function main() {
  process.env.BLOG_MARKETING_ENABLED = 'true';
  process.env.BLOG_SNS_CROSSPOST_ENABLED = 'true';
  assert.equal(isBlogMarketingRetired(), true);
  assert.equal(isBlogSnsPublishingRetired(), true);
  assert.equal(isBlogMarketingEnabled(), false);
  assert.deepEqual(buildRetiredFeatureResult('facebook').reason, 'blog_feature_retired');

  const directives = normalizeExecutionDirectives({
    executionDirectives: {
      executionTargets: {
        instagramRegistrationsPerCycle: 9,
        facebookRegistrationsPerCycle: 9,
        neighborCommentTargetPerCycle: 9,
        sympathyTargetPerCycle: 9,
      },
      platformTargets: {
        instagram: { feedPerCycle: 9, reelsPerCycle: 9, storiesPerCycle: 9 },
        facebook: { postsPerCycle: 9 },
      },
    },
  });
  assert.equal(directives.executionTargets.instagramRegistrationsPerCycle, 0);
  assert.equal(directives.executionTargets.facebookRegistrationsPerCycle, 0);
  assert.equal(directives.executionTargets.neighborCommentTargetPerCycle, 1);
  assert.equal(directives.executionTargets.sympathyTargetPerCycle, 1);

  assert.equal(BLOG_ENGAGEMENT_POLICY.neighborCommentsPerDay, 30);
  assert.equal(BLOG_ENGAGEMENT_POLICY.commentSympathiesPerDay, 30);
  assert.equal(BLOG_ENGAGEMENT_POLICY.standaloneSympathiesPerDay, 30);
  assert.equal(BLOG_ENGAGEMENT_POLICY.totalSympathiesPerDay, 60);
  assert.equal(BLOG_ENGAGEMENT_POLICY.maxActionsPerCycle, 1);
  assert.deepEqual(COMMENT_SYMPATHY_ACTION_TYPES, ['neighbor_comment_sympathy']);
  assert.deepEqual(STANDALONE_SYMPATHY_ACTION_TYPES, ['neighbor_sympathy']);
  assert.deepEqual(SYMPATHY_ACTION_TYPES, ['neighbor_comment_sympathy', 'neighbor_sympathy']);
  const commentSchedule = buildEvenDailySchedule({ count: 30, startHour: 9, startMinute: 8, intervalMinutes: 24 });
  const sympathySchedule = buildEvenDailySchedule({ count: 30, startHour: 9, startMinute: 20, intervalMinutes: 24 });
  assert.equal(commentSchedule.length, 30);
  assert.equal(sympathySchedule.length, 30);
  assert.deepEqual(commentSchedule[0], { Hour: 9, Minute: 8 });
  assert.deepEqual(commentSchedule.at(-1), { Hour: 20, Minute: 44 });
  assert.deepEqual(sympathySchedule.at(-1), { Hour: 20, Minute: 56 });
  assert.equal(
    sympathySchedule[0].Hour * 60 + sympathySchedule[0].Minute
      - (commentSchedule[0].Hour * 60 + commentSchedule[0].Minute),
    12,
  );

  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-engagement-lock-'));
  const lockPath = path.join(lockDir, 'engagement.lock');
  const firstLock = await acquireEngagementLock({ lockPath, maxWaitMs: 0 });
  const overlappingLock = await acquireEngagementLock({ lockPath, maxWaitMs: 0 });
  assert.equal(firstLock.acquired, true);
  assert.equal(overlappingLock.acquired, false);
  releaseEngagementLock(firstLock.lock);
  const reacquiredLock = await acquireEngagementLock({ lockPath, maxWaitMs: 0 });
  assert.equal(reacquiredLock.acquired, true);
  releaseEngagementLock(reacquiredLock.lock);
  fs.rmSync(lockDir, { recursive: true, force: true });

  const autonomyQueries = [];
  const autonomy = await trackWeeklyAutonomy({
    write: false,
    calculateAccuracyFn: async () => 0.82,
    pool: {
      query: async (_schema, sql) => {
        autonomyQueries.push(String(sql));
        return /SELECT\s+week_of/i.test(String(sql))
          ? [{ accuracy: 0.81, current_phase: 1, phase_changed: false }]
          : [];
      },
    },
  });
  assert.equal(autonomy.persisted, false);
  assert.equal(autonomyQueries.some((sql) => /INSERT\s+INTO/i.test(sql)), false);

  const bookTitles = [
    { title: '책 A', isbn: '1' },
    { title: '책 B', isbn: '2' },
    { title: '책 C', isbn: '3' },
    { title: '책 D', isbn: '4' },
    { title: '책 E', isbn: '5' },
    { title: '책 F', isbn: '6' },
  ].map(buildBookReviewTitleCandidate);
  assert.ok(new Set(bookTitles.map((title) => title.replace(/^책 [A-F]\s*/, ''))).size >= 3);
  assert.ok(bookTitles.every((title, index) => title.includes(`책 ${String.fromCharCode(65 + index)}`)));

  const validCandidateFallback = await runTitleFeedbackLoop({
    category: 'IT정보와분석',
    baseTitle: '[IT정보와분석] 반복되는 기존 제목',
    content: '[IT정보와분석] 반복되는 기존 제목\n본문',
  }, {
    generateCandidates: async () => ['서버 장애에서 배운 복구 순서 4단계'],
    assertDistinctTitle: () => {},
    loadCorrelationProfile: async () => ({ eligible_features: [] }),
  });
  assert.match(validCandidateFallback.title, /복구 순서 4단계/);
  assert.match(validCandidateFallback.metadata.title_selected_reason, /^fallback_valid_candidate:/);

  const blockedFallback = await runTitleFeedbackLoop({
    category: 'IT정보와분석',
    baseTitle: '[IT정보와분석] 반복되는 기존 제목',
    content: '[IT정보와분석] 반복되는 기존 제목\n본문',
  }, {
    generateCandidates: async () => [],
    assertDistinctTitle: () => { throw new Error('recent overlap'); },
    loadCorrelationProfile: async () => ({ eligible_features: [] }),
  });
  assert.equal(blockedFallback.blocked, true);

  let unavailableGenerationCalls = 0;
  await assert.rejects(
    runTitleFeedbackLoop({
      category: 'IT정보와분석',
      baseTitle: '[IT정보와분석] 이력 장애 시 생성하지 않을 제목',
      content: '[IT정보와분석] 이력 장애 시 생성하지 않을 제목\n본문',
    }, {
      generateCandidates: async () => {
        unavailableGenerationCalls += 1;
        return ['생성하면 안 되는 제목'];
      },
      loadDbTitleHistory: async () => ({ available: false, titles: [], error: 'db down' }),
      loadOutputTitleHistory: () => ({ available: false, titles: [], error: 'output missing' }),
    }),
    (error) => (
      error?.code === 'title_history_unavailable'
      && error?.details?.attemptedTitle === '[IT정보와분석] 이력 장애 시 생성하지 않을 제목'
    ),
  );
  assert.equal(unavailableGenerationCalls, 0);

  assert.equal(isTooCloseToRecentTitle(
    '[IT정보와분석] 배포 전 확인할 로그 7가지',
    [
      '[자기계발] 집중이 흐트러질 때 책상을 바꾼 이유',
      '[IT정보와분석] 장애 전에 확인할 지표 5가지',
    ],
  ), true);

  await assert.rejects(
    assertFinalGeneralTitle('[IT정보와분석] 장애 전에 확인할 로그 7가지', {
      loadDbTitleHistory: async () => ({
        available: true,
        titles: ['[IT정보와분석] 배포 전에 확인할 지표 5가지'],
      }),
      loadOutputTitleHistory: () => ({ available: true, titles: [] }),
    }),
    (error) => error?.code === 'final_title_overlap',
  );
  await assert.rejects(
    assertFinalGeneralTitle('[IT정보와분석] 고유한 제목', {
      loadDbTitleHistory: async () => ({ available: false, titles: [], error: 'db down' }),
      loadOutputTitleHistory: () => ({ available: false, titles: [], error: 'output missing' }),
    }),
    (error) => error?.code === 'title_history_unavailable',
  );
  const degradedTitleGuard = await assertFinalGeneralTitle('[IT정보와분석] 장애 대응 로그를 시간순으로 복원한 기록', {
    loadDbTitleHistory: async () => ({ available: true, titles: [] }),
    loadOutputTitleHistory: () => ({ available: false, titles: [], error: 'output missing' }),
  });
  assert.equal(degradedTitleGuard.degraded, true);

  const latestTitle = '[자기계발] 집중이 흐트러질 때 책상을 바꾼 이유';
  const olderStrictOnlyTitle = '[자기계발] 장애 대응 기록을 시간순으로 정리한 과정';
  const singletonCandidate = '[IT정보와분석] 장애 대응 로그를 시간순으로 복원한 기록';
  const singletonSnapshot = buildTitleHistorySnapshot({
    available: true,
    entries: [
      { title: olderStrictOnlyTitle, observedAt: '2026-06-20T00:00:00+09:00' },
      { title: latestTitle, observedAt: '2026-07-20T00:00:00+09:00' },
    ],
  }, { available: true, entries: [] });
  assert.equal(singletonSnapshot.titles[0], latestTitle);
  await assert.doesNotReject(assertFinalGeneralTitle(singletonCandidate, {
    historySnapshot: singletonSnapshot,
  }));

  const post284Title = '[성장과성공] 스타트업에서 흔들리지 않는 목표 세우기 — 일이 바뀔 때마다 방향을 잡는 3가지 기준';
  const selectedTitle = '[성장과성공] 흔들리지 않는 목표 3가지 기준';
  const alternateTitle = '[성장과성공] 목표 세우기 기록을 7일 실험으로 바꾼 결과';
  const secondAlternateTitle = '[성장과성공] 흔들리지 않는 목표 기록 2주 회고 사례';
  const conflictingAlternateOne = '[성장과성공] 목표를 다시 세우는 4가지 기준';
  const conflictingAlternateTwo = '[성장과성공] 흔들릴 때 목표를 점검하는 5가지 방법';
  const titleBody = '첫 문단은 이미 품질 검증을 마친 본문입니다.\n둘째 문단도 제목 회복 중에는 바뀌면 안 됩니다.';
  const titleContent = `${selectedTitle}\n${titleBody}`;
  const earlySnapshot = buildTitleHistorySnapshot(
    { available: true, entries: [] },
    { available: true, entries: [] },
  );
  const post284Snapshot = buildTitleHistorySnapshot({
    available: true,
    entries: [{ title: post284Title, observedAt: '2026-06-27T09:00:00+09:00' }],
  }, { available: true, entries: [] });
  const recoveryInput = {
    category: '성장과성공',
    baseTitle: selectedTitle,
    topic: '흔들리지 않는 목표 세우기',
    topicTitleCandidate: '흔들리지 않는 목표 세우기',
    content: titleContent,
  };
  const historyBlockedLoop = await runTitleFeedbackLoop(recoveryInput, {
    historySnapshot: post284Snapshot,
    generateCandidates: async () => [],
    loadCorrelationProfile: async () => ({ eligible_features: [] }),
  });
  assert.equal(historyBlockedLoop.blocked, true);
  assert.equal(historyBlockedLoop.titleGuardDetails.attemptedTitle, selectedTitle);
  assert.equal(historyBlockedLoop.titleGuardDetails.conflictTitle, post284Title);
  assert.equal(historyBlockedLoop.titleGuardDetails.conflictSource, 'db');
  assert.ok(historyBlockedLoop.titleGuardDetails.matchedPredicate);

  const titleLoopBeforePost284 = await runTitleFeedbackLoop(recoveryInput, {
    historySnapshot: earlySnapshot,
    generateCandidates: async () => [alternateTitle, secondAlternateTitle],
    loadCorrelationProfile: async () => ({
      sample_size: 20,
      eligible_features: ['has_number'],
      features: { has_number: { delta: 1 } },
    }),
  });
  assert.equal(titleLoopBeforePost284.title, selectedTitle);
  const validatedCandidates = titleLoopBeforePost284.metadata.title_candidates.map((candidate) => candidate.title);

  let alternateRegenerationCalls = 0;
  let alternateRecoveryEvent = null;
  const alternateResolution = await resolveFinalGeneralTitle({
    title: titleLoopBeforePost284.title,
    candidateTitles: validatedCandidates,
    candidateCount: validatedCandidates.length,
    selectedReason: titleLoopBeforePost284.metadata.title_selected_reason,
    historySnapshot: post284Snapshot,
    regenerateTitle: async () => {
      alternateRegenerationCalls += 1;
      return null;
    },
    onRecovered: async (detail) => { alternateRecoveryEvent = detail; },
  });
  assert.equal(alternateResolution.title, alternateTitle);
  assert.equal(alternateResolution.guardAttempts, 2);
  assert.equal(alternateRegenerationCalls, 0);
  assert.equal(replaceTitleLine(titleContent, alternateResolution.title).split('\n').slice(1).join('\n'), titleBody);
  assert.deepEqual(Object.keys(alternateRecoveryEvent).sort(), [
    'attemptedTitle',
    'candidateCount',
    'conflictSource',
    'conflictTitle',
    'matchedPredicate',
    'selectedReason',
  ]);

  let regenerationCalls = 0;
  let regenerationContext = null;
  let regenerationGeneratorInput = null;
  const regenerationResolution = await resolveFinalGeneralTitle({
    title: selectedTitle,
    candidateTitles: [selectedTitle, conflictingAlternateOne, conflictingAlternateTwo],
    candidateCount: 3,
    selectedReason: 'fixture_post_284_initial_selection',
    historySnapshot: post284Snapshot,
    regenerateTitle: async (conflictContext) => {
      regenerationCalls += 1;
      regenerationContext = conflictContext;
      return regenerateTitleAfterConflict(recoveryInput, conflictContext, {
        generateCandidates: async (generatorInput) => {
          regenerationGeneratorInput = generatorInput;
          return [alternateTitle];
        },
        historySnapshot: post284Snapshot,
        loadCorrelationProfile: async () => ({ eligible_features: [] }),
      });
    },
  });
  assert.equal(regenerationResolution.title, alternateTitle);
  assert.equal(regenerationResolution.guardAttempts, 4);
  assert.equal(regenerationCalls, 1);
  assert.equal(regenerationContext.conflictTitle, post284Title);
  assert.ok(regenerationContext.conflictReason);
  assert.equal(regenerationGeneratorInput.recoveryConflictTitle, post284Title);
  assert.equal(regenerationGeneratorInput.recoveryConflictReason, regenerationContext.conflictReason);
  assert.equal(alternateRecoveryEvent.conflictTitle, post284Title);
  assert.equal(alternateRecoveryEvent.conflictSource, 'db');
  assert.equal(alternateRecoveryEvent.attemptedTitle, selectedTitle);
  assert.ok(alternateRecoveryEvent.matchedPredicate);
  assert.equal(alternateRecoveryEvent.candidateCount, 3);
  assert.equal(replaceTitleLine(titleContent, regenerationResolution.title).split('\n').slice(1).join('\n'), titleBody);

  let exhaustedRegenerationCalls = 0;
  await assert.rejects(
    resolveFinalGeneralTitle({
      title: selectedTitle,
      candidateTitles: [selectedTitle, conflictingAlternateOne, conflictingAlternateTwo],
      candidateCount: 3,
      selectedReason: 'fixture_post_284_all_exhausted',
      historySnapshot: post284Snapshot,
      regenerateTitle: async (conflictContext) => {
        exhaustedRegenerationCalls += 1;
        return regenerateTitleAfterConflict(recoveryInput, conflictContext, {
          generateCandidates: async () => ['흔들리지 않는 목표 6가지 기준'],
          historySnapshot: post284Snapshot,
          loadCorrelationProfile: async () => ({ eligible_features: [] }),
        });
      },
    }),
    (error) => {
      assert.equal(error?.code, 'final_title_overlap');
      assert.equal(error?.details?.guardAttempts, 4);
      assert.equal(error?.details?.regenerationAttempts, 1);
      assert.deepEqual(Object.keys(buildTitleGuardEventDetails(error)).sort(), [
        'attemptedTitle',
        'candidateCount',
        'conflictSource',
        'conflictTitle',
        'matchedPredicate',
        'selectedReason',
      ]);
      return true;
    },
  );
  assert.equal(exhaustedRegenerationCalls, 1);

  const commenterSource = fs.readFileSync(path.join(env.PROJECT_ROOT, 'bots/blog/lib/commenter.ts'), 'utf8');
  assert.match(commenterSource, /getTodaySympathyCount/);
  assert.match(commenterSource, /neighbor_comment_sympathy[\s\S]*neighbor_sympathy/);
  assert.doesNotMatch(commenterSource, /externalFill\s*=\s*await\s+runNeighborCommenter/);
  assert.match(commenterSource, /processNeighborCommentWithTimeout\(candidate, \{[\s\S]*withSympathy: true/);

  const weeklySource = fs.readFileSync(path.join(env.PROJECT_ROOT, 'bots/blog/scripts/weekly-evolution.ts'), 'utf8');
  assert.match(weeklySource, /runCrankDiagnoser/);
  const bloSource = fs.readFileSync(path.join(env.PROJECT_ROOT, 'bots/blog/lib/blo.ts'), 'utf8');
  assert.doesNotMatch(bloSource, /readExperimentPlaybook|recordPublishedExperimentRun/);
  const feedbackSource = fs.readFileSync(path.join(env.PROJECT_ROOT, 'bots/blog/lib/feedback-learner.ts'), 'utf8');
  assert.doesNotMatch(feedbackSource, /view_count|WHERE type = 'general'/);
  const masterAnalyzerSource = fs.readFileSync(path.join(env.PROJECT_ROOT, 'bots/blog/lib/master-edit-analyzer.ts'), 'utf8');
  const masterAnalyzerMigration = fs.readFileSync(path.join(env.PROJECT_ROOT, 'bots/blog/migrations/027-master-edit-analysis.sql'), 'utf8');
  assert.doesNotMatch(masterAnalyzerSource, /CREATE TABLE IF NOT EXISTS blog\.master_edit_analysis/);
  assert.match(masterAnalyzerMigration, /CREATE TABLE IF NOT EXISTS blog\.master_edit_analysis/);

  console.log(JSON.stringify({
    ok: true,
    retirement: { marketing: true, snsPublishing: true },
    engagement: BLOG_ENGAGEMENT_POLICY,
    schedules: {
      commentsWithSympathy: commentSchedule.length,
      standaloneSympathies: sympathySchedule.length,
      totalSympathies: commentSchedule.length + sympathySchedule.length,
    },
    titleFallback: validCandidateFallback.title,
    blockedDuplicateFallback: blockedFallback.blocked,
    titleHistoryFailClosed: true,
    finalTitleRecovery: {
      alternate: alternateResolution.title,
      regenerated: regenerationResolution.title,
      exhaustedFailClosed: true,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error?.stack || error?.message || String(error) }, null, 2));
  process.exitCode = 1;
});
