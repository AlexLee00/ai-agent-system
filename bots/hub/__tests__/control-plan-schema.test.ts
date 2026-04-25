'use strict';

describe('hub control plan schema', () => {
  test('accepts valid plan with playbook phases', () => {
    const { parseControlPlan } = require('../lib/control/plan-schema.ts');
    const input = {
      goal: '루나팀 상태 점검',
      team: 'luna',
      risk: 'low',
      requiresApproval: false,
      dryRun: true,
      steps: [
        { id: 's1', tool: 'hub.health.query', args: { team: 'luna' }, sideEffect: 'read_only' },
      ],
      verify: [{ tool: 'hub.health.query', args: { team: 'luna', minutes: 30 } }],
      playbook: {
        phases: [
          { phase: 'frame', objective: 'frame', checks: ['a'] },
          { phase: 'plan', objective: 'plan', checks: ['a'] },
          { phase: 'review', objective: 'review', checks: ['a'] },
          { phase: 'test', objective: 'test', checks: ['a'] },
          { phase: 'ship', objective: 'ship', checks: ['a'] },
          { phase: 'reflect', objective: 'reflect', checks: ['a'] },
        ],
      },
      metadata: {},
    };

    const parsed = parseControlPlan(input);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.team).toBe('luna');
    expect(parsed.data.steps).toHaveLength(1);
  });

  test('rejects invalid request without message/goal', () => {
    const { parseControlPlanRequest } = require('../lib/control/plan-schema.ts');
    const parsed = parseControlPlanRequest({ team: 'luna' });
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe('invalid_control_plan_request');
  });
});
