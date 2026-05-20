'use strict';

/**
 * Symphony orchestrator.ts 단위 테스트
 *
 * 실행: node bots/claude/__tests__/symphony-orchestrator.test.ts
 */

const assert = require('assert');
const Module = require('module');
const path = require('path');
const os = require('os');

const ORCHESTRATOR_PATH = path.resolve(__dirname, '../lib/symphony/orchestrator.ts');

const STUB_RUNTIME = {
  dryRun: true,
  compatibilityMode: false,
  allowedTools: 'Edit,Write,Read,Glob,Grep',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  runner: 'claude',
  cliModelArg: '--model claude-sonnet-4-6',
};

const STUB_MODEL_META = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  cliModelArg: '--model claude-sonnet-4-6',
  runner: 'claude',
  source: 'stub',
};

function makePipelineStub() {
  return {
    analyzeAutoDevDocument: () => ({
      relPath: 'docs/auto_dev/TEST.md',
      contentHash: 'abc123',
      title: 'Test Task',
      lineCount: 10,
      hasFrontmatter: false,
      metadata: {},
      relatedFiles: [],
      codeRefs: [],
      searchTerms: [],
      summary: 'test summary',
    }),
    _testOnly_evaluateDocumentPolicy: () => ({
      decision: 'allow',
      targetTeam: 'claude',
      riskTier: 'normal',
      policyDecision: 'allow',
      reason: 'test',
      writeScope: ['bots/claude'],
    }),
    resolveAutoDevRuntimeConfig: () => STUB_RUNTIME,
    _testOnly_buildImplementationModelMeta: () => STUB_MODEL_META,
    AUTO_DEV_DIR: path.join(os.tmpdir(), 'test-auto-dev'),
    loadState: () => ({ jobs: {}, updatedAt: new Date().toISOString() }),
  };
}

function makeAutoDevManifestStub() {
  return {
    loadAutoDevManifest: () => ({
      entries: {},
      updatedAt: new Date().toISOString(),
    }),
  };
}

function makeSymphonyMocks() {
  const workspaceStub = {
    buildSymphonyWorkspacePlan: (_task, _opts) => ({
      mode: 'plan_only',
      root: '/tmp/test',
      workspaceRoot: '/tmp/test/symphony',
      worktreePath: '/tmp/test/symphony/task-1',
      branchName: 'codex/symphony-task-1',
      createsFiles: false,
      mutatesGit: false,
    }),
  };

  const runnerStub = {
    buildSymphonyRunnerPlan: (_task, _opts) => ({
      mode: 'plan_only',
      taskId: 'task-1',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      cliModelArg: '--model claude-sonnet-4-6',
      runner: 'claude',
      source: 'stub',
      commandFamily: 'claude_print',
      blocked: false,
      blockReason: null,
      preferred: false,
    }),
  };

  const validationStub = {
    buildSymphonyValidationPlan: (_task) => ({
      mode: 'plan_only',
      taskId: _task?.id || null,
      outputSchema: 'auto_dev_validation_chain_v1',
      validators: [
        { id: 'reviewer', required: true },
        { id: 'guardian', required: true },
        { id: 'builder', required: true },
        { id: 'test_runner', required: true },
      ],
    }),
  };

  return {
    './workspace-adapter.ts': workspaceStub,
    './runner-adapter.ts': runnerStub,
    './validation-adapter.ts': validationStub,
    '../auto-dev-pipeline': makePipelineStub(),
    '../../../../packages/core/lib/auto-dev-manifest.ts': makeAutoDevManifestStub(),
  };
}

async function withMocks(mocks, fn) {
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request in mocks) return mocks[request];
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[ORCHESTRATOR_PATH];
    return await fn(require(ORCHESTRATOR_PATH));
  } finally {
    Module._load = original;
    delete require.cache[ORCHESTRATOR_PATH];
  }
}

// ─── normalizeHubTask ────────────────────────────────────────────────────────

async function test_normalizeHubTask_basic_row() {
  await withMocks(makeSymphonyMocks(), async (orch) => {
    const row = {
      id: 'task_123',
      title: 'Deploy fix',
      source: 'hub',
      target_team: 'claude',
      status: 'todo',
      priority: 'normal',
    };
    const task = orch.normalizeHubTask(row);
    assert.strictEqual(task.id, 'task_123');
    assert.strictEqual(task.title, 'Deploy fix');
    assert.strictEqual(task.status, 'todo');
  });
  console.log('✅ normalizeHubTask: basic row normalized');
}

async function test_normalizeHubTask_camelCase_fields() {
  await withMocks(makeSymphonyMocks(), async (orch) => {
    const row = {
      id: 'task_456',
      title: 'CamelCase test',
      source: 'github',
      targetTeam: 'luna',
      workspaceId: 'ws-1',
      prUrl: 'https://github.com/pr/1',
    };
    const task = orch.normalizeHubTask(row);
    assert.strictEqual(task.id, 'task_456');
    assert.strictEqual(task.target_team, 'luna');
    assert.strictEqual(task.workspace_id, 'ws-1');
    assert.strictEqual(task.pr_url, 'https://github.com/pr/1');
  });
  console.log('✅ normalizeHubTask: camelCase fields normalized to snake_case');
}

async function test_normalizeHubTask_empty_row_defaults() {
  await withMocks(makeSymphonyMocks(), async (orch) => {
    const task = orch.normalizeHubTask({});
    assert.strictEqual(task.status, 'todo', 'status defaults to todo');
    assert.strictEqual(task.priority, 'normal', 'priority defaults to normal');
    assert.strictEqual(task.source, 'hub', 'source defaults to hub');
  });
  console.log('✅ normalizeHubTask: empty row produces safe defaults');
}

// ─── buildTaskPlan ───────────────────────────────────────────────────────────

async function test_buildTaskPlan_no_workspace_blocker_when_plan_only() {
  // workspace-adapter stub returns createsFiles:false, mutatesGit:false (plan_only)
  // → workspace 블로커가 추가되지 않아야 함
  const mocks = makeSymphonyMocks();
  await withMocks(mocks, async (orch) => {
    const task = {
      id: 'task_001',
      title: 'Fix bug',
      source: 'hub',
      target_team: 'claude',
      status: 'todo',
      priority: 'normal',
    };
    const plan = orch.buildTaskPlan(task, {});
    assert.ok(!plan.blockers.includes('workspace_adapter_must_remain_plan_only_until_approved'),
      'plan_only workspace → no workspace blocker');
    assert.ok(Array.isArray(plan.warnings));
    assert.strictEqual(plan.workspace.mode, 'plan_only');
  });
  console.log('✅ buildTaskPlan: plan_only workspace → no workspace blocker');
}

async function test_buildTaskPlan_workspace_blocker_when_mutates_git() {
  // workspace-adapter가 mutatesGit:true 반환 시 블로커 추가
  const mocks = {
    ...makeSymphonyMocks(),
    './workspace-adapter.ts': {
      buildSymphonyWorkspacePlan: () => ({
        mode: 'active',
        worktreePath: '/tmp/test/ws',
        createsFiles: true,
        mutatesGit: true,
      }),
    },
  };
  await withMocks(mocks, async (orch) => {
    const task = {
      id: 'task_002',
      title: 'Deploy patch',
      source: 'hub',
      target_team: 'claude',
      status: 'todo',
    };
    const plan = orch.buildTaskPlan(task, {});
    assert.ok(plan.blockers.includes('workspace_adapter_must_remain_plan_only_until_approved'),
      'mutatesGit:true → workspace blocker added');
  });
  console.log('✅ buildTaskPlan: mutatesGit:true workspace → workspace blocker added');
}

async function test_buildTaskPlan_luna_live_sensitive_blocker() {
  await withMocks(makeSymphonyMocks(), async (orch) => {
    const task = {
      id: 'task_luna_live',
      title: 'Strategy tune for live trading',
      source: 'hub',
      target_team: 'luna',
      status: 'todo',
      priority: 'high',
      ticket_type: 'strategy-tune',
    };
    const plan = orch.buildTaskPlan(task, {});
    assert.ok(
      plan.blockers.some((b) => b.includes('luna_live_sensitive')),
      'luna live sensitive blocker present',
    );
  });
  console.log('✅ buildTaskPlan: luna live-sensitive ticket adds blocker');
}

async function test_buildTaskPlan_missing_title_blocker() {
  await withMocks(makeSymphonyMocks(), async (orch) => {
    const task = {
      id: 'task_notitle',
      title: '',
      source: 'hub',
      target_team: 'claude',
      status: 'todo',
    };
    const plan = orch.buildTaskPlan(task, {});
    assert.ok(plan.blockers.includes('missing_task_title'), 'missing title blocker');
  });
  console.log('✅ buildTaskPlan: missing title adds blocker');
}

async function test_buildTaskPlan_has_patchPayload() {
  await withMocks(makeSymphonyMocks(), async (orch) => {
    const task = {
      id: 'task_patch',
      title: 'Monitor health',
      source: 'hub',
      target_team: 'claude',
      status: 'todo',
      priority: 'normal',
    };
    const plan = orch.buildTaskPlan(task, {});
    assert.ok(plan.patchPayload, 'patchPayload present');
    assert.ok(['blocked', 'in_progress'].includes(plan.patchPayload.status), 'patchPayload has status');
    assert.ok(plan.patchPayload.metadata?.symphonyOrchestrator, 'symphonyOrchestrator metadata present');
  });
  console.log('✅ buildTaskPlan: patchPayload has symphonyOrchestrator metadata');
}

async function test_buildTaskPlan_safety_flags_all_false() {
  await withMocks(makeSymphonyMocks(), async (orch) => {
    const result = await orch.runSymphonyOrchestratorCycle({
      tasks: [{ id: 'task_safe', title: 'Safe task', source: 'hub', target_team: 'claude', status: 'todo' }],
      dryRun: true,
      apply: false,
    });
    const safety = result.safety;
    assert.strictEqual(safety.mutatesHub, false, 'no hub mutation in dry run');
    assert.strictEqual(safety.mutatesGit, false, 'no git mutation');
    assert.strictEqual(safety.createsWorktree, false, 'no worktree creation');
    assert.strictEqual(safety.executesRunner, false, 'no runner execution');
    assert.strictEqual(safety.mutatesLaunchd, false, 'no launchd mutation');
    assert.strictEqual(safety.mutatesSecrets, false, 'no secrets mutation');
  });
  console.log('✅ runSymphonyOrchestratorCycle: all safety flags false in dry_run');
}

async function test_runSymphonyOrchestratorCycle_idle_when_no_tasks() {
  await withMocks(makeSymphonyMocks(), async (orch) => {
    const result = await orch.runSymphonyOrchestratorCycle({
      tasks: [],
      dryRun: true,
      pollHub: false,
    });
    assert.strictEqual(result.status, 'idle', 'idle when no tasks');
    assert.strictEqual(result.count, 0);
  });
  console.log('✅ runSymphonyOrchestratorCycle: idle when no tasks');
}

async function test_runSymphonyOrchestratorCycle_ready_with_tasks() {
  await withMocks(makeSymphonyMocks(), async (orch) => {
    const result = await orch.runSymphonyOrchestratorCycle({
      tasks: [
        { id: 't1', title: '모니터링 점검', source: 'hub', target_team: 'claude', status: 'todo' },
      ],
      dryRun: true,
      apply: false,
    });
    assert.ok(['ready', 'blocked'].includes(result.status), `status is ready or blocked: ${result.status}`);
    assert.strictEqual(result.count, 1);
    assert.strictEqual(result.plans.length, 1);
  });
  console.log('✅ runSymphonyOrchestratorCycle: processes tasks and returns plans');
}

async function test_runSymphonyOrchestratorCycle_mode_dry_run() {
  await withMocks(makeSymphonyMocks(), async (orch) => {
    const result = await orch.runSymphonyOrchestratorCycle({
      tasks: [{ id: 't2', title: 'Test task', source: 'hub', target_team: 'claude', status: 'todo' }],
      dryRun: true,
    });
    assert.strictEqual(result.mode, 'dry_run_plan');
    assert.strictEqual(result.dryRun, true);
  });
  console.log('✅ runSymphonyOrchestratorCycle: dry_run mode correct');
}

async function test_runSymphonyOrchestratorCycle_maxTasks_clamped() {
  await withMocks(makeSymphonyMocks(), async (orch) => {
    const manyTasks = Array.from({ length: 60 }, (_, i) => ({
      id: `t${i}`,
      title: `Task ${i}`,
      source: 'hub',
      target_team: 'claude',
      status: 'todo',
    }));
    const result = await orch.runSymphonyOrchestratorCycle({
      tasks: manyTasks,
      maxTasks: 5,
      dryRun: true,
    });
    assert.strictEqual(result.count, 5, 'maxTasks=5 clamps to 5');
  });
  console.log('✅ runSymphonyOrchestratorCycle: maxTasks clamps task count');
}

// ─── 실행 ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Symphony Orchestrator 테스트 시작 ===\n');
  const tests = [
    test_normalizeHubTask_basic_row,
    test_normalizeHubTask_camelCase_fields,
    test_normalizeHubTask_empty_row_defaults,
    test_buildTaskPlan_no_workspace_blocker_when_plan_only,
    test_buildTaskPlan_workspace_blocker_when_mutates_git,
    test_buildTaskPlan_luna_live_sensitive_blocker,
    test_buildTaskPlan_missing_title_blocker,
    test_buildTaskPlan_has_patchPayload,
    test_buildTaskPlan_safety_flags_all_false,
    test_runSymphonyOrchestratorCycle_idle_when_no_tasks,
    test_runSymphonyOrchestratorCycle_ready_with_tasks,
    test_runSymphonyOrchestratorCycle_mode_dry_run,
    test_runSymphonyOrchestratorCycle_maxTasks_clamped,
  ];

  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t();
      passed++;
    } catch (e) {
      console.error(`❌ ${t.name}: ${e.message}`);
      failed++;
    }
  }

  console.log(`\n결과: ${passed}/${tests.length} 통과`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
