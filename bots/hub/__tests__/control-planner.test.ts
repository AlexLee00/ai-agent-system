'use strict';

describe('hub control planner', () => {
  const originalForceHeuristic = process.env.HUB_CONTROL_PLANNER_FORCE_HEURISTIC;

  beforeAll(() => {
    process.env.HUB_CONTROL_PLANNER_FORCE_HEURISTIC = '1';
  });

  afterAll(() => {
    if (originalForceHeuristic == null) delete process.env.HUB_CONTROL_PLANNER_FORCE_HEURISTIC;
    else process.env.HUB_CONTROL_PLANNER_FORCE_HEURISTIC = originalForceHeuristic;
  });

  test('creates dry-run plan with playbook phases', async () => {
    const { generateControlPlanDraft } = require('../lib/control/planner.ts');
    const result = await generateControlPlanDraft({
      message: '루나팀 상태 점검하고 조치해줘',
      team: 'luna',
      dryRun: true,
    });
    expect(result.ok).toBe(true);
    expect(result.plan.dryRun).toBe(true);
    expect(result.plan.team).toBe('luna');
    expect(result.plan.playbook.phases.length).toBeGreaterThanOrEqual(6);
  });
});
