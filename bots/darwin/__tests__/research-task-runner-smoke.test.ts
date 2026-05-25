'use strict';

const assert = require('assert');
const Module = require('module');
const path = require('path');

const runnerPath = path.join(__dirname, '../scripts/research-task-runner.ts');

type ModuleLoad = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;

async function main() {
  const originalLoad: ModuleLoad = Module._load as ModuleLoad;
  const originalArgv = process.argv;
  const originalLog = console.log;
  const calls: string[] = [];
  const taskApi = {
    ensureTaskStatusSchema: async () => {
      calls.push('ensureTaskStatusSchema');
    },
    getPendingTasks: async () => {
      calls.push('getPendingTasks');
      return [];
    },
  };

  Module._load = function patchedLoad(request: string, parent: NodeModule | null, isMain: boolean) {
    if (request === '../lib/research-tasks') {
      return taskApi;
    }
    if (request === '../../../packages/core/lib/hub-alarm-client') {
      return { postAlarm: async () => {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[runnerPath];
    require(runnerPath);
    await new Promise((resolve) => setTimeout(resolve, 25));
  } finally {
    Module._load = originalLoad;
    process.argv = originalArgv;
    console.log = originalLog;
    delete require.cache[runnerPath];
  }

  assert.deepStrictEqual(calls, ['ensureTaskStatusSchema', 'getPendingTasks']);

  const dryRunCalls: string[] = [];
  const dryRunOutput: string[] = [];
  const dryRunTaskApi = {
    ensureTaskStatusSchema: async () => {
      dryRunCalls.push('ensureTaskStatusSchema');
    },
    getPendingTasks: async (options: { skipRuntimeStatus?: boolean } = {}) => {
      dryRunCalls.push(`getPendingTasks:${options.skipRuntimeStatus === true}`);
      return [{
        id: 'TASK-DRY',
        type: 'github_analysis',
        title: 'Dry-run repo analysis',
        target: { owner: 'owner', repo: 'repo' },
      }];
    },
    executeGitHubAnalysis: async () => {
      dryRunCalls.push('executeGitHubAnalysis');
      throw new Error('must_not_execute');
    },
  };

  Module._load = function patchedDryRunLoad(request: string, parent: NodeModule | null, isMain: boolean) {
    if (request === '../lib/research-tasks') {
      return dryRunTaskApi;
    }
    if (request === '../../../packages/core/lib/hub-alarm-client') {
      return { postAlarm: async () => { throw new Error('must_not_post_alarm'); } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  process.argv = ['node', runnerPath, '--dry-run', '--json'];
  console.log = (...args: unknown[]) => {
    dryRunOutput.push(args.map(String).join(' '));
  };

  try {
    delete require.cache[runnerPath];
    require(runnerPath);
    await new Promise((resolve) => setTimeout(resolve, 25));
  } finally {
    Module._load = originalLoad;
    process.argv = originalArgv;
    console.log = originalLog;
    delete require.cache[runnerPath];
  }

  assert.deepStrictEqual(dryRunCalls, ['getPendingTasks:true']);
  const dryRunJson = JSON.parse(dryRunOutput.join('\n'));
  assert.strictEqual(dryRunJson.dryRun, true);
  assert.strictEqual(dryRunJson.pending, 1);
  assert.strictEqual(dryRunJson.executed, 0);
  assert.strictEqual(dryRunJson.alarmSent, 0);
  assert.strictEqual(dryRunJson.gitMutations, 0);
  console.log('✅ darwin task runner smoke ok');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
