import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FINAL_ACTIVATION_REQUIREMENTS,
  buildFinalActivationSummary,
  createDashboardSummary,
  type SigmaLibraryEnv,
} from '../ts/lib/intelligent-library.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');
const launchdPlist = path.join(repoRoot, 'bots/sigma/launchd/ai.sigma.daily.plist');
const installedLaunchAgent = path.join(os.homedir(), 'Library/LaunchAgents/ai.sigma.daily.plist');

function readLaunchdEnv(plistPath: string): SigmaLibraryEnv {
  const output = execFileSync('/usr/bin/plutil', [
    '-extract',
    'EnvironmentVariables',
    'json',
    '-o',
    '-',
    plistPath,
  ], { encoding: 'utf8' });
  return JSON.parse(output) as SigmaLibraryEnv;
}

function launchctlGetenv(key: string): string | undefined {
  try {
    const value = execFileSync('/bin/launchctl', ['getenv', key], { encoding: 'utf8' }).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function activeRuntimeEnv(): { source: string; env: SigmaLibraryEnv } {
  try {
    const installedEnv = readLaunchdEnv(installedLaunchAgent);
    return { source: installedLaunchAgent, env: installedEnv };
  } catch {
    const env: SigmaLibraryEnv = {};
    for (const requirement of FINAL_ACTIVATION_REQUIREMENTS) {
      const key = String(requirement.key);
      env[requirement.key] = launchctlGetenv(key) ?? process.env[key];
    }
    return { source: 'launchctl/process.env', env };
  }
}

const plistEnv = readLaunchdEnv(launchdPlist);
const plistActivation = buildFinalActivationSummary(plistEnv);
assert.equal(plistActivation.ok, true, `repo launchd final activation incomplete: ${plistActivation.missing.join(', ')}`);

const dashboard = createDashboardSummary({ env: plistEnv });
assert.equal(dashboard.ok, true, `dashboard blockers: ${dashboard.blockers.join(', ')}`);
assert.equal(dashboard.finalActivation.active, dashboard.finalActivation.total);

let runtimeActivation = null;
let runtimeSource = null;
if (process.env.SIGMA_FINAL_ACTIVATION_SMOKE_CHECK_RUNTIME === '1') {
  const runtime = activeRuntimeEnv();
  runtimeSource = runtime.source;
  runtimeActivation = buildFinalActivationSummary(runtime.env);
  assert.equal(runtimeActivation.ok, true, `runtime final activation incomplete: ${runtimeActivation.missing.join(', ')}`);
}

console.log(JSON.stringify({
  ok: true,
  status: 'sigma_final_activation_smoke_passed',
  launchdPlist,
  repoActivation: {
    active: plistActivation.active,
    total: plistActivation.total,
    missing: plistActivation.missing,
  },
  runtimeActivation: runtimeActivation
    ? {
      source: runtimeSource,
      active: runtimeActivation.active,
      total: runtimeActivation.total,
      missing: runtimeActivation.missing,
    }
    : null,
}, null, 2));
