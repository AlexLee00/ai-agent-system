#!/usr/bin/env node
// @ts-nocheck
'use strict';

const assert = require('assert');
const path = require('path');
const pipeline = require('../lib/auto-dev-pipeline');
const {
  buildSymphonyTaskFromDocument,
} = require('../lib/symphony/task-adapter.ts');
const { buildSymphonyWorkspacePlan } = require('../lib/symphony/workspace-adapter.ts');
const { buildSymphonyRunnerPlan } = require('../lib/symphony/runner-adapter.ts');
const { buildSymphonyValidationPlan } = require('../lib/symphony/validation-adapter.ts');
const { summarizeManifest, summarizeRuntimeState } = require('../lib/symphony/state-store.ts');
const { buildAuditReport } = require('./symphony-migration-audit.ts');
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
