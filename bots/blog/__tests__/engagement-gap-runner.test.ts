'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');

const runner = require(path.join(env.PROJECT_ROOT, 'bots/blog/scripts/run-engagement-gap.ts'));

describe('engagement gap runner', () => {
  test('buildTargetQueue — 댓글 workload가 없어도 low exposure 전략 fallback을 생성', () => {
    const queue = runner.buildTargetQueue({
      runPlan: [],
      exposureSignal: {
        code: 'low_exposure_accumulated',
        needsStrategy: true,
        windowDays: 5,
        daysWithNoInbound: 4,
        totalInbound: 0,
      },
      primary: {
        area: 'engagement.strategy.visibility',
        nextCommand: 'npm --prefix /repo/bots/blog run revenue:strategy -- --dry-run --json',
      },
    });

    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      label: 'low_exposure_strategy',
      signalCode: 'low_exposure_accumulated',
      source: 'engagement_exposure_signal',
    });
    expect(queue[0].command).toContain('revenue:strategy');
  });

  test('buildTargetQueue — preferred signal code로 low exposure fallback을 우선 실행', () => {
    const queue = runner.buildTargetQueue({
      runPlan: [
        { label: 'neighbor', command: 'node run-neighbor-commenter.ts' },
      ],
      exposureSignal: {
        needsStrategy: true,
        daysWithNoInbound: 3,
        totalInbound: 0,
      },
    }, 'low_exposure_accumulated');

    expect(queue[0].label).toBe('low_exposure_strategy');
    expect(queue[0].signalCode).toBe('low_exposure_accumulated');
    expect(queue[1].label).toBe('neighbor');
  });
});
