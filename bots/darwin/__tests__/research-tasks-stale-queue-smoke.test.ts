'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const tasksPath = path.join(__dirname, '../lib/research-tasks.ts');

type ModuleLoad = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;

async function main() {
  const originalLoad: ModuleLoad = Module._load as ModuleLoad;
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-stale-queue-'));
  const taskDir = path.join(tmpRoot, 'docs/research/tasks');
  fs.mkdirSync(taskDir, { recursive: true });

  const writeTask = (task: Record<string, unknown>) => {
    fs.writeFileSync(path.join(taskDir, `${task.id}.json`), JSON.stringify(task, null, 2), 'utf8');
  };

  writeTask({
    id: 'TASK-PENDING',
    title: 'Normal pending task',
    type: 'github_analysis',
    status: 'pending',
    priority: 2,
    created_at: '2026-05-25T00:00:00.000Z',
  });
  writeTask({
    id: 'TASK-STALE',
    title: 'Stale running task',
    type: 'github_analysis',
    status: 'pending',
    priority: 1,
    created_at: '2026-05-25T00:00:01.000Z',
  });
  writeTask({
    id: 'TASK-FRESH',
    title: 'Fresh running task',
    type: 'github_analysis',
    status: 'pending',
    priority: 1,
    created_at: '2026-05-25T00:00:02.000Z',
  });

  const statusRows = [
    {
      task_id: 'TASK-STALE',
      status: 'running',
      started_at: '2026-05-24T18:00:00.000Z',
      completed_at: null,
      runtime: {},
      updated_at: '2026-05-24T18:00:00.000Z',
    },
    {
      task_id: 'TASK-FRESH',
      status: 'running',
      started_at: '2026-05-25T01:58:00.000Z',
      completed_at: null,
      runtime: {},
      updated_at: '2026-05-25T01:58:00.000Z',
    },
  ];

  Module._load = function patchedLoad(request: string, parent: NodeModule | null, isMain: boolean) {
    if (String(request).endsWith('packages/core/lib/hub-client')) {
      return { callHubLlm: async () => ({ text: '' }) };
    }
    if (String(request).endsWith('packages/core/lib/pg-pool')) {
      return {
        run: async () => undefined,
        query: async (_schema: string, _sql: string, params: unknown[]) => {
          const ids = new Set((params?.[0] as string[]) || []);
          return statusRows.filter((row) => ids.has(row.task_id));
        },
      };
    }
    if (String(request).endsWith('packages/core/lib/github-client')) {
      return {};
    }
    if (String(request).endsWith('packages/core/lib/env')) {
      return { PROJECT_ROOT: tmpRoot };
    }
    if (String(request).endsWith('packages/core/lib/skills/darwin/github-analysis.js')) {
      return {
        analyzeRepoStructure: () => ({}),
        extractCodePatterns: () => ({}),
        generateAnalysisSummary: () => ({ summary: '' }),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[tasksPath];
    const taskApi = require(tasksPath);
    const now = '2026-05-25T02:00:00.000Z';

    assert.throws(() => taskApi.createTask({ id: '../escape', type: 'github_analysis' }), /invalid_task_id/);
    assert.throws(() => taskApi._testOnly_safeSkillTarget('../outside', 'safe'), /invalid_skill_category/);
    assert.throws(() => taskApi._testOnly_safeSkillTarget('shared', '../outside'), /invalid_skill_name/);

    const normalPending = await taskApi.getPendingTasks({ now, staleRunningMs: 60 * 60 * 1000 });
    assert.deepStrictEqual(normalPending.map((task: { id: string }) => task.id), ['TASK-PENDING']);

    const recoveredPending = await taskApi.getPendingTasks({
      now,
      includeStaleRunning: true,
      staleRunningMs: 60 * 60 * 1000,
    });
    assert.deepStrictEqual(
      recoveredPending.map((task: { id: string }) => task.id),
      ['TASK-STALE', 'TASK-PENDING'],
    );

    const staleTask = recoveredPending.find((task: { id: string }) => task.id === 'TASK-STALE');
    assert.strictEqual(staleTask.status, 'pending');
    assert.strictEqual(staleTask.stale_recovered, true);
    assert.strictEqual(staleTask.stale_previous_status, 'running');
  } finally {
    Module._load = originalLoad;
    delete require.cache[tasksPath];
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  console.log('✅ darwin research tasks stale queue smoke ok');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
