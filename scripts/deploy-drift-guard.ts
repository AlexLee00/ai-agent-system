#!/usr/bin/env node
// @ts-nocheck

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanDeployDriftTargets } from '../bots/_shared/hooks/deploy-drift-guard.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function parseArgs(argv = process.argv.slice(2)) {
  return {
    json: argv.includes('--json'),
    strict: argv.includes('--strict'),
    envAllowlist: argv
      .find((arg) => arg.startsWith('--env-allowlist='))
      ?.slice('--env-allowlist='.length)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean) || [],
  };
}

async function main() {
  const args = parseArgs();
  const report = scanDeployDriftTargets({
    repoRoot,
    envAllowlist: args.envAllowlist,
  });
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[deploy-drift-guard] targets=${report.total} drift=${report.driftCount} advisoryOnly=${report.advisoryOnly}`);
  }
  if (args.strict && report.driftCount > 0) process.exit(1);
}

main().catch((error) => {
  console.error(`[deploy-drift-guard] failed: ${error?.message || error}`);
  process.exit(1);
});

