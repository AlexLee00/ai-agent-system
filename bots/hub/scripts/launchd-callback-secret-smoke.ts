import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type JsonObject = Record<string, unknown>;

function readPlistAsJson(filePath: string): JsonObject {
  const raw = execFileSync('plutil', ['-convert', 'json', '-o', '-', filePath], {
    encoding: 'utf8',
  });
  const parsed = JSON.parse(raw);
  assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed), `invalid plist json: ${filePath}`);
  return parsed as JsonObject;
}

function normalizeEnvValue(value: unknown): string {
  return String(value == null ? '' : value).trim();
}

function readEnvVarsRequired(plistJson: JsonObject, filePath: string): JsonObject {
  const env = plistJson.EnvironmentVariables;
  assert(env && typeof env === 'object' && !Array.isArray(env), `EnvironmentVariables missing: ${filePath}`);
  return env as JsonObject;
}

function readEnvVarsOptional(plistJson: JsonObject | null): JsonObject {
  if (!plistJson) return {};
  const env = plistJson.EnvironmentVariables;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return {};
  return env as JsonObject;
}

const PLACEHOLDER_VALUES = new Set([
  '',
  '__set_in_local_launchagent__',
  '__set_in_local_env__',
  'set_in_local_launchagent',
  'set_in_local_env',
  '__required__',
  'changeme',
  'replace_me',
  'todo',
  'tbd',
]);

function isPlaceholder(value: unknown): boolean {
  const normalized = normalizeEnvValue(value);
  if (!normalized) return true;
  return PLACEHOLDER_VALUES.has(normalized.toLowerCase());
}

function readLaunchctlEnv(name: string): string {
  try {
    return normalizeEnvValue(execFileSync('launchctl', ['getenv', name], { encoding: 'utf8' }));
  } catch {
    return '';
  }
}

function readOptionalPlist(filePath: string): JsonObject | null {
  if (!fs.existsSync(filePath)) return null;
  return readPlistAsJson(filePath);
}

type RuntimeCandidate = {
  source: string;
  value: unknown;
};

function resolveRuntimeValue(candidates: RuntimeCandidate[]): { source: string; value: string } {
  for (const candidate of candidates) {
    const normalized = normalizeEnvValue(candidate.value);
    if (!isPlaceholder(normalized)) {
      return { source: candidate.source, value: normalized };
    }
  }
  return { source: '', value: '' };
}

function envFlagTrue(name: string): boolean {
  const value = normalizeEnvValue(process.env[name]).toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

async function main() {
  const launchdDir = path.resolve(__dirname, '..', 'launchd');
  const hubPlistPath = path.join(launchdDir, 'ai.hub.resource-api.plist');
  const pollerPlistPath = path.join(launchdDir, 'ai.telegram.callback-poller.plist');

  const templateHubPlist = readPlistAsJson(hubPlistPath);
  const templatePollerPlist = readPlistAsJson(pollerPlistPath);
  const templateHubEnv = readEnvVarsRequired(templateHubPlist, hubPlistPath);
  const templatePollerEnv = readEnvVarsRequired(templatePollerPlist, pollerPlistPath);

  const templateHubSecret = normalizeEnvValue(templateHubEnv.HUB_CONTROL_CALLBACK_SECRET);
  const templatePollerSecret = normalizeEnvValue(templatePollerEnv.HUB_CONTROL_CALLBACK_SECRET);
  const templatePollerHubToken = normalizeEnvValue(templatePollerEnv.HUB_AUTH_TOKEN);

  assert(templateHubSecret.length > 0, 'hub template plist HUB_CONTROL_CALLBACK_SECRET is required');
  assert(templatePollerSecret.length > 0, 'poller template plist HUB_CONTROL_CALLBACK_SECRET is required');
  assert(templatePollerHubToken.length > 0, 'poller template plist HUB_AUTH_TOKEN is required');
  assert(isPlaceholder(templateHubSecret), 'hub template callback secret must stay placeholder-only in repo');
  assert(isPlaceholder(templatePollerSecret), 'poller template callback secret must stay placeholder-only in repo');
  assert(isPlaceholder(templatePollerHubToken), 'poller template HUB_AUTH_TOKEN must stay placeholder-only in repo');

  const installedLaunchdDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const installedHubPlistPath = path.join(installedLaunchdDir, 'ai.hub.resource-api.plist');
  const installedPollerPlistPath = path.join(installedLaunchdDir, 'ai.telegram.callback-poller.plist');
  const installedHubEnv = readEnvVarsOptional(readOptionalPlist(installedHubPlistPath));
  const installedPollerEnv = readEnvVarsOptional(readOptionalPlist(installedPollerPlistPath));

  const launchctlCallbackSecret = readLaunchctlEnv('HUB_CONTROL_CALLBACK_SECRET');
  const launchctlHubAuthToken = readLaunchctlEnv('HUB_AUTH_TOKEN');
  const allowProcessEnvFallback = envFlagTrue('HUB_LAUNCHD_SMOKE_ALLOW_PROCESS_ENV');

  const runtimeHubSecretCandidates: RuntimeCandidate[] = [
    { source: `installed:${installedHubPlistPath}`, value: installedHubEnv.HUB_CONTROL_CALLBACK_SECRET },
    { source: 'launchctl:HUB_CONTROL_CALLBACK_SECRET', value: launchctlCallbackSecret },
  ];
  const runtimePollerSecretCandidates: RuntimeCandidate[] = [
    { source: `installed:${installedPollerPlistPath}`, value: installedPollerEnv.HUB_CONTROL_CALLBACK_SECRET },
    { source: 'launchctl:HUB_CONTROL_CALLBACK_SECRET', value: launchctlCallbackSecret },
  ];
  const runtimePollerHubTokenCandidates: RuntimeCandidate[] = [
    { source: `installed:${installedPollerPlistPath}`, value: installedPollerEnv.HUB_AUTH_TOKEN },
    { source: 'launchctl:HUB_AUTH_TOKEN', value: launchctlHubAuthToken },
  ];

  if (allowProcessEnvFallback) {
    runtimeHubSecretCandidates.push({
      source: 'process.env:HUB_CONTROL_CALLBACK_SECRET',
      value: process.env.HUB_CONTROL_CALLBACK_SECRET,
    });
    runtimePollerSecretCandidates.push({
      source: 'process.env:HUB_CONTROL_CALLBACK_SECRET',
      value: process.env.HUB_CONTROL_CALLBACK_SECRET,
    });
    runtimePollerHubTokenCandidates.push({
      source: 'process.env:HUB_AUTH_TOKEN',
      value: process.env.HUB_AUTH_TOKEN,
    });
  }

  const runtimeHubSecret = resolveRuntimeValue(runtimeHubSecretCandidates);
  const runtimePollerSecret = resolveRuntimeValue(runtimePollerSecretCandidates);
  const runtimePollerHubToken = resolveRuntimeValue(runtimePollerHubTokenCandidates);

  assert(runtimeHubSecret.value.length > 0, 'runtime hub callback secret must be configured (non-placeholder)');
  assert(runtimePollerSecret.value.length > 0, 'runtime poller callback secret must be configured (non-placeholder)');
  assert.equal(runtimePollerSecret.value, runtimeHubSecret.value, 'runtime callback secret must match between hub and poller');
  assert(runtimePollerHubToken.value.length > 0, 'runtime poller HUB_AUTH_TOKEN must be configured (non-placeholder)');

  console.log(
    JSON.stringify({
      ok: true,
      template_placeholders_validated: true,
      shared_callback_secret_env: true,
      poller_hub_auth_env: true,
      hub_plist: hubPlistPath,
      poller_plist: pollerPlistPath,
      runtime_sources: {
        hub_callback_secret: runtimeHubSecret.source || null,
        poller_callback_secret: runtimePollerSecret.source || null,
        poller_hub_auth_token: runtimePollerHubToken.source || null,
      },
      installed_launchd_detected: {
        hub: fs.existsSync(installedHubPlistPath),
        poller: fs.existsSync(installedPollerPlistPath),
      },
      allow_process_env_fallback: allowProcessEnvFallback,
    }),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
