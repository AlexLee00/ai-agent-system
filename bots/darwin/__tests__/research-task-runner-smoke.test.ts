'use strict';

const assert = require('assert');
const Module = require('module');

const runnerPath = '/Users/alexlee/projects/ai-agent-system/bots/darwin/scripts/research-task-runner.ts';

type ModuleLoad = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;

async function main() {
  const originalLoad: ModuleLoad = Module._load as ModuleLoad;
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
    if (request === '../../../packages/core/lib/openclaw-client') {
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
    delete require.cache[runnerPath];
  }

  assert.deepStrictEqual(calls, ['ensureTaskStatusSchema', 'getPendingTasks']);
  console.log('✅ darwin task runner smoke ok');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
