#!/usr/bin/env node
// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const pipeline = require('../lib/auto-dev-pipeline');
const {
  summarizeManifest,
  summarizeRuntimeState,
} = require('../lib/symphony/state-store.ts');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROTECTED_LABEL = 'ai.claude.auto-dev.autonomous';

function hasFlag(name, argv = process.argv.slice(2)) {
  return argv.includes(`--${name}`);
}

function safeExec(command, args, options = {}) {
  try {
    return {
      ok: true,
      output: execFileSync(command, args, {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: options.timeout || 10000,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      output: String(error.stdout || error.stderr || error.message || ''),
      error: error.message,
    };
  }
}

function gitStatus() {
  const result = safeExec('git', ['status', '--short']);
  const rows = result.ok ? result.output.split('\n').filter(Boolean) : [];
  return {
    ok: result.ok,
    dirty: rows.length > 0,
    rows,
    error: result.ok ? null : result.error,
  };
}

function launchdVisibility() {
  const result = safeExec('launchctl', ['list']);
  if (!result.ok) return { ok: false, visible: false, label: PROTECTED_LABEL, error: result.error };
  const line = result.output.split('\n').find((row) => row.includes(PROTECTED_LABEL)) || '';
  const parts = line.trim().split(/\s+/);
  return {
    ok: true,
    visible: Boolean(line),
    label: PROTECTED_LABEL,
    pid: parts[0] && parts[0] !== '-' ? parts[0] : null,
    lastExitStatus: parts[1] || null,
  };
}

function directClaudeCodeReferences() {
  const result = safeExec('rg', [
    '-n',
    'claude-code|resolveClaudeCliCommand|CLAUDE_CODE_CLI|CLAUDE_AUTO_DEV_CLI',
    'bots/claude/lib',
    'bots/claude/scripts',
    'bots/claude/config.json',
    'bots/claude/launchd',
  ]);
  const rows = result.output.split('\n')
    .filter(Boolean)
    .filter((row) => !row.includes('symphony-migration-audit'))
    .slice(0, 80);
  return {
    ok: result.ok || rows.length > 0,
    count: rows.length,
    rows,
  };
}

function modelRoute() {
  const runtime = pipeline.resolveAutoDevRuntimeConfig({ dryRun: true });
  return {
    profile: runtime.profile,
    symphonyMode: runtime.symphonyMode,
    implementationProvider: runtime.implementationProvider,
    implementationModel: runtime.implementationModel,
    implementationRunner: runtime.implementationRunner,
    compatibilityMode: runtime.compatibilityMode,
    modelPolicyError: runtime.modelPolicyError || null,
  };
}

function buildAuditReport() {
  const manifest = summarizeManifest();
  const runtimeState = summarizeRuntimeState();
  const status = gitStatus();
  const route = modelRoute();
  const directClaude = directClaudeCodeReferences();
  const launchd = launchdVisibility();
  const blockers = [];
  const warnings = [];

  if (status.dirty) warnings.push('dirty_worktree_present');
  if (manifest.missingActiveCount > 0) blockers.push('manifest_active_missing_docs');
  if (runtimeState.missingJobCount > 0) warnings.push('historical_enoent_jobs_present');
  if (route.implementationProvider !== 'openai-oauth' || route.implementationRunner !== 'codex') {
    blockers.push('implementation_route_not_openai_codex');
  }
  if (!launchd.visible) warnings.push('claude_auto_dev_launchd_not_visible');

  return {
    ok: blockers.length === 0,
    status: blockers.length > 0 ? 'symphony_migration_blocked' : warnings.length > 0 ? 'symphony_migration_ready_with_warnings' : 'symphony_migration_ready',
    generatedAt: new Date().toISOString(),
    mode: 'audit_only',
    blockers,
    warnings,
    manifest,
    runtimeState,
    git: status,
    modelRoute: route,
    directClaudeCodeReferences: directClaude,
    launchd,
    assumptions: {
      localAdapter: true,
      defaultSymphonyMode: 'off',
      noLaunchdMutation: true,
      noRuntimeStateMutation: true,
      noSecretDump: true,
    },
  };
}

async function main() {
  const report = buildAuditReport();
  if (hasFlag('json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`${report.status}: blockers=${report.blockers.length} warnings=${report.warnings.length}`);
  }
  if (hasFlag('fail-on-blocked') && !report.ok) process.exitCode = 1;
  return report;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`symphony-migration-audit failed: ${error?.message || error}`);
    process.exit(1);
  });
}

module.exports = {
  buildAuditReport,
};
