'use strict';

const assert = require('assert');
const Module = require('module');

const runnerPath = '/Users/alexlee/projects/ai-agent-system/bots/darwin/scripts/research-task-runner.ts';

async function main() {
  const originalLoad = Module._load;
  const calls = [];
  const taskApi = {
    ensureTaskStatusSchema: async () => {
      calls.push('ensureTaskStatusSchema');
    },
    getPendingTasks: async () => {
      calls.push('getPendingTasks');
      return [];
    },
  };

  Module._load = function patchedLoad(request, parent, isMain) {
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
