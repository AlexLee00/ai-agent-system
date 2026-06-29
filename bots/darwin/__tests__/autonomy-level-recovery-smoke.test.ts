'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const autonomyPath = path.join(__dirname, '../lib/autonomy-level.ts');

type ModuleLoad = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;

function resetState(api: any, state: Record<string, unknown>) {
  return api.saveState({
    level: 'L3',
    reason: 'fixture',
    error_count: 0,
    last_error: null,
    consecutiveSuccesses: 0,
    appliedSuccesses: 0,
    ...state,
  });
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-autonomy-recovery-'));
  const originalLoad: ModuleLoad = Module._load as ModuleLoad;
  const originalAutonomyLevel = process.env.DARWIN_AUTONOMY_LEVEL;
  const originalKillSwitch = process.env.DARWIN_KILL_SWITCH;

  Module._load = function patchedLoad(request: string, parent: NodeModule | null, isMain: boolean) {
    if (request === '../../../packages/core/lib/env' || String(request).endsWith('packages/core/lib/env')) {
      return { PROJECT_ROOT: tmpRoot };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete process.env.DARWIN_AUTONOMY_LEVEL;
    delete process.env.DARWIN_KILL_SWITCH;
    delete require.cache[autonomyPath];
    const autonomy = require(autonomyPath);

    resetState(autonomy, { level: 'L3', consecutiveSuccesses: 0, appliedSuccesses: 0 });
    for (let i = 0; i < 5; i += 1) autonomy.recordVerifiedSuccess();
    let state = autonomy.loadState();
    assert.strictEqual(state.level, 'L4');
    assert.strictEqual(state.reason, 'auto_recovery');
    assert.strictEqual(state.consecutiveSuccesses, 5);
    assert.strictEqual(state.appliedSuccesses, 0);
    assert.ok(state.upgradedAt);

    resetState(autonomy, { level: 'L4', consecutiveSuccesses: 0, appliedSuccesses: 0 });
    for (let i = 0; i < 10; i += 1) autonomy.recordVerifiedSuccess();
    for (let i = 0; i < 3; i += 1) autonomy.recordMergeSuccess();
    state = autonomy.loadState();
    assert.strictEqual(state.level, 'L5');
    assert.strictEqual(state.reason, 'auto_recovery');
    assert.strictEqual(state.consecutiveSuccesses, 10);
    assert.strictEqual(state.appliedSuccesses, 3);

    resetState(autonomy, { level: 'L4', consecutiveSuccesses: 0, appliedSuccesses: 2 });
    autonomy.recordVerifiedSuccess();
    state = autonomy.loadState();
    assert.strictEqual(state.consecutiveSuccesses, 1);
    assert.strictEqual(state.appliedSuccesses, 2);

    resetState(autonomy, { level: 'L4', consecutiveSuccesses: 4, appliedSuccesses: 2, error_count: 1 });
    autonomy.recordError(new Error('verification failed'));
    state = autonomy.loadState();
    assert.strictEqual(state.level, 'L3');
    assert.strictEqual(state.consecutiveSuccesses, 0);
    assert.strictEqual(state.error_count, 2);
    assert.match(state.last_error, /verification failed/);

    resetState(autonomy, { level: 'L3', consecutiveSuccesses: 4, appliedSuccesses: 0 });
    process.env.DARWIN_KILL_SWITCH = 'true';
    autonomy.recordVerifiedSuccess();
    state = autonomy.loadState();
    assert.strictEqual(state.level, 'L3');
    assert.strictEqual(state.consecutiveSuccesses, 5);
    assert.strictEqual(state.reason, 'promotion_blocked_by_kill_switch');
    delete process.env.DARWIN_KILL_SWITCH;

    resetState(autonomy, { level: 'L3', consecutiveSuccesses: 0, appliedSuccesses: 0 });
    process.env.DARWIN_AUTONOMY_LEVEL = 'L5';
    state = autonomy.loadState();
    assert.strictEqual(state.level, 'L5');
    delete process.env.DARWIN_AUTONOMY_LEVEL;

    resetState(autonomy, { level: 'L4', consecutiveSuccesses: 8, appliedSuccesses: 2, error_count: 1 });
    autonomy.recordMergeFailure(new Error('merge conflict'));
    state = autonomy.loadState();
    assert.strictEqual(state.level, 'L4');
    assert.strictEqual(state.consecutiveSuccesses, 0);
    assert.strictEqual(state.appliedSuccesses, 2);
    assert.strictEqual(state.error_count, 1);
    assert.strictEqual(state.reason, 'merge_failed_after_verification');
    assert.match(state.last_error, /merge conflict/);

    console.log('✅ darwin autonomy recovery smoke ok');
  } finally {
    Module._load = originalLoad;
    if (originalAutonomyLevel === undefined) delete process.env.DARWIN_AUTONOMY_LEVEL;
    else process.env.DARWIN_AUTONOMY_LEVEL = originalAutonomyLevel;
    if (originalKillSwitch === undefined) delete process.env.DARWIN_KILL_SWITCH;
    else process.env.DARWIN_KILL_SWITCH = originalKillSwitch;
    delete require.cache[autonomyPath];
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
