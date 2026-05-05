import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { SigmaLibraryEnv } from '../ts/lib/intelligent-library.js';

export const SIGMA_RUNTIME_ENV_KEYS = [
  'SIGMA_V2_ENABLED',
  'SIGMA_LIBRARY_AUTONOMY_MODE',
  'SIGMA_TEAM_MEMORY_UNIFIED',
  'SIGMA_KNOWLEDGE_GRAPH_ENABLED',
  'SIGMA_DATASET_BUILDER_ENABLED',
  'SIGMA_DATA_LINEAGE_ENABLED',
  'SIGMA_LIBRARY_DASHBOARD_ENABLED',
  'SIGMA_TIER2_AUTO_APPLY',
  'SIGMA_SELF_RAG_ENABLED',
  'SIGMA_GEPA_ENABLED',
  'SIGMA_MULTI_HOP_RAG_ENABLED',
  'SIGMA_HYDE_ENABLED',
  'SIGMA_MCP_SERVER_ENABLED',
  'SIGMA_SELF_IMPROVEMENT_ENABLED',
  'SIGMA_VOYAGER_SKILL_AUTO_EXTRACTION',
  'SIGMA_FINE_TUNING_NOTIFY_ENABLED',
  'SIGMA_DATASET_AUTO_EXPORT',
  'SIGMA_CONSTITUTION_VIOLATION_AUTO_BLOCK',
  'SIGMA_CONSTITUTION_ENABLED',
] as const;

export type SigmaRuntimeEnvSource = {
  env: SigmaLibraryEnv;
  source: string;
};

export function installedSigmaDailyLaunchAgent(): string {
  return path.join(os.homedir(), 'Library/LaunchAgents/ai.sigma.daily.plist');
}

export function repoSigmaDailyLaunchAgent(repoRoot: string): string {
  return path.join(repoRoot, 'bots/sigma/launchd/ai.sigma.daily.plist');
}

export function readLaunchdEnv(plistPath: string): SigmaLibraryEnv | null {
  try {
    const output = execFileSync('/usr/bin/plutil', [
      '-extract',
      'EnvironmentVariables',
      'json',
      '-o',
      '-',
      plistPath,
    ], { encoding: 'utf8' });
    return JSON.parse(output) as SigmaLibraryEnv;
  } catch {
    return null;
  }
}

export function launchctlGetenv(key: string): string | undefined {
  try {
    const value = execFileSync('/bin/launchctl', ['getenv', key], { encoding: 'utf8' }).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

export function resolveSigmaRuntimeEnv(repoRoot: string): SigmaRuntimeEnvSource {
  const installedEnv = readLaunchdEnv(installedSigmaDailyLaunchAgent());
  if (installedEnv) {
    return {
      env: { ...(process.env as SigmaLibraryEnv), ...installedEnv },
      source: installedSigmaDailyLaunchAgent(),
    };
  }

  const repoEnv = readLaunchdEnv(repoSigmaDailyLaunchAgent(repoRoot));
  if (repoEnv) {
    return {
      env: { ...(process.env as SigmaLibraryEnv), ...repoEnv },
      source: repoSigmaDailyLaunchAgent(repoRoot),
    };
  }

  const env = { ...(process.env as SigmaLibraryEnv) };
  for (const key of SIGMA_RUNTIME_ENV_KEYS) {
    const value = launchctlGetenv(key);
    if (value) env[key] = value;
  }
  return { env, source: 'launchctl/process.env' };
}
