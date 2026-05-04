#!/usr/bin/env tsx
// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const HUB_DIR = path.join(PROJECT_ROOT, 'bots', 'hub');
const INVESTMENT_DIR = path.join(PROJECT_ROOT, 'bots', 'investment');
const USER_LAUNCH_AGENTS = path.join(os.homedir(), 'Library', 'LaunchAgents');

const PROTECTED_LABELS = [
  'ai.luna.tradingview-ws',
  'ai.investment.commander',
  'ai.elixir.supervisor',
  'ai.luna.marketdata-mcp',
  'ai.claude.auto-dev.autonomous',
  'ai.hub.resource-api',
];

const ENV_TARGETS = [
  {
    track: 'track1_roundtable_stage3',
    label: 'ai.hub.resource-api',
    repoPlist: path.join(HUB_DIR, 'launchd', 'ai.hub.resource-api.plist'),
    required: {
      HUB_ALARM_LLM_CLASSIFIER_ENABLED: 'true',
      HUB_ALARM_INTERPRETER_ENABLED: 'true',
      HUB_ALARM_ENRICHMENT_ENABLED: 'true',
      HUB_ALARM_CRITICAL_TYPE_ENABLED: 'true',
      HUB_ALARM_ROUNDTABLE_ENABLED: 'true',
      HUB_ALARM_DISPATCH_MODE: 'autonomous',
      HUB_ALARM_INTERPRETER_FAIL_OPEN: 'true',
      HUB_ALARM_ROUNDTABLE_DAILY_LIMIT: '10',
      LLM_TEAM_SELECTOR_AB_PERCENT: '100',
      LLM_TEAM_SELECTOR_VERSION_PCT: '100',
    },
    accepted: {
      LLM_TEAM_SELECTOR_VERSION: ['v3_oauth_4', 'v3.0_oauth_4', 'oauth4'],
    },
  },
  {
    track: 'track1_noisy_auto_learn',
    label: 'ai.hub.noisy-producer-auto-learn',
    repoPlist: path.join(HUB_DIR, 'launchd', 'ai.hub.noisy-producer-auto-learn.plist'),
    required: {
      HUB_NOISY_AUTO_LEARN_ENABLED: 'true',
      HUB_NOISY_AUTO_SUPPRESS: 'false',
    },
  },
  {
    track: 'track1_roundtable_reflection',
    label: 'ai.hub.roundtable-reflection',
    repoPlist: path.join(HUB_DIR, 'launchd', 'ai.hub.roundtable-reflection.plist'),
    required: {
      HUB_ROUNDTABLE_REFLECTION_ENABLED: 'true',
    },
  },
  {
    track: 'track1_severity_decay',
    label: 'ai.hub.severity-decay',
    repoPlist: path.join(HUB_DIR, 'launchd', 'ai.hub.severity-decay.plist'),
    required: {
      HUB_SEVERITY_DECAY_ENABLED: 'true',
      HUB_SEVERITY_DECAY_CRITICAL_HOURS: '24',
      HUB_SEVERITY_DECAY_ERROR_DAYS: '7',
    },
  },
  {
    track: 'track1_voyager_acceleration',
    label: 'ai.luna.ops-scheduler',
    repoPlist: path.join(INVESTMENT_DIR, 'launchd', 'ai.luna.ops-scheduler.plist'),
    required: {
      LUNA_OPS_SCHEDULER_ENABLED: 'true',
      LUNA_VOYAGER_NATURAL_ACCELERATION_ENABLED: 'true',
    },
  },
];

function hasArg(name) {
  return process.argv.includes(name);
}

function run(command, args, options = {}) {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd || PROJECT_ROOT,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: result.status === 0,
    status: result.status,
    durationMs: Date.now() - startedAt,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
    command: [command, ...args].join(' '),
  };
}

function parseJsonCommand(command, args, options = {}) {
  const result = run(command, args, options);
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout || '{}');
  } catch {
    // keep parsed null; caller reports stdout/stderr.
  }
  return { ...result, parsed };
}

function parsePlist(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, env: {}, error: 'plist_missing' };
  const result = spawnSync('plutil', ['-convert', 'json', '-o', '-', filePath], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    return { exists: true, env: {}, error: String(result.stderr || result.status) };
  }
  const parsed = JSON.parse(result.stdout || '{}');
  return {
    exists: true,
    label: parsed.Label,
    env: parsed.EnvironmentVariables || {},
  };
}

function parseLaunchctlPrint(label) {
  const result = run('launchctl', ['print', `gui/${process.getuid()}/${label}`]);
  const env = {};
  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s=>\s(.+?)\s*$/);
    if (match) env[match[1]] = match[2];
  }
  return {
    ok: result.ok,
    label,
    env,
    error: result.ok ? null : (result.stderr || 'launchctl_print_failed'),
  };
}

function parseLaunchctlList() {
  const result = run('launchctl', ['list']);
  const rows = {};
  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3 || parts[0] === 'PID') continue;
    const label = parts.slice(2).join(' ');
    rows[label] = {
      pid: parts[0] === '-' ? null : Number(parts[0]),
      lastExitStatus: Number(parts[1]),
      label,
      loaded: true,
    };
  }
  return {
    ok: result.ok,
    rows,
    error: result.ok ? null : (result.stderr || 'launchctl_list_failed'),
  };
}

function normalize(value) {
  return String(value ?? '').trim().toLowerCase();
}

function checkEnvSource(sourceName, env, target) {
  const failures = [];
  for (const [key, expected] of Object.entries(target.required || {})) {
    if (normalize(env[key]) !== normalize(expected)) {
      failures.push(`${sourceName}:${target.label}:${key}=${env[key] ?? '<missing>'} expected ${expected}`);
    }
  }
  for (const [key, accepted] of Object.entries(target.accepted || {})) {
    if (!accepted.map(normalize).includes(normalize(env[key]))) {
      failures.push(`${sourceName}:${target.label}:${key}=${env[key] ?? '<missing>'} expected one of ${accepted.join(',')}`);
    }
  }
  return failures;
}

function buildEnvReport() {
  const targets = [];
  const blockers = [];
  for (const target of ENV_TARGETS) {
    const localPlist = path.join(USER_LAUNCH_AGENTS, path.basename(target.repoPlist));
    const repo = parsePlist(target.repoPlist);
    const local = parsePlist(localPlist);
    const runtime = parseLaunchctlPrint(target.label);
    const repoFailures = checkEnvSource('repo', repo.env, target);
    const localFailures = local.exists ? checkEnvSource('local', local.env, target) : [`local:${target.label}:plist_missing`];
    const runtimeFailures = runtime.ok ? checkEnvSource('runtime', runtime.env, target) : [`runtime:${target.label}:${runtime.error}`];
    const failures = [...repoFailures, ...localFailures, ...runtimeFailures];
    blockers.push(...failures);
    targets.push({
      track: target.track,
      label: target.label,
      repo: { path: target.repoPlist, exists: repo.exists, failures: repoFailures },
      local: { path: localPlist, exists: local.exists, failures: localFailures },
      runtime: { ok: runtime.ok, failures: runtimeFailures },
      ok: failures.length === 0,
    });
  }
  return {
    ok: blockers.length === 0,
    blockers,
    targets,
  };
}

function buildProtectedPidReport() {
  const listed = parseLaunchctlList();
  const labels = PROTECTED_LABELS.map((label) => {
    const row = listed.rows[label] || null;
    return {
      label,
      loaded: Boolean(row),
      pid: row?.pid ?? null,
      lastExitStatus: row?.lastExitStatus ?? null,
      ok: Boolean(row && row.pid),
    };
  });
  const blockers = labels.filter((item) => !item.ok).map((item) => `protected_pid_missing:${item.label}`);
  return {
    ok: listed.ok && blockers.length === 0,
    blockers: listed.ok ? blockers : [listed.error],
    labels,
  };
}

function buildTrack2Report() {
  const result = parseJsonCommand(process.execPath, [
    path.join(INVESTMENT_DIR, 'scripts', 'runtime-luna-launchd-migrate.ts'),
    '--json',
  ], { cwd: PROJECT_ROOT });
  const parsed = result.parsed || {};
  const visible = parsed.beforePlan?.visibleRetireCandidates || [];
  const failed = (parsed.steps || []).filter((step) => step.validation?.ok === false);
  const blockers = [
    ...(parsed.beforePlan?.protectedViolations || []).map((item) => `protected_retire_plan:${item.label}`),
    ...visible.map((item) => `visible_retire_candidate:${item.label}`),
    ...failed.map((item) => `replacement_validation_failed:${item.group}`),
  ];
  return {
    ok: result.ok && parsed.ok === true && blockers.length === 0,
    blockers: result.ok ? blockers : [result.stderr || 'launchd_migration_plan_failed'],
    status: visible.length === 0 ? 'all_retire_candidates_absent' : 'visible_candidates_require_group_apply',
    visibleRetireCandidates: visible.map((item) => item.label),
    selectedGroups: parsed.selectedGroups || [],
  };
}

function buildTrack3Report() {
  const result = parseJsonCommand(process.execPath, [
    path.join(INVESTMENT_DIR, 'scripts', 'runtime-luna-7day-natural-checkpoint.ts'),
    '--json',
  ], { cwd: INVESTMENT_DIR });
  const parsed = result.parsed || {};
  return {
    ok: result.ok && parsed.ok !== false,
    status: parsed.status || 'unknown',
    pendingObservation: parsed.pendingObservation || [],
    progress: parsed.progress || {},
    blockers: result.ok ? [] : [result.stderr || '7day_natural_checkpoint_failed'],
  };
}

function buildTrack4Report() {
  const tsx = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx');
  const result = parseJsonCommand(tsx, [
    path.join(HUB_DIR, 'scripts', 'investment-selector-explicit-keys-smoke.ts'),
  ], { cwd: PROJECT_ROOT });
  const parsed = result.parsed || {};
  return {
    ok: result.ok && parsed.ok === true,
    explicitSelectorKeys: parsed.explicit_selector_keys || 0,
    yamlAgents: parsed.yaml_agents || 0,
    blockers: result.ok ? [] : [result.stderr || 'investment_selector_explicit_keys_failed'],
  };
}

function buildRoundtableContractReport() {
  const tsx = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx');
  const result = run(tsx, [path.join(HUB_DIR, 'scripts', 'alarm-activation-stage3-smoke.ts')], { cwd: PROJECT_ROOT });
  return {
    ok: result.ok,
    durationMs: result.durationMs,
    blockers: result.ok ? [] : [result.stderr || 'alarm_activation_stage3_smoke_failed'],
  };
}

function buildOpsSchedulerReport() {
  const result = parseJsonCommand(process.execPath, [
    path.join(INVESTMENT_DIR, 'scripts', 'runtime-luna-ops-scheduler.ts'),
    '--dry-run',
    '--json',
  ], { cwd: INVESTMENT_DIR });
  const parsed = result.parsed || {};
  const jobNames = (parsed.plan?.jobs || parsed.jobs || []).map((job) => job.name);
  const hasVoyager = jobNames.includes('voyager_skill_acceleration');
  const hasNatural = jobNames.includes('natural_7day_checkpoint');
  const blockers = [
    ...(hasVoyager ? [] : ['ops_scheduler_missing:voyager_skill_acceleration']),
    ...(hasNatural ? [] : ['ops_scheduler_missing:natural_7day_checkpoint']),
  ];
  return {
    ok: result.ok && parsed.ok === true && blockers.length === 0,
    status: parsed.status || 'unknown',
    jobNames,
    blockers: result.ok ? blockers : [result.stderr || 'ops_scheduler_dry_run_failed'],
  };
}

export function buildNextStageIntegratedReport() {
  const env = buildEnvReport();
  const protectedPids = buildProtectedPidReport();
  const roundtable = buildRoundtableContractReport();
  const track2 = buildTrack2Report();
  const track3 = buildTrack3Report();
  const track4 = buildTrack4Report();
  const opsScheduler = buildOpsSchedulerReport();
  const hardBlockers = [
    ...env.blockers,
    ...protectedPids.blockers,
    ...roundtable.blockers,
    ...track2.blockers,
    ...track3.blockers,
    ...track4.blockers,
    ...opsScheduler.blockers,
  ];
  const pendingObservation = [
    ...(track3.pendingObservation || []).map((item) => `track3:${item}`),
  ];
  return {
    ok: hardBlockers.length === 0,
    codeComplete: hardBlockers.length === 0,
    operationalStatus: hardBlockers.length === 0 && pendingObservation.length === 0
      ? 'complete'
      : (hardBlockers.length === 0 ? 'natural_observation_pending' : 'blocked'),
    generatedAt: new Date().toISOString(),
    tracks: {
      track1: {
        ok: env.ok && roundtable.ok && opsScheduler.ok,
        env,
        roundtable,
        opsScheduler,
      },
      track2,
      track3,
      track4,
    },
    protectedPids,
    hardBlockers,
    pendingObservation,
    nextActions: hardBlockers.length > 0
      ? ['resolve hardBlockers before marking Team Jay next-stage complete']
      : (pendingObservation.length > 0
        ? ['continue 7-day natural checkpoint until pendingObservation is empty']
        : ['archive CODEX_TEAM_JAY_NEXT_STAGE_INTEGRATED_PLAN.md after final master review']),
  };
}

async function main() {
  if (hasArg('--smoke')) {
    const report = buildNextStageIntegratedReport();
    assert.equal(Array.isArray(report.hardBlockers), true);
    console.log(JSON.stringify({ ok: true, status: report.operationalStatus }, null, 2));
    return;
  }
  const report = buildNextStageIntegratedReport();
  if (hasArg('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`# Team Jay next-stage integrated gate (${report.ok ? 'ok' : 'blocked'})`);
    console.log(`operationalStatus: ${report.operationalStatus}`);
    console.log(`hardBlockers: ${report.hardBlockers.length}`);
    console.log(`pendingObservation: ${report.pendingObservation.length}`);
  }
  if (!report.ok) process.exit(1);
}

main().catch((error) => {
  console.error(`[team-jay-next-stage-integrated-gate] failed: ${error?.message || error}`);
  process.exit(1);
});
