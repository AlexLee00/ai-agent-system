#!/usr/bin/env tsx
import assert from 'node:assert/strict';

async function main() {
  const originalForceHeuristic = process.env.HUB_CONTROL_PLANNER_FORCE_HEURISTIC;
  process.env.HUB_CONTROL_PLANNER_FORCE_HEURISTIC = '1';
  try {
    const { generateControlPlanDraft } = require('../lib/control/planner.ts');
    const result = await generateControlPlanDraft({
      message: '루나팀 재평가 루프 점검 후 조치안을 만들어줘',
      team: 'luna',
      dryRun: true,
    });
    assert.equal(result?.ok, true, 'planner draft should succeed');
    assert.equal(result?.plan?.team, 'luna');
    assert.ok(Array.isArray(result?.plan?.steps), 'plan steps required');
    assert.ok(result.plan.steps.length >= 1, 'at least one step');
    assert.ok(Array.isArray(result?.plan?.playbook?.phases), 'playbook phases required');
    assert.ok(result.plan.playbook.phases.length >= 6, 'six-phase playbook required');
    console.log('jay_formation_decision_llm_smoke_ok');
  } finally {
    if (originalForceHeuristic == null) delete process.env.HUB_CONTROL_PLANNER_FORCE_HEURISTIC;
    else process.env.HUB_CONTROL_PLANNER_FORCE_HEURISTIC = originalForceHeuristic;
  }
}

main().catch((error) => {
  console.error(`jay_formation_decision_llm_smoke_failed: ${error?.message || error}`);
  process.exit(1);
});
