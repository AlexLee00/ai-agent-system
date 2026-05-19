#!/usr/bin/env node
// @ts-nocheck
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const pipeline = require('../lib/auto-dev-pipeline');
const {
  summarizeManifest,
  summarizeRuntimeState,
} = require('../lib/symphony/state-store.ts');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROTECTED_LABEL = 'ai.claude.auto-dev.autonomous';
const DEFAULT_OPERATIONAL_DIRTY_PREFIXES = [
  'bots/claude',
  'docs/auto_dev',
  'packages/core/lib/auto-dev-manifest.ts',
  'packages/core/lib/runtime-env-policy.js',
  'packages/core/lib/env.js',
];
const REPO_AUTONOMOUS_PLIST = path.join(ROOT, 'bots/claude/launchd/ai.claude.auto-dev.autonomous.plist');
const INSTALLED_AUTONOMOUS_PLIST = path.join(os.homedir(), 'Library/LaunchAgents/ai.claude.auto-dev.autonomous.plist');

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

function normalizeRelPath(value) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function extractChangedPath(statusLine) {
  if (String(statusLine || '').startsWith('[')) return null;
  const body = String(statusLine || '').slice(3).trim();
  if (!body) return null;
  const renamedParts = body.split(' -> ');
  return normalizeRelPath(renamedParts[renamedParts.length - 1] || body) || null;
}

function pathMatchesPrefix(filePath, prefix) {
  const file = normalizeRelPath(filePath);
  const normalizedPrefix = normalizeRelPath(prefix).replace(/\/\*\*$/, '').replace(/\/\*$/, '').replace(/\/$/, '');
  if (!file || !normalizedPrefix) return false;
  return file === normalizedPrefix || file.startsWith(`${normalizedPrefix}/`);
}

function classifyGitStatusRows(rows = [], prefixes = DEFAULT_OPERATIONAL_DIRTY_PREFIXES) {
  const changedPaths = rows.map(extractChangedPath).filter(Boolean);
  const operationalDirtyPaths = changedPaths.filter((filePath) => {
    return prefixes.some((prefix) => pathMatchesPrefix(filePath, prefix));
  });
  const externalDirtyPaths = changedPaths.filter((filePath) => !operationalDirtyPaths.includes(filePath));
  return {
    changedPaths,
    operationalDirtyPaths,
    externalDirtyPaths,
    operationalDirty: operationalDirtyPaths.length > 0,
    externalDirty: externalDirtyPaths.length > 0,
    prefixes,
  };
}

function gitStatus() {
  const result = safeExec('git', ['status', '--short']);
  const rows = result.ok ? result.output.split('\n').filter(Boolean) : [];
  const classified = classifyGitStatusRows(rows);
  return {
    ok: result.ok,
    dirty: rows.length > 0,
    operationalDirty: classified.operationalDirty,
    externalDirty: classified.externalDirty,
    rows,
    changedPaths: classified.changedPaths,
    operationalDirtyPaths: classified.operationalDirtyPaths,
    externalDirtyPaths: classified.externalDirtyPaths,
    operationalDirtyPrefixes: classified.prefixes,
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

function readLaunchdEnvironment(plistPath = REPO_AUTONOMOUS_PLIST) {
  try {
    const text = fs.readFileSync(plistPath, 'utf8');
    const envMatch = text.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/);
    const body = envMatch ? envMatch[1] : '';
    const envVars = {};
    const pattern = /<key>([^<]+)<\/key>\s*<string>([\s\S]*?)<\/string>/g;
    let match = null;
    while ((match = pattern.exec(body)) !== null) {
      envVars[match[1]] = match[2];
    }
    return {
      ok: true,
      path: plistPath,
      env: envVars,
    };
  } catch (error) {
    return {
      ok: false,
      path: plistPath,
      env: {},
      error: error.message,
    };
  }
}

function modelRoute(envVars = process.env, source = 'current_process') {
  const runtime = pipeline.resolveAutoDevRuntimeConfig({ dryRun: true }, envVars);
  return {
    source,
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
  const repoLaunchdConfig = readLaunchdEnvironment(REPO_AUTONOMOUS_PLIST);
  const installedLaunchdConfig = readLaunchdEnvironment(INSTALLED_AUTONOMOUS_PLIST);
  const effectiveLaunchdConfig = installedLaunchdConfig.ok ? installedLaunchdConfig : repoLaunchdConfig;
  const configuredRoute = effectiveLaunchdConfig.ok
    ? modelRoute(
        effectiveLaunchdConfig.env,
        installedLaunchdConfig.ok ? 'installed_launchd_plist' : 'repo_launchd_plist'
      )
    : null;
  const effectiveRoute = configuredRoute || route;
  const directClaude = directClaudeCodeReferences();
  const launchd = launchdVisibility();
  const blockers = [];
  const warnings = [];

  const notices = [];

  if (status.operationalDirty) warnings.push('dirty_worktree_present');
  if (!status.operationalDirty && status.externalDirty) notices.push('external_dirty_worktree_ignored_for_claude_autonomy');
  if (manifest.missingActiveCount > 0) blockers.push('manifest_active_missing_docs');
  if (runtimeState.activeMissingJobCount > 0) warnings.push('active_enoent_jobs_present');
  if (runtimeState.historicalMissingJobCount > 0) notices.push('historical_enoent_jobs_present');
  if (effectiveRoute.implementationProvider !== 'openai-oauth' || effectiveRoute.implementationRunner !== 'codex') {
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
    notices,
    manifest,
    runtimeState,
    git: status,
    modelRoute: effectiveRoute,
    currentProcessModelRoute: route,
    configuredModelRoute: configuredRoute,
    launchdConfig: {
      ok: effectiveLaunchdConfig.ok,
      source: installedLaunchdConfig.ok ? 'installed' : 'repo',
      path: effectiveLaunchdConfig.path,
      installedPath: INSTALLED_AUTONOMOUS_PLIST,
      repoPath: REPO_AUTONOMOUS_PLIST,
      hasSymphonyMode: Boolean(effectiveLaunchdConfig.env.CLAUDE_AUTO_DEV_SYMPHONY_MODE),
      symphonyMode: effectiveLaunchdConfig.env.CLAUDE_AUTO_DEV_SYMPHONY_MODE || null,
      error: effectiveLaunchdConfig.error || null,
      repo: {
        ok: repoLaunchdConfig.ok,
        path: repoLaunchdConfig.path,
        hasSymphonyMode: Boolean(repoLaunchdConfig.env.CLAUDE_AUTO_DEV_SYMPHONY_MODE),
        symphonyMode: repoLaunchdConfig.env.CLAUDE_AUTO_DEV_SYMPHONY_MODE || null,
        error: repoLaunchdConfig.error || null,
      },
      installed: {
        ok: installedLaunchdConfig.ok,
        path: installedLaunchdConfig.path,
        hasSymphonyMode: Boolean(installedLaunchdConfig.env.CLAUDE_AUTO_DEV_SYMPHONY_MODE),
        symphonyMode: installedLaunchdConfig.env.CLAUDE_AUTO_DEV_SYMPHONY_MODE || null,
        error: installedLaunchdConfig.error || null,
      },
      drift: repoLaunchdConfig.ok && installedLaunchdConfig.ok
        ? {
            symphonyMode: (repoLaunchdConfig.env.CLAUDE_AUTO_DEV_SYMPHONY_MODE || null)
              !== (installedLaunchdConfig.env.CLAUDE_AUTO_DEV_SYMPHONY_MODE || null),
            profile: (repoLaunchdConfig.env.CLAUDE_AUTO_DEV_PROFILE || null)
              !== (installedLaunchdConfig.env.CLAUDE_AUTO_DEV_PROFILE || null),
            model: (repoLaunchdConfig.env.CLAUDE_AUTO_DEV_MODEL || null)
              !== (installedLaunchdConfig.env.CLAUDE_AUTO_DEV_MODEL || null),
          }
        : null,
    },
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
  classifyGitStatusRows,
  readLaunchdEnvironment,
};
