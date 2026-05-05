import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDashboardSummary,
  writeDashboardHtml,
  writeDashboardJson,
  type SigmaLibraryEnv,
  type SelfImprovementSignal,
} from '../ts/lib/intelligent-library.js';
import { resolveSigmaRuntimeEnv } from './sigma-runtime-env.js';

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

const dashboardEnv = resolveSigmaRuntimeEnv(repoRoot);
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
