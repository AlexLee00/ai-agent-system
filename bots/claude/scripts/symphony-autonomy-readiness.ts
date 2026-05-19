#!/usr/bin/env node
// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const { buildAuditReport } = require('./symphony-migration-audit.ts');
const { runSymphonyOrchestratorCycle } = require('../lib/symphony/orchestrator.ts');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const REQUIRED_A2A_SKILLS = [
  'dispatch-ticket',
  'poll-tasks',
  'assign-agent',
  'report-status',
  'sync-github',
  'hermes-learn',
  'self-heal',
  'quality-gate',
];
const REQUIRED_FILESYSTEM_SKILLS = [
  'dexter-skill',
  'doctor-skill',
  'archer-skill',
  'guardian-skill',
  'builder-skill',
  'reviewer-skill',
  'orchestrator-skill',
  'learning-skill',
];

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function loadAgentCard() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'bots/claude/a2a/claude-card.json'), 'utf8'));
}

function checkA2ASkills() {
  const card = loadAgentCard();
  const ids = new Set((card.skills || []).map((skill) => skill.id));
  const missing = REQUIRED_A2A_SKILLS.filter((skill) => !ids.has(skill));
  return {
    ok: missing.length === 0,
    missing,
    count: REQUIRED_A2A_SKILLS.length - missing.length,
    required: REQUIRED_A2A_SKILLS.length,
  };
}

function checkFilesystemSkills() {
  const missing = REQUIRED_FILESYSTEM_SKILLS.filter((skill) => {
    return !fs.existsSync(path.join(ROOT, 'bots/claude/skills', skill, 'SKILL.md'));
  });
  return {
    ok: missing.length === 0,
    missing,
    count: REQUIRED_FILESYSTEM_SKILLS.length - missing.length,
    required: REQUIRED_FILESYSTEM_SKILLS.length,
  };
}

function buildRecommendedActions({ audit, warnings, blockers }) {
  const actions = [];
  if (warnings.includes('dirty_worktree_present')) {
    actions.push({
      id: 'clean_or_commit_worktree',
      priority: 'P1',
      approvalRequired: false,
      mutatesRuntime: false,
      reason: 'dirty worktree blocks safe autonomous claim/patch loops',
      command: 'git status --short && git diff --check',
    });
  }
  if (warnings.includes('historical_enoent_jobs_present')) {
    actions.push({
      id: 'review_historical_enoent_jobs',
      priority: 'P2',
      approvalRequired: false,
      mutatesRuntime: false,
      reason: 'historical missing docs inflate failure noise; active manifest is already clean',
      command: 'node bots/claude/scripts/symphony-migration-audit.ts --json',
    });
  }
  if (warnings.includes('symphony_mode_off_runtime_not_yet_cut_over')) {
    actions.push({
      id: 'enable_symphony_shadow_mode',
      priority: 'P1',
      approvalRequired: true,
      mutatesRuntime: true,
      reason: 'runtime is autonomous_l5 but Symphony integration is not yet enabled',
      command: 'Set CLAUDE_AUTO_DEV_SYMPHONY_MODE=shadow in the approved runtime environment, then restart the approved Claude auto-dev owner process.',
    });
  }
  if (warnings.includes('claude_auto_dev_launchd_visible_but_not_running')) {
    actions.push({
      id: 'restart_claude_auto_dev_autonomous',
      priority: 'P1',
      approvalRequired: true,
      mutatesRuntime: true,
      protectedLabel: audit.launchd?.label || 'ai.claude.auto-dev.autonomous',
      reason: 'launchd label is loaded but PID is absent; autonomous watcher is not currently executing',
      command: 'launchctl kickstart -k gui/$(id -u)/ai.claude.auto-dev.autonomous',
    });
  }
  if (blockers.length > 0) {
    actions.push({
      id: 'resolve_readiness_blockers',
      priority: 'P0',
      approvalRequired: false,
      mutatesRuntime: false,
      reason: 'readiness blockers must be cleared before any runtime cutover',
      command: 'npm --prefix bots/claude run -s check:symphony-orchestrator',
    });
  }
  return actions;
}

async function buildReadinessReport() {
  const audit = buildAuditReport();
  const a2a = checkA2ASkills();
  const filesystemSkills = checkFilesystemSkills();
  const orchestrator = await runSymphonyOrchestratorCycle({
    tasks: [{
      id: 'readiness_fixture',
      source: 'hub',
      target_team: 'claude',
      title: 'Claude Symphony readiness fixture security review',
      body: 'Validate dry-run orchestrator plan without Hub/git/launchd mutation.',
      priority: 'normal',
      status: 'todo',
    }],
    dryRun: true,
    pollHub: false,
  });

  const blockers = [];
  const warnings = [...(audit.warnings || [])];

  if (!a2a.ok) blockers.push(`missing_a2a_skills:${a2a.missing.join(',')}`);
  if (!filesystemSkills.ok) blockers.push(`missing_filesystem_skills:${filesystemSkills.missing.join(',')}`);
  if (!orchestrator.ok) blockers.push(...orchestrator.blockers.map((blocker) => `orchestrator:${blocker}`));
  if (audit.modelRoute?.implementationProvider !== 'openai-oauth' || audit.modelRoute?.implementationRunner !== 'codex') {
    blockers.push('implementation_route_not_openai_codex');
  }
  if (audit.modelRoute?.symphonyMode === 'off') {
    warnings.push('symphony_mode_off_runtime_not_yet_cut_over');
  }
  if (audit.launchd?.visible && !audit.launchd?.pid) {
    warnings.push('claude_auto_dev_launchd_visible_but_not_running');
  }
  if (!audit.launchd?.visible) {
    warnings.push('claude_auto_dev_launchd_not_visible');
  }
  const uniqueWarnings = [...new Set(warnings)];
  const recommendedActions = buildRecommendedActions({ audit, warnings: uniqueWarnings, blockers });

  return {
    ok: blockers.length === 0,
    status: blockers.length > 0
      ? 'claude_symphony_autonomy_blocked'
      : warnings.length > 0
        ? 'claude_symphony_autonomy_ready_with_warnings'
        : 'claude_symphony_autonomy_ready',
    generatedAt: new Date().toISOString(),
    mode: 'readiness_only',
    blockers,
    warnings: uniqueWarnings,
    recommendedActions,
    checks: {
      a2a,
      filesystemSkills,
      orchestrator: {
        ok: orchestrator.ok,
        status: orchestrator.status,
        safety: orchestrator.safety,
        count: orchestrator.count,
      },
      modelRoute: audit.modelRoute,
      launchd: audit.launchd,
      manifest: {
        activeCount: audit.manifest?.activeCount,
        missingActiveCount: audit.manifest?.missingActiveCount,
      },
      runtimeState: {
        missingJobCount: audit.runtimeState?.missingJobCount,
        historicalStateCount: audit.runtimeState?.historicalStateCount,
      },
    },
  };
}

async function main() {
  const report = await buildReadinessReport();
  if (hasFlag('json')) console.log(JSON.stringify(report, null, 2));
  else console.log(`${report.status}: blockers=${report.blockers.length} warnings=${report.warnings.length}`);
  if (hasFlag('fail-on-blocked') && !report.ok) process.exitCode = 1;
  return report;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`symphony-autonomy-readiness failed: ${error?.message || error}`);
    process.exit(1);
  });
}

module.exports = {
  buildReadinessReport,
};
