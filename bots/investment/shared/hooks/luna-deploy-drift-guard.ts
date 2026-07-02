// @ts-nocheck

import { spawnSync } from 'node:child_process';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

export function compareLaunchdPlistState(expected = {}, loaded = {}, options = {}) {
  const keys = options.keys || ['ProgramArguments', 'StartCalendarInterval', 'EnvironmentVariables', 'WorkingDirectory'];
  const diffs = [];
  for (const key of keys) {
    const a = JSON.stringify(stable(expected?.[key] ?? null));
    const b = JSON.stringify(stable(loaded?.[key] ?? null));
    if (a !== b) diffs.push({ key, expected: expected?.[key] ?? null, loaded: loaded?.[key] ?? null });
  }
  return {
    ok: diffs.length === 0,
    advisoryOnly: true,
    liveMutation: false,
    driftDetected: diffs.length > 0,
    diffs,
  };
}

export function parsePlutilJson(path) {
  const result = spawnSync('plutil', ['-convert', 'json', '-o', '-', path], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`plutil_failed:${String(result.stderr || result.stdout || '').trim()}`);
  }
  return JSON.parse(result.stdout || '{}');
}

export function buildDeployDriftGuardReport({ expectedPlist = null, loadedPlist = null, expectedPath = null, loadedPath = null } = {}) {
  const expected = expectedPlist || (expectedPath ? parsePlutilJson(expectedPath) : {});
  const loaded = loadedPlist || (loadedPath ? parsePlutilJson(loadedPath) : {});
  return {
    source: 'luna_deploy_drift_guard',
    checkedAt: new Date().toISOString(),
    ...compareLaunchdPlistState(expected, loaded),
  };
}

export default {
  compareLaunchdPlistState,
  parsePlutilJson,
  buildDeployDriftGuardReport,
};
