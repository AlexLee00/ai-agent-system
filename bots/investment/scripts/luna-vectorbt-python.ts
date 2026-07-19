#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getVectorBtPythonBin } from '../shared/vectorbt-runner.ts';

const investmentDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(getVectorBtPythonBin(), process.argv.slice(2), {
  cwd: investmentDir,
  env: process.env,
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
