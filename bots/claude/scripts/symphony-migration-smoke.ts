#!/usr/bin/env node
// @ts-nocheck
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pipeline = require('../lib/auto-dev-pipeline');
const {
  buildSymphonyTaskFromDocument,
} = require('../lib/symphony/task-adapter.ts');
const { buildSymphonyWorkspacePlan } = require('../lib/symphony/workspace-adapter.ts');
const { buildSymphonyRunnerPlan } = require('../lib/symphony/runner-adapter.ts');
const { buildSymphonyValidationPlan } = require('../lib/symphony/validation-adapter.ts');
const { summarizeManifest, summarizeRuntimeState } = require('../lib/symphony/state-store.ts');
const { buildAuditReport, classifyGitStatusRows } = require('./symphony-migration-audit.ts');
const { fixtureDocument, runShadow } = require('./symphony-shadow-runner.ts');

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

async function runSmoke() {
  assert.strictEqual(pipeline._testOnly_normalizeSymphonyMode('shadow'), 'shadow');
  assert.strictEqual(pipeline._testOnly_normalizeSymphonyMode('bad-mode'), 'off');

  const fixturePath = path.join(pipeline.AUTO_DEV_DIR, 'ALARM_INCIDENT_SYMPHONY_FIXTURE.md');
  const task = buildSymphonyTaskFromDocument(fixturePath, {
    content: fixtureDocument(),
    source: 'fixture',
  });
  assert.strictEqual(task.status, 'ready');
  assert.strictEqual(task.metadata.targetTeam, 'claude');
  assert.deepStrictEqual(task.scope.write, ['bots/claude/**']);
  assert.deepStrictEqual(task.scope.test, ['npm --prefix bots/claude run test:auto-dev']);

  const workspace = buildSymphonyWorkspacePlan(task);
  assert.strictEqual(workspace.mutatesGit, false);
  assert.strictEqual(workspace.createsFiles, false);

  const runner = buildSymphonyRunnerPlan(task, {
    runtimeConfig: pipeline.resolveAutoDevRuntimeConfig({ dryRun: true }),
  });
  assert.strictEqual(runner.preferred, true);
  assert.strictEqual(runner.blocked, false);
  assert.strictEqual(runner.provider, 'openai-oauth');

  const validation = buildSymphonyValidationPlan(task);
  assert.strictEqual(validation.preservesLegacySchema, true);
  assert.strictEqual(validation.relaxesWriteScope, false);
  assert.ok(validation.validators.length >= 4);

  const manifest = summarizeManifest();
  assert.ok(Number.isFinite(manifest.total));
  assert.ok(Number.isFinite(manifest.activeCount));

  const runtimeState = summarizeRuntimeState();
  assert.ok(Number.isFinite(runtimeState.total));
  assert.ok(Number.isFinite(runtimeState.historicalStateCount));

  const audit = buildAuditReport();
  assert.ok(audit.status.startsWith('symphony_migration_'));
  assert.strictEqual(audit.modelRoute.implementationProvider, 'openai-oauth');
  assert.ok(['installed_launchd_plist', 'repo_launchd_plist'].includes(audit.modelRoute.source));
  assert.strictEqual(audit.launchdConfig.repo.hasSymphonyMode, true);
  assert.ok(Array.isArray(audit.notices));

  const dirtyClassification = classifyGitStatusRows([
    ' M output/metty-trace-state.json',
    ' M bots/claude/src/reviewer.ts',
  ]);
  assert.deepStrictEqual(dirtyClassification.externalDirtyPaths, ['output/metty-trace-state.json']);
  assert.deepStrictEqual(dirtyClassification.operationalDirtyPaths, ['bots/claude/src/reviewer.ts']);

  const offScopeDirty = pipeline._testOnly_partitionDirtyBaseForWriteScope(
    ['output/metty-trace-state.json'],
    ['bots/claude/**']
  );
  assert.strictEqual(offScopeDirty.hasBlocking, false);
  assert.deepStrictEqual(offScopeDirty.ignored, ['output/metty-trace-state.json']);

  const scopedDirty = pipeline._testOnly_partitionDirtyBaseForWriteScope(
    ['bots/claude/src/reviewer.ts'],
    ['bots/claude/**']
  );
  assert.strictEqual(scopedDirty.hasBlocking, true);

  const integrationConflicts = pipeline._testOnly_findDirtyPathConflicts(
    ['output/metty-trace-state.json', 'bots/claude/src/reviewer.ts'],
    ['bots/claude/src/reviewer.ts']
  );
  assert.deepStrictEqual(integrationConflicts, ['bots/claude/src/reviewer.ts']);

  const tmpBin = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-node-bin-'));
  const fakeNode = path.join(tmpBin, 'node');
  fs.writeFileSync(fakeNode, '#!/bin/sh\nexit 0\n', 'utf8');
  fs.chmodSync(fakeNode, 0o755);
  assert.strictEqual(
    pipeline._testOnly_resolveNodeExecutable({
      execPath: '/opt/homebrew/Cellar/node/missing/bin/node',
      pathEnv: tmpBin,
    }),
    fakeNode
  );
  fs.rmSync(tmpBin, { recursive: true, force: true });

  const shadow = await runShadow({ fixture: true, noWrite: true });
  assert.strictEqual(shadow.ok, true);
  assert.strictEqual(shadow.count, 1);
  assert.strictEqual(shadow.results[0].task.runner.provider, 'openai-oauth');

  return {
    ok: true,
    checked: {
      symphonyMode: true,
      taskAdapter: true,
      workspaceAdapter: true,
      runnerAdapter: true,
      validationAdapter: true,
      stateStore: true,
      audit: true,
      shadowNoWrite: true,
    },
  };
}

runSmoke()
  .then((result) => {
    if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
    else console.log('✅ symphony migration smoke passed');
  })
  .catch((error) => {
    console.error(`❌ symphony migration smoke failed: ${error?.message || error}`);
    process.exit(1);
  });
