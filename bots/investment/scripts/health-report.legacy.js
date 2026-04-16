'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function findRepoRoot(startDir) {
  let current = path.resolve(startDir);

  while (true) {
    const packageJsonPath = path.join(current, 'package.json');
    const sourcePath = path.join(current, 'bots/investment/scripts/health-report.ts');
    if (fs.existsSync(packageJsonPath) && fs.existsSync(sourcePath)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveSourcePath() {
  const repoRoot =
    process.env.REPO_ROOT ||
    process.env.PROJECT_ROOT ||
    findRepoRoot(__dirname) ||
    findRepoRoot(process.cwd());

  const candidates = [
    path.join(__dirname, 'health-report.ts'),
    ...(repoRoot ? [path.join(repoRoot, 'bots/investment/scripts/health-report.ts')] : []),
    path.resolve(__dirname, './health-report.ts'),
    path.resolve(__dirname, '../../../bots/investment/scripts/health-report.ts'),
    path.resolve(__dirname, '../../../dist/ts-runtime/bots/investment/scripts/health-report.ts'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error(`Unable to locate investment health-report.ts runtime source (checked: ${candidates.join(', ')})`);
}

const sourcePath = resolveSourcePath();

(async () => {
  await import(pathToFileURL(sourcePath).href);
})().catch((error) => {
  console.error('[investment health-report legacy] source import failed:', error?.message || error);
  process.exitCode = 1;
});
