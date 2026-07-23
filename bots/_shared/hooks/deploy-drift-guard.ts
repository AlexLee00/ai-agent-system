// @ts-nocheck

import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const SECRET_KEY = /(token|secret|password|authorization|api[_-]?key|credential|cookie)/i;

export const DEFAULT_DEPLOY_DRIFT_TARGETS = [
  {
    label: 'ai.jay.runtime',
    repoPath: 'bots/orchestrator/launchd/ai.jay.runtime.plist',
    envAllowlist: [
      'HUB_ALARM_USE_CLASS_TOPICS',
      'JAY_GROWTH_ENABLED',
      'JAY_HUB_PLAN_INTEGRATION',
      'JAY_INCIDENT_STORE_ENABLED',
      'JAY_LIFECYCLE_INJECT_ENABLED',
    ],
  },
  { label: 'ai.jay.growth', repoPath: 'bots/jay/launchd/ai.jay.growth.plist' },
  { label: 'ai.hub.resource-api', repoPath: 'bots/hub/launchd/ai.hub.resource-api.plist' },
  { label: 'ai.hub.ops-mcp', repoPath: 'bots/hub/launchd/ai.hub.ops-mcp.plist' },
  { label: 'ai.investment.commander', repoPath: 'bots/investment/launchd/ai.investment.commander.plist' },
  { label: 'ai.luna.meeting-room-web', repoPath: 'bots/investment/launchd/ai.luna.meeting-room-web.plist' },
  { label: 'ai.claude.archer', repoPath: 'bots/claude/launchd/ai.claude.archer.plist' },
  { label: 'ai.claude.guardian', repoPath: 'bots/claude/launchd/ai.claude.guardian.plist' },
  {
    label: 'ai.ska.naver-monitor',
    repoPath: 'bots/reservation/launchd/ai.ska.naver-monitor.plist',
    envAllowlist: [
      'PICKKO_CANCEL_ENABLE',
      'PICKKO_CANCEL_MUTATION_ENABLE',
      'SKA_ENABLE_PICKKO_CANCEL_MUTATION',
      'SKA_CANCEL_RETRY_ENABLED',
    ],
  },
];

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function normalizeEnv(env: Record<string, unknown> = {}, allowlist: string[] | null = null): Record<string, unknown> {
  const keys = Array.isArray(allowlist)
    ? allowlist
    : Object.keys(env).filter((key) => !SECRET_KEY.test(key));
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (!(key in env)) continue;
    out[key] = SECRET_KEY.test(key) ? '[redacted]' : env[key];
  }
  return out;
}

function comparablePlist(plist: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  const envAllowlist = Object.prototype.hasOwnProperty.call(options, 'envAllowlist')
    ? options.envAllowlist
    : null;
  return {
    ProgramArguments: plist.ProgramArguments || null,
    StartCalendarInterval: plist.StartCalendarInterval || null,
    KeepAlive: plist.KeepAlive ?? null,
    RunAtLoad: plist.RunAtLoad ?? null,
    WorkingDirectory: plist.WorkingDirectory || null,
    EnvironmentVariables: normalizeEnv(plist.EnvironmentVariables || {}, envAllowlist),
  };
}

function comparableLiveState(state: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  const envAllowlist = options.envAllowlist || [];
  return {
    ProgramArguments: state.ProgramArguments || null,
    WorkingDirectory: state.WorkingDirectory || null,
    EnvironmentVariables: normalizeEnv(state.EnvironmentVariables || {}, envAllowlist),
  };
}

export function compareLaunchdPlistState(expected = {}, loaded = {}, options = {}) {
  const explicitAllowlist = Array.isArray(options.envAllowlist) && options.envAllowlist.length > 0
    ? options.envAllowlist
    : null;
  const expectedEnv = expected.EnvironmentVariables || {};
  const inferredAllowlist = Object.entries(expectedEnv)
    .filter(([key, value]) => !SECRET_KEY.test(key) && !String(value || '').startsWith('__SET_IN_LOCAL_LAUNCHAGENT__'))
    .map(([key]) => key);
  const compareOptions = {
    ...options,
    envAllowlist: explicitAllowlist || inferredAllowlist,
  };
  const expectedComparable = comparablePlist(expected, compareOptions);
  const loadedComparable = comparablePlist(loaded, compareOptions);
  const keys = options.keys || Object.keys(expectedComparable);
  const diffs = [];
  for (const key of keys) {
    const a = JSON.stringify(stable(expectedComparable[key] ?? null));
    const b = JSON.stringify(stable(loadedComparable[key] ?? null));
    if (a !== b) {
      diffs.push({
        key,
        expected: expectedComparable[key] ?? null,
        loaded: loadedComparable[key] ?? null,
      });
    }
  }
  return {
    ok: diffs.length === 0,
    advisoryOnly: true,
    liveMutation: false,
    driftDetected: diffs.length > 0,
    diffs,
  };
}

export function compareLaunchdLiveState(loaded = {}, liveState = {}, options = {}) {
  if (!liveState || liveState.skipped) {
    return { driftDetected: false, diffs: [] };
  }
  const envAllowlist = options.envAllowlist || [];
  const loadedComparable = comparablePlist(loaded, options);
  const liveComparable = comparableLiveState(liveState, options);
  const keys = options.liveKeys || (
    envAllowlist.length > 0
      ? Object.keys(liveComparable)
      : ['ProgramArguments', 'WorkingDirectory']
  );
  const diffs = [];
  for (const key of keys) {
    const a = JSON.stringify(stable(loadedComparable[key] ?? null));
    const b = JSON.stringify(stable(liveComparable[key] ?? null));
    if (a !== b) {
      diffs.push({
        key: `LiveState.${key}`,
        expected: loadedComparable[key] ?? null,
        loaded: liveComparable[key] ?? null,
      });
    }
  }
  return { driftDetected: diffs.length > 0, diffs };
}

export function parsePlutilJson(filePath: string) {
  const result = spawnSync('plutil', ['-convert', 'json', '-o', '-', filePath], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`plutil_failed:${String(result.stderr || result.stdout || '').trim()}`);
  }
  return JSON.parse(result.stdout || '{}');
}

function parseLaunchctlBlock(text = '', key: string) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`${escaped}\\s*=\\s*\\{([\\s\\S]*?)\\n\\s*\\}`, 'i'));
  if (!match) return [];
  return match[1]
    .split('\n')
    .map((line) => line.trim().replace(/;$/, '').replace(/^"|"$/g, ''))
    .filter((line) => line && !line.includes('=>'));
}

export function parseLaunchctlPrint(text = '', envAllowlist: string[] = []) {
  const out: Record<string, unknown> = { rawAvailable: Boolean(text) };
  const pid = text.match(/pid\s*=\s*(\d+)/i)?.[1];
  const state = text.match(/state\s*=\s*([^\n]+)/i)?.[1]?.trim();
  const workingDirectory = text.match(/working directory\s*=\s*([^\n]+)/i)?.[1]?.trim();
  const programArguments = parseLaunchctlBlock(text, 'arguments');
  if (pid) out.pid = Number(pid);
  if (state) out.state = state;
  if (workingDirectory) out.WorkingDirectory = workingDirectory;
  if (programArguments.length > 0) out.ProgramArguments = programArguments;
  const env: Record<string, string> = {};
  for (const key of envAllowlist) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = text.match(new RegExp(`${escaped}\\s*=>\\s*"?([^"\\n]+)"?`, 'i'));
    if (match) env[key] = match[1].trim();
  }
  out.EnvironmentVariables = normalizeEnv(env, envAllowlist);
  return out;
}

function readLaunchctlPrint(label: string, deps: Record<string, unknown> = {}) {
  const spawn = deps.spawnSync || spawnSync;
  const uid = typeof deps.uid === 'number' ? deps.uid : process.getuid?.();
  if (!uid || !label) return { skipped: true, reason: 'launchctl_uid_or_label_missing' };
  const service = `gui/${uid}/${label}`;
  const result = spawn('launchctl', ['print', service], { encoding: 'utf8' });
  if (result.status !== 0) {
    return {
      skipped: true,
      reason: 'launchctl_print_unavailable',
      status: result.status,
    };
  }
  return { skipped: false, raw: result.stdout || '' };
}

function installedPlistPath(label: string, home = os.homedir()) {
  return path.join(home, 'Library/LaunchAgents', `${label}.plist`);
}

export function buildDeployDriftGuardReport({
  expectedPlist = null,
  loadedPlist = null,
  expectedPath = null,
  loadedPath = null,
  label = null,
  repoRoot = process.cwd(),
  home = os.homedir(),
  envAllowlist = [],
  includeLiveState = false,
  deps = {},
  now = new Date(),
} = {}) {
  const resolvedExpectedPath = expectedPath || (label ? path.join(repoRoot, `${label}.plist`) : null);
  const resolvedLoadedPath = loadedPath || (label ? installedPlistPath(label, home) : null);
  const expected = expectedPlist || (resolvedExpectedPath ? parsePlutilJson(resolvedExpectedPath) : {});
  const loaded = loadedPlist || (resolvedLoadedPath ? parsePlutilJson(resolvedLoadedPath) : {});
  const resolvedLabel = label || expected?.Label || loaded?.Label || null;
  const livePrint = includeLiveState && resolvedLabel ? readLaunchctlPrint(resolvedLabel, deps) : null;
  const liveState = livePrint && !livePrint.skipped
    ? parseLaunchctlPrint(livePrint.raw, envAllowlist)
    : livePrint;
  const plistComparison = compareLaunchdPlistState(expected, loaded, { envAllowlist });
  const liveComparison = includeLiveState
    ? compareLaunchdLiveState(loaded, liveState || {}, { envAllowlist })
    : { driftDetected: false, diffs: [] };
  const diffs = [...plistComparison.diffs, ...liveComparison.diffs];
  return {
    source: 'deploy_drift_guard',
    checkedAt: now.toISOString(),
    label: resolvedLabel,
    expectedPath: resolvedExpectedPath,
    loadedPath: resolvedLoadedPath,
    liveState,
    ok: diffs.length === 0,
    advisoryOnly: true,
    liveMutation: false,
    driftDetected: diffs.length > 0,
    diffs,
    liveDriftDetected: liveComparison.driftDetected,
    liveDiffs: liveComparison.diffs,
  };
}

export function scanDeployDriftTargets({
  targets = DEFAULT_DEPLOY_DRIFT_TARGETS,
  repoRoot = process.cwd(),
  home = os.homedir(),
  envAllowlist = [],
  now = new Date(),
} = {}) {
  const reports = targets.map((target) => {
    try {
      return buildDeployDriftGuardReport({
        label: target.label,
        expectedPath: path.join(repoRoot, target.repoPath),
        loadedPath: installedPlistPath(target.label, home),
        repoRoot,
        home,
        envAllowlist: target.envAllowlist || envAllowlist,
        includeLiveState: true,
        now,
      });
    } catch (error) {
      return {
        source: 'deploy_drift_guard',
        checkedAt: now.toISOString(),
        label: target.label,
        ok: true,
        skipped: true,
        advisoryOnly: true,
        liveMutation: false,
        reason: 'target_unavailable',
        error: String(error?.message || error).slice(0, 240),
      };
    }
  });
  return {
    ok: true,
    pass: reports.every((report) => report.ok || report.skipped),
    source: 'deploy_drift_guard_scan',
    checkedAt: now.toISOString(),
    advisoryOnly: true,
    liveMutation: false,
    total: reports.length,
    driftCount: reports.filter((report) => report.driftDetected).length,
    reports,
  };
}

export default {
  DEFAULT_DEPLOY_DRIFT_TARGETS,
  compareLaunchdPlistState,
  compareLaunchdLiveState,
  parsePlutilJson,
  parseLaunchctlPrint,
  buildDeployDriftGuardReport,
  scanDeployDriftTargets,
};
