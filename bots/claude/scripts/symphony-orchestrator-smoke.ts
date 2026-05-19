#!/usr/bin/env node
// @ts-nocheck
'use strict';

const assert = require('assert');
const {
  buildTaskPlan,
  runSymphonyOrchestratorCycle,
} = require('../lib/symphony/orchestrator.ts');
const {
  buildDispatchPlan,
  validateDispatchPlan,
} = require('../lib/symphony/team-dispatcher.ts');
const { buildReadinessReport } = require('./symphony-autonomy-readiness.ts');

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function fixtureTasks() {
  return [
    {
      id: 'task_claude_security_fixture',
      source: 'hub',
      target_team: 'claude',
      title: 'Security regression secret leak review',
      body: 'Review PR for leaked credential handling and OWASP regression.',
      priority: 'high',
      status: 'todo',
      metadata: {
        write_scope: ['bots/claude/**'],
        test_scope: ['npm --prefix bots/claude run -s check:symphony-a2a'],
      },
    },
    {
      id: 'task_luna_shadow_fixture',
      source: 'github',
      labels: ['team:luna'],
      title: 'Luna crypto candidate quality analysis',
      body: 'Analyze promotion candidate bottleneck in shadow mode only.',
      priority: 'normal',
      status: 'todo',
      metadata: {
        write_scope: ['bots/investment/**'],
        test_scope: ['npm --prefix bots/investment run -s runtime:luna-candidate-bottleneck-diagnostics -- --json --dry-run'],
      },
    },
  ];
}

async function runSmoke() {
  const securityDispatch = buildDispatchPlan(fixtureTasks()[0]);
  assert.strictEqual(securityDispatch.targetTeam, 'claude');
  assert.strictEqual(securityDispatch.agent, 'guardian');
  assert.strictEqual(validateDispatchPlan(securityDispatch).ok, true);

  const securityPlan = buildTaskPlan(fixtureTasks()[0]);
  assert.strictEqual(securityPlan.ok, true);
  assert.strictEqual(securityPlan.workspace.mutatesGit, false);
  assert.strictEqual(securityPlan.runner.preferred, true);
  assert.ok(securityPlan.validation.validators.length >= 4);
  assert.strictEqual(securityPlan.patchPayload.status, 'in_progress');
  assert.strictEqual(securityPlan.patchPayload.workspace_id, undefined);
  assert.strictEqual(
    securityPlan.patchPayload.metadata.symphonyOrchestrator.plannedWorkspace.worktreePath,
    securityPlan.workspace.worktreePath
  );

  const lunaPlan = buildTaskPlan(fixtureTasks()[1]);
  assert.strictEqual(lunaPlan.dispatch.targetTeam, 'luna');
  assert.strictEqual(lunaPlan.dispatch.agent, 'luna.lead');
  assert.strictEqual(lunaPlan.ok, true);

  const liveSensitivePlan = buildTaskPlan({
    id: 'task_luna_live_fixture',
    source: 'hub',
    target_team: 'luna',
    title: 'Luna live signal-add cutover',
    body: '실투자 live BUY signal-add 요청',
    priority: 'high',
    status: 'todo',
  });
  assert.strictEqual(liveSensitivePlan.ok, false);
  assert.ok(liveSensitivePlan.blockers.includes('luna_live_sensitive_ticket_requires_shadow_or_master_approval'));
  assert.strictEqual(liveSensitivePlan.patchPayload.status, 'blocked');

  const cycle = await runSymphonyOrchestratorCycle({
    tasks: fixtureTasks(),
    dryRun: true,
    pollHub: false,
  });
  assert.strictEqual(cycle.status, 'ready');
  assert.strictEqual(cycle.safety.mutatesHub, false);
  assert.strictEqual(cycle.safety.mutatesGit, false);
  assert.strictEqual(cycle.safety.executesRunner, false);
  assert.strictEqual(cycle.count, 2);

  const idle = await runSymphonyOrchestratorCycle({
    tasks: [],
    dryRun: true,
    pollHub: false,
  });
  assert.strictEqual(idle.status, 'idle');
  assert.strictEqual(idle.ok, true);

  const readiness = await buildReadinessReport();
  assert.strictEqual(readiness.ok, true);
  assert.ok(Array.isArray(readiness.recommendedActions));
  assert.ok(readiness.recommendedActions.every((action) => action.command));

  return {
    ok: true,
    checked: {
      dispatcher: true,
      taskPlan: true,
      lunaShadowSafety: true,
      cycleDryRun: true,
      idleCycle: true,
      readinessActions: true,
    },
  };
}

runSmoke()
  .then((result) => {
    if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
    else console.log('symphony orchestrator smoke passed');
  })
  .catch((error) => {
    console.error(`symphony orchestrator smoke failed: ${error?.message || error}`);
    process.exit(1);
  });
