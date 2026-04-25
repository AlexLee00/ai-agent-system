'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');

jest.mock('../../../packages/core/lib/pg-pool', () => ({
  query: jest.fn().mockResolvedValue([]),
  get: jest.fn().mockResolvedValue(null),
}));

jest.mock(
  `${process.env.PROJECT_ROOT || require('../../../packages/core/lib/env').PROJECT_ROOT}/bots/blog/lib/feedback-learner.ts`,
  () => ({
    aggregateOperationalPatterns: jest.fn().mockResolvedValue([]),
  }),
  { virtual: true },
);

jest.mock(
  `${process.env.PROJECT_ROOT || require('../../../packages/core/lib/env').PROJECT_ROOT}/bots/blog/lib/experiment-os.ts`,
  () => ({
    readExperimentPlaybook: jest.fn().mockReturnValue(null),
  }),
  { virtual: true },
);

jest.mock(
  `${process.env.PROJECT_ROOT || require('../../../packages/core/lib/env').PROJECT_ROOT}/bots/blog/lib/eval-case-telemetry.ts`,
  () => ({
    readRecentBlogEvalCases: jest.fn().mockReturnValue([]),
  }),
  { virtual: true },
);

describe('strategy-evolver low exposure escalation', () => {
  const {
    computeLowExposureSignal,
    applyLowExposureFeedbackToPlan,
  } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/strategy-evolver.ts'));

  test('computeLowExposureSignal — escalation 판단', () => {
    const signal = computeLowExposureSignal([
      { day: '2026-04-25', inbound_count: 0, neighbor_posted: 1 },
      { day: '2026-04-24', inbound_count: 0, neighbor_posted: 1 },
      { day: '2026-04-23', inbound_count: 0, neighbor_posted: 0 },
      { day: '2026-04-22', inbound_count: 0, neighbor_posted: 0 },
      { day: '2026-04-21', inbound_count: 0, neighbor_posted: 0 },
    ], 3);

    expect(signal.code).toBe('low_exposure_accumulated');
    expect(signal.needsEscalation).toBe(true);
    expect(signal.consecutiveNoInboundDays).toBeGreaterThanOrEqual(3);
  });

  test('applyLowExposureFeedbackToPlan — execution directives 증폭', () => {
    const basePlan = {
      focus: [],
      recommendations: [],
      executionDirectives: {
        executionTargets: {
          neighborCommentTargetPerCycle: 2,
          sympathyTargetPerCycle: 3,
          instagramRegistrationsPerCycle: 1,
          facebookRegistrationsPerCycle: 1,
        },
        engagementPolicy: {
          outboundNeighborCommentTarget: 2,
          sympathyTarget: 3,
          lowExposureEscalationThreshold: 3,
        },
        creativePolicy: {
          reelHookIntensity: 'balanced',
          thumbnailAggro: 'medium',
        },
        titlePolicy: {
          tone: 'balanced',
        },
        hashtagPolicy: {
          mode: 'balanced',
          focusTags: [],
        },
      },
    };
    const signal = {
      code: 'low_exposure_accumulated',
      needsEscalation: true,
      threshold: 3,
      windowDays: 7,
      daysWithNoInbound: 6,
      totalInbound: 0,
      consecutiveNoInboundDays: 4,
    };

    const next = applyLowExposureFeedbackToPlan(basePlan, signal);
    expect(next.executionDirectives.executionTargets.neighborCommentTargetPerCycle).toBeGreaterThan(2);
    expect(next.executionDirectives.executionTargets.sympathyTargetPerCycle).toBeGreaterThan(3);
    expect(next.executionDirectives.creativePolicy.reelHookIntensity).toBe('high');
    expect(next.executionDirectives.hashtagPolicy.mode).toBe('aggressive');
    expect(next.executionDirectives.socialNativeRequired).toBe(true);
    expect(Array.isArray(next.focus)).toBe(true);
    expect(next.focus.join(' ')).toContain('low_exposure_accumulated');
  });
});
