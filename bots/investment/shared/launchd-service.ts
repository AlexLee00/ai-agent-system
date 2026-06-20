// @ts-nocheck
/**
 * Small launchd inspection helpers for Luna operational scripts.
 *
 * Keep this module side-effect free: callers decide whether an action is only
 * planned or actually applied.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function launchdDomain() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
  return `gui/${uid}`;
}

export function runLaunchctl(args = [], { timeout = 10_000 } = {}) {
  const proc = spawnSync('launchctl', args, {
    encoding: 'utf8',
    timeout,
  });
  return {
    ok: proc.status === 0,
    status: proc.status,
    command: ['launchctl', ...args].join(' '),
    stdout: String(proc.stdout || '').trim(),
    stderr: String(proc.stderr || '').trim(),
    error: proc.error ? String(proc.error?.message || proc.error) : null,
  };
}

export function launchAgentPlistPath(label) {
  const home = String(process.env.HOME || '').trim();
  if (!home || !label) return null;
  return path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
}

export function decodePlistValue(value = '') {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function extractPlistStringMap(plist = '') {
  const map = {};
  for (const match of String(plist).matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)) {
    map[decodePlistValue(match[1])] = decodePlistValue(match[2]);
  }
  return map;
}

export function extractPlistEnvironment(plist = '') {
  const envBlock = String(plist).match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/)?.[1] || '';
  return extractPlistStringMap(envBlock);
}

export function readPlistEnvironment(plistPath) {
  if (!plistPath || !fs.existsSync(plistPath)) return null;
  return extractPlistEnvironment(fs.readFileSync(plistPath, 'utf8'));
}

export function readLoadedLaunchdEnvironment(label, { loadedEnvByLabel = null } = {}) {
  if (loadedEnvByLabel && loadedEnvByLabel[label]) return loadedEnvByLabel[label];
  const result = runLaunchctl(['print', `${launchdDomain()}/${label}`], { timeout: 5_000 });
  if (!result.ok || !result.stdout) return {};
  const env = {};
  for (const line of String(result.stdout).split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=>\s*(.*?)\s*$/);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

export function buildLaunchdEnvDriftPlan({
  criticalEnvKeysByLabel = {},
  repoEnvByLabel = null,
  installedEnvByLabel = null,
  loadedEnvByLabel = null,
  repoPlistPathForLabel = null,
  installedPlistPathForLabel = null,
  protectedLabels = [],
  readLoadedEnv = null,
  existsSyncImpl = fs.existsSync,
} = {}) {
  const plans = [];
  const protectedSet = new Set(protectedLabels || []);
  for (const [label, keys] of Object.entries(criticalEnvKeysByLabel || {})) {
    const sourcePath = repoPlistPathForLabel ? repoPlistPathForLabel(label) : null;
    const installedPath = installedPlistPathForLabel ? installedPlistPathForLabel(label) : launchAgentPlistPath(label);
    const repoEnv = repoEnvByLabel?.[label] || readPlistEnvironment(sourcePath) || {};
    const installedEnv = installedEnvByLabel?.[label] || readPlistEnvironment(installedPath) || {};
    const loadedEnv = readLoadedEnv
      ? readLoadedEnv(label, { loadedEnvByLabel })
      : readLoadedLaunchdEnvironment(label, { loadedEnvByLabel });
    const installedExists = installedPath ? existsSyncImpl(installedPath) : false;

    for (const key of keys || []) {
      const repoValue = repoEnv[key] ?? null;
      if (repoValue == null) continue;
      const installedValue = installedEnv[key] ?? null;
      const loadedValue = loadedEnv?.[key] ?? null;
      const installedMatches = installedValue === repoValue;
      const loadedMatches = loadedValue === repoValue;
      if (installedMatches && loadedMatches) continue;
      plans.push({
        label,
        key,
        repoValue,
        installedValue,
        loadedValue,
        status: !installedExists && !installedEnvByLabel?.[label]
          ? 'installed_plist_missing'
          : !installedMatches
            ? 'installed_env_mismatch'
            : 'loaded_env_mismatch',
        sourcePath,
        installedPath,
        protected: protectedSet.has(label),
        criticalEnabledKey: /_ENABLED$/.test(String(key)),
        action: 'sync_installed_plist_then_reload',
        installCommand: sourcePath && installedPath ? `cp ${sourcePath} ${installedPath}` : null,
        reloadCommand: installedPath ? `launchctl bootout ${launchdDomain()}/${label}; launchctl bootstrap ${launchdDomain()} ${installedPath}` : null,
      });
    }
  }
  return plans;
}

export function inspectLaunchAgentPlist(label) {
  const plistPath = launchAgentPlistPath(label);
  if (!plistPath || !fs.existsSync(plistPath)) {
    return {
      exists: false,
      path: plistPath,
      scheduledOnly: false,
      runAtLoad: null,
      hasStartCalendarInterval: false,
      hasStartInterval: false,
    };
  }

  const proc = spawnSync('plutil', ['-convert', 'json', '-o', '-', plistPath], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (proc.status !== 0) {
    return {
      exists: true,
      path: plistPath,
      parseOk: false,
      scheduledOnly: false,
      runAtLoad: null,
      hasStartCalendarInterval: false,
      hasStartInterval: false,
      error: String(proc.stderr || proc.error?.message || '').trim() || 'plutil_failed',
    };
  }

  let data = null;
  try {
    data = JSON.parse(String(proc.stdout || '{}'));
  } catch (error) {
    return {
      exists: true,
      path: plistPath,
      parseOk: false,
      scheduledOnly: false,
      runAtLoad: null,
      hasStartCalendarInterval: false,
      hasStartInterval: false,
      error: String(error?.message || error || 'plist_parse_failed'),
    };
  }

  const runAtLoad = typeof data?.RunAtLoad === 'boolean' ? data.RunAtLoad : null;
  const hasStartCalendarInterval = data?.StartCalendarInterval != null;
  const hasStartInterval = Number.isFinite(Number(data?.StartInterval)) && Number(data.StartInterval) > 0;
  return {
    exists: true,
    path: plistPath,
    parseOk: true,
    scheduledOnly: runAtLoad === false && (hasStartCalendarInterval || hasStartInterval),
    runAtLoad,
    hasStartCalendarInterval,
    hasStartInterval,
  };
}

export function parseLaunchctlListLine(line = '') {
  const text = String(line || '').trim();
  if (!text) return null;
  const parts = text.split(/\s+/);
  if (parts.length < 3) return null;
  const label = parts.slice(2).join(' ');
  const pid = parts[0] === '-' ? null : Number(parts[0]);
  const lastExitStatus = parts[1] == null || parts[1] === '-' ? null : Number(parts[1]);
  return {
    label,
    pid: Number.isFinite(pid) ? pid : null,
    lastExitStatus: Number.isFinite(lastExitStatus) ? lastExitStatus : null,
    raw: text,
  };
}

export function inspectLaunchdList(label) {
  const result = runLaunchctl(['list']);
  if (!result.ok) {
    return {
      ok: false,
      loaded: false,
      label,
      error: result.error || result.stderr || 'launchctl_list_failed',
    };
  }
  const row = String(result.stdout || '')
    .split(/\r?\n/)
    .map(parseLaunchctlListLine)
    .find((item) => item?.label === label);
  if (!row) {
    return {
      ok: true,
      loaded: false,
      label,
      pid: null,
      lastExitStatus: null,
      raw: null,
    };
  }
  return {
    ok: true,
    loaded: true,
    ...row,
  };
}

export function inspectLaunchdPrint(label) {
  const domain = launchdDomain();
  const result = runLaunchctl(['print', `${domain}/${label}`], { timeout: 5_000 });
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  const pidMatch = text.match(/\bpid\s*=\s*(\d+)/);
  const lastExitMatch = text.match(/\blast exit code\s*=\s*(-?\d+)/i);
  const runIntervalMatch = text.match(/\brun interval\s*=\s*(\d+)\s*seconds/i);
  return {
    ok: result.ok,
    loaded: result.ok,
    label,
    domain,
    pid: pidMatch ? Number(pidMatch[1]) : null,
    lastExitCode: lastExitMatch ? Number(lastExitMatch[1]) : null,
    runIntervalSec: runIntervalMatch ? Number(runIntervalMatch[1]) : null,
    detail: result.ok ? null : text.slice(-500).trim(),
    command: result.command,
  };
}

export function buildLaunchdBootstrapPlan(label) {
  const domain = launchdDomain();
  const plist = inspectLaunchAgentPlist(label);
  return {
    label,
    domain,
    plistPath: plist.path,
    plistExists: plist.exists === true,
    command: plist.path ? ['launchctl', 'bootstrap', domain, plist.path].join(' ') : null,
    args: plist.path ? ['bootstrap', domain, plist.path] : null,
  };
}

export function runLaunchdBootstrap(label, { apply = false } = {}) {
  const plan = buildLaunchdBootstrapPlan(label);
  if (!apply) {
    return {
      ok: plan.plistExists === true,
      dryRun: true,
      applied: false,
      ...plan,
    };
  }
  if (!plan.plistPath || plan.plistExists !== true || !plan.args) {
    return {
      ok: false,
      dryRun: false,
      applied: false,
      ...plan,
      error: 'plist_missing',
    };
  }
  const result = runLaunchctl(plan.args);
  return {
    ok: result.ok,
    dryRun: false,
    applied: result.ok,
    ...plan,
    result,
  };
}

export function buildLaunchdKickstartPlan(label, { forceKill = true } = {}) {
  const domain = launchdDomain();
  const args = ['kickstart'];
  if (forceKill) args.push('-k');
  args.push(`${domain}/${label}`);
  return {
    label,
    domain,
    command: ['launchctl', ...args].join(' '),
    args,
  };
}

export function runLaunchdKickstart(label, { apply = false, confirm = null, requiredConfirm = null, forceKill = true } = {}) {
  const plan = buildLaunchdKickstartPlan(label, { forceKill });
  if (!apply) {
    return {
      ok: true,
      dryRun: true,
      applied: false,
      ...plan,
    };
  }
  if (requiredConfirm && confirm !== requiredConfirm) {
    return {
      ok: false,
      dryRun: false,
      applied: false,
      ...plan,
      error: `confirmation_required:${requiredConfirm}`,
    };
  }
  const result = runLaunchctl(plan.args);
  return {
    ok: result.ok,
    dryRun: false,
    applied: result.ok,
    ...plan,
    result,
  };
}

export default {
  launchdDomain,
  runLaunchctl,
  parseLaunchctlListLine,
  inspectLaunchdList,
  inspectLaunchdPrint,
  launchAgentPlistPath,
  decodePlistValue,
  extractPlistStringMap,
  extractPlistEnvironment,
  readPlistEnvironment,
  readLoadedLaunchdEnvironment,
  buildLaunchdEnvDriftPlan,
  inspectLaunchAgentPlist,
  buildLaunchdBootstrapPlan,
  runLaunchdBootstrap,
  buildLaunchdKickstartPlan,
  runLaunchdKickstart,
};
