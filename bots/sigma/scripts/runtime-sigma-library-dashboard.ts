import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createDashboardSummary,
  writeDashboardHtml,
  writeDashboardJson,
  type SigmaLibraryEnv,
  type SelfImprovementSignal,
} from '../ts/lib/intelligent-library.js';

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

function argValue(name: string, fallback: string): string {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');
const installedLaunchAgent = path.join(os.homedir(), 'Library/LaunchAgents/ai.sigma.daily.plist');
const repoLaunchAgent = path.join(repoRoot, 'bots/sigma/launchd/ai.sigma.daily.plist');

function readLaunchdEnv(plistPath: string): SigmaLibraryEnv | null {
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

function resolveDashboardEnv(): { env: SigmaLibraryEnv; source: string } {
  const installedEnv = readLaunchdEnv(installedLaunchAgent);
  if (installedEnv) {
    return { env: { ...(process.env as SigmaLibraryEnv), ...installedEnv }, source: installedLaunchAgent };
  }
  const repoEnv = readLaunchdEnv(repoLaunchAgent);
  if (repoEnv) {
    return { env: { ...(process.env as SigmaLibraryEnv), ...repoEnv }, source: repoLaunchAgent };
  }
  return { env: process.env as SigmaLibraryEnv, source: 'process.env' };
}

const sampleTexts = [
  'Sigma library memory graph connects Luna trade reflexion with Blog publishing incidents',
  'Ska reservation failures and Jay auto_dev repairs should preserve lineage and dataset value',
  'Legal case documents require rag_legal isolation and master approval before external export',
];

const sampleSignals: SelfImprovementSignal[] = [
  ...Array.from({ length: 5 }, () => ({
    team: 'sigma',
    agent: 'librarian',
    outcome: 'success' as const,
    pattern: 'cross team memory prefix improves answer quality',
    promptName: 'sigma_library_context_v1',
  })),
  ...Array.from({ length: 3 }, () => ({
    team: 'sigma',
    agent: 'librarian',
    outcome: 'failure' as const,
    pattern: 'dataset export attempted without lineage',
  })),
];

const dashboardEnv = resolveDashboardEnv();
const summary = createDashboardSummary({
  texts: sampleTexts,
  signals: sampleSignals,
  env: dashboardEnv.env,
});

const outPath = argValue(
  '--out',
  path.join(repoRoot, 'bots/sigma/output/library-dashboard.json'),
);
const htmlOutPath = argValue(
  '--html-out',
  path.join(repoRoot, 'bots/sigma/output/library-dashboard.html'),
);

if (hasArg('--write')) {
  writeDashboardJson(outPath, summary);
}
if (hasArg('--write-html')) {
  writeDashboardHtml(htmlOutPath, summary);
}

if (hasArg('--json') || !hasArg('--quiet')) {
  console.log(JSON.stringify({
    ...summary,
    activationEnvSource: dashboardEnv.source,
    outputPath: hasArg('--write') ? outPath : null,
    htmlOutputPath: hasArg('--write-html') ? htmlOutPath : null,
    dryRun: !hasArg('--write'),
  }, null, 2));
}
