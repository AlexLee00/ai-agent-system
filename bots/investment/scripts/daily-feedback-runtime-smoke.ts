#!/usr/bin/env node
// @ts-nocheck
/**
 * Launchd-equivalent dry-run check for ai.investment.daily-feedback.
 *
 * This intentionally executes the script through Node instead of importing the
 * function directly, because the historical failure was module resolution in
 * the runtime entrypoint.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const scriptsDir = path.dirname(__filename);
const investmentRoot = path.resolve(scriptsDir, '..');
const target = path.join(scriptsDir, 'daily-trade-feedback.ts');

const result = spawnSync(process.execPath, [
  target,
  '--dry-run',
  '--json',
  '--date=1900-01-01',
  '--market=binance',
], {
  cwd: investmentRoot,
  env: {
    ...process.env,
    INVESTMENT_SUPPRESS_TEST_ALERTS: '1',
  },
  encoding: 'utf8',
  timeout: 120_000,
  maxBuffer: 1024 * 1024 * 8,
});

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  throw new Error(`daily-feedback runtime failed status=${result.status}\nSTDERR:\n${result.stderr}\nSTDOUT:\n${result.stdout}`);
}
if (!String(result.stdout || '').includes('"dryRun": true')) {
  throw new Error(`daily-feedback runtime did not return dryRun json\nSTDOUT:\n${result.stdout}`);
}
if (String(result.stderr || '').includes('ERR_MODULE_NOT_FOUND') || String(result.stderr || '').includes('strip-only mode')) {
  throw new Error(`daily-feedback runtime still has module-resolution/strip-only failure\nSTDERR:\n${result.stderr}`);
}

const payload = {
  ok: true,
  smoke: 'daily-feedback-runtime',
  entrypoint: target,
  status: result.status,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('✅ daily-feedback runtime smoke passed');
}
