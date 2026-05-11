#!/usr/bin/env node
// @ts-nocheck
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const pipeline = require('../lib/auto-dev-pipeline');
const { loadAutoDevManifest } = require('../../../packages/core/lib/auto-dev-manifest.ts');
const {
  buildSymphonyTaskFromDocument,
  compareTaskWithLegacy,
} = require('../lib/symphony/task-adapter.ts');
const { buildSymphonyWorkspacePlan } = require('../lib/symphony/workspace-adapter.ts');
const { buildSymphonyRunnerPlan } = require('../lib/symphony/runner-adapter.ts');
const { buildSymphonyValidationPlan } = require('../lib/symphony/validation-adapter.ts');

const OUTPUT_DIR = path.resolve(__dirname, '..', 'output', 'symphony-shadow');
const ACTIVE_STATES = new Set(['inbox', 'claimed', 'active']);

function hasFlag(name, argv = process.argv.slice(2)) {
  return argv.includes(`--${name}`);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function fixtureDocument() {
  return [
    '---',
    'target_team: claude',
    'owner_agent: codex',
    'risk_tier: normal',
    'task_type: development_task',
    'write_scope:',
    '  - bots/claude/**',
    'test_scope:',
    '  - npm --prefix bots/claude run test:auto-dev',
    'autonomy_level: supervised_l4',
    'requires_live_execution: false',
    '---',
    '',
    '# Symphony Fixture',
    '',
    'Validate that the Symphony local adapter preserves auto_dev policy metadata.',
  ].join('\n');
}

function activeDocumentPaths() {
  const manifest = loadAutoDevManifest(pipeline.AUTO_DEV_DIR);
  return Object.values(manifest.entries || {})
    .filter((entry) => ACTIVE_STATES.has(String(entry.state || '')))
    .map((entry) => path.join(path.resolve(__dirname, '..', '..', '..'), entry.relPath))
    .filter((filePath) => fs.existsSync(filePath));
}

function buildShadowForDocument(filePath, options = {}) {
  const content = options.content == null ? null : String(options.content);
  const task = buildSymphonyTaskFromDocument(filePath, { content, source: options.source || 'shadow' });
  const runtimeConfig = pipeline.resolveAutoDevRuntimeConfig({ dryRun: true });
  return {
    task,
    comparison: compareTaskWithLegacy(task),
    workspace: buildSymphonyWorkspacePlan(task),
    runner: buildSymphonyRunnerPlan(task, { runtimeConfig }),
    validation: buildSymphonyValidationPlan(task),
  };
}

function writeOutput(report) {
  ensureDir(OUTPUT_DIR);
  const fileName = `symphony-shadow-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const filePath = path.join(OUTPUT_DIR, fileName);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf8');
  return filePath;
}

async function runShadow({ fixture = false, noWrite = false } = {}) {
  const docs = fixture
    ? [{
        filePath: path.join(pipeline.AUTO_DEV_DIR, 'ALARM_INCIDENT_SYMPHONY_FIXTURE.md'),
        content: fixtureDocument(),
        source: 'fixture',
      }]
    : activeDocumentPaths().map((filePath) => ({ filePath, content: null, source: 'active_manifest' }));

  const results = docs.map((doc) => buildShadowForDocument(doc.filePath, doc));
  const blockers = [];
  for (const result of results) {
    if (result.task.status === 'ready' && result.runner.blocked) blockers.push(`runner_blocked:${result.task.sourcePath}`);
    if (!result.comparison.checks.writeScopePreserved) blockers.push(`write_scope_missing:${result.task.sourcePath}`);
    if (!result.comparison.checks.testScopePreserved) blockers.push(`test_scope_missing:${result.task.sourcePath}`);
  }
  const report = {
    ok: blockers.length === 0,
    status: blockers.length > 0 ? 'symphony_shadow_blocked' : 'symphony_shadow_ready',
    generatedAt: new Date().toISOString(),
    mode: 'shadow_only',
    fixture,
    count: results.length,
    blockers,
    results,
    outputPolicy: {
      writesRepoTrackedFiles: false,
      outputDir: noWrite ? null : path.relative(path.resolve(__dirname, '..', '..', '..'), OUTPUT_DIR),
    },
  };
  if (!noWrite) {
    report.outputPath = path.relative(path.resolve(__dirname, '..', '..', '..'), writeOutput(report));
  }
  return report;
}

async function main() {
  const report = await runShadow({
    fixture: hasFlag('fixture'),
    noWrite: hasFlag('no-write'),
  });
  if (hasFlag('json')) console.log(JSON.stringify(report, null, 2));
  else console.log(`${report.status}: tasks=${report.count} blockers=${report.blockers.length}`);
  if (hasFlag('fail-on-blocked') && !report.ok) process.exitCode = 1;
  return report;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`symphony-shadow-runner failed: ${error?.message || error}`);
    process.exit(1);
  });
}

module.exports = {
  fixtureDocument,
  runShadow,
};
