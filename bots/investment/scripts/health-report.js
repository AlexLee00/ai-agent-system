#!/usr/bin/env node
// ESM shim so `node bots/investment/scripts/health-report.js` keeps working.
// The primary implementation lives in `health-report.ts`.

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const target = path.join(__dirname, 'health-report.ts');

const proc = spawnSync(process.execPath, [target, ...process.argv.slice(2)], {
  stdio: 'inherit',
});

process.exit(typeof proc.status === 'number' ? proc.status : 1);

