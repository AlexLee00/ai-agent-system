import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MODULES_TO_RESET = [
  '../../../packages/core/lib/env.legacy.js',
  '../../../packages/core/src/utils.ts',
  '../../../packages/core/lib/llm-timeouts.js',
  '../../../packages/core/lib/llm-control/snapshot.ts',
  '../../../packages/core/lib/health-state-manager.ts',
  '../../../packages/core/lib/intent-store.ts',
  '../../../packages/core/lib/telegram-sender.ts',
];

function resetModules() {
  for (const id of MODULES_TO_RESET) {
    try {
      delete require.cache[require.resolve(id)];
    } catch {
      // Module may not have been loaded in this smoke path.
    }
  }
}

function withEnvPatch(patch: Record<string, string | null>, fn: () => void) {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(patch)) {
    previous[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    resetModules();
    fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    resetModules();
  }
}

function assertNeutralPath(label: string, value: string) {
  assert(value, `${label} must be set`);
  assert(
    !value.includes(`${path.sep}.openclaw${path.sep}`),
    `${label} must not default to an OpenClaw workspace path: ${value}`,
  );
}

function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-workspace-smoke-'));
  const agentHome = path.join(tempDir, 'agent-home');
  const expectedWorkspace = path.join(agentHome, 'workspace');
  const legacyWorkspace = path.join(tempDir, 'legacy-openclaw-workspace');

  try {
    withEnvPatch({
      AI_AGENT_HOME: agentHome,
      AI_AGENT_WORKSPACE: null,
      JAY_HOME: null,
      JAY_WORKSPACE: null,
      OPENCLAW_WORKSPACE: null,
      AI_AGENT_LOGS: null,
      JAY_LOGS: null,
      OPENCLAW_LOGS: null,
    }, () => {
      const env = require('../../../packages/core/lib/env.legacy.js');
      const utils = require('../../../packages/core/src/utils.ts');
      const timeouts = require('../../../packages/core/lib/llm-timeouts.js');
      const snapshot = require('../../../packages/core/lib/llm-control/snapshot.ts');
      const healthState = require('../../../packages/core/lib/health-state-manager.ts');
      const intentStore = require('../../../packages/core/lib/intent-store.ts');
      const telegramSender = require('../../../packages/core/lib/telegram-sender.ts');
      const pendingPaths = telegramSender._testOnly_getPendingQueuePaths();

      assert.equal(env.AI_AGENT_WORKSPACE, expectedWorkspace);
      assert.equal(env.OPENCLAW_WORKSPACE, expectedWorkspace);
      assertNeutralPath('AI_AGENT_WORKSPACE', env.AI_AGENT_WORKSPACE);
      assertNeutralPath('utils.getWorkspacePath', utils.getWorkspacePath('probe.json'));
      assertNeutralPath('llm-timeouts override', timeouts.OVERRIDE_FILE);
      assertNeutralPath('speed snapshot latest', snapshot.SPEED_TEST_LATEST_FILE);
      assertNeutralPath('health state file', healthState.STATE_FILE);
      assertNeutralPath('intent learning path', intentStore.getIntentLearningPath());
      assertNeutralPath('telegram pending file', pendingPaths.pendingFile);
      assert.equal(pendingPaths.legacyWorkspace, '');
      assert.equal(pendingPaths.legacyPendingFile, '');
    });

    withEnvPatch({
      AI_AGENT_HOME: agentHome,
      AI_AGENT_WORKSPACE: null,
      JAY_HOME: null,
      JAY_WORKSPACE: null,
      OPENCLAW_WORKSPACE: legacyWorkspace,
      AI_AGENT_LOGS: null,
      JAY_LOGS: null,
      OPENCLAW_LOGS: path.join(tempDir, 'legacy-openclaw-logs'),
    }, () => {
      const env = require('../../../packages/core/lib/env.legacy.js');
      const utils = require('../../../packages/core/src/utils.ts');
      const timeouts = require('../../../packages/core/lib/llm-timeouts.js');
      const snapshot = require('../../../packages/core/lib/llm-control/snapshot.ts');
      const healthState = require('../../../packages/core/lib/health-state-manager.ts');
      const intentStore = require('../../../packages/core/lib/intent-store.ts');

      assert.equal(env.AI_AGENT_WORKSPACE, expectedWorkspace);
      assert.equal(env.OPENCLAW_WORKSPACE, expectedWorkspace);
      assert.equal(env.AI_AGENT_LOGS, path.join(agentHome, 'logs'));
      assert.equal(env.OPENCLAW_LOGS, path.join(agentHome, 'logs'));
      assertNeutralPath('AI_AGENT_WORKSPACE with legacy env present', env.AI_AGENT_WORKSPACE);
      assertNeutralPath('utils.getWorkspacePath with legacy env present', utils.getWorkspacePath('probe.json'));
      assertNeutralPath('llm-timeouts override with legacy env present', timeouts.OVERRIDE_FILE);
      assertNeutralPath('speed snapshot latest with legacy env present', snapshot.SPEED_TEST_LATEST_FILE);
      assertNeutralPath('health state file with legacy env present', healthState.STATE_FILE);
      assertNeutralPath('intent learning path with legacy env present', intentStore.getIntentLearningPath());
    });

    console.log(JSON.stringify({
      ok: true,
      default_workspace_openclaw_free: true,
      openclaw_env_cannot_override_core_runtime_paths: true,
    }));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    resetModules();
  }
}

main();
