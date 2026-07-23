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
const { runTitleFeedbackLoop } = require('../lib/title-feedback-loop.ts');
const { assertFinalGeneralTitle } = require('../lib/final-title-guard.ts');
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
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error?.stack || error?.message || String(error) }, null, 2));
  process.exitCode = 1;
});
