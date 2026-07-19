#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getVectorBtPythonBin } from '../shared/vectorbt-runner.ts';

const pythonBin = getVectorBtPythonBin();
const version = execFileSync(
  pythonBin,
  ['-c', 'import vectorbt; print(vectorbt.__version__)'],
  { encoding: 'utf8', timeout: 15_000 },
).trim();

assert.match(version, /^\d+\.\d+\.\d+/, 'selected Python must load vectorbt');
const investmentDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(investmentDir, 'package.json'), 'utf8'));
const directPythonBypasses = Object.entries(packageJson.scripts || {})
  .filter(([, command]) => /python3[^\n]*(backtest-vectorbt|luna-nextbar|luna-c7-permutation|luna-cpcv-pbo)/.test(String(command)))
  .map(([scriptName]) => scriptName);
assert.deepEqual(directPythonBypasses, [], 'vectorbt package commands must not bypass the Python resolver');
const vectorBtCommands = [
  'smoke:luna-nextbar-compare',
  'smoke:luna-c7-permutation',
  'smoke:luna-cpcv-pbo',
  'check:luna-p1-nextbar',
  'check:luna-c7-permutation',
  'check:luna-cpcv-pbo',
  'backtest:vectorbt',
  'backtest:vectorbt:grid',
];
for (const scriptName of vectorBtCommands) {
  const command = String(packageJson.scripts?.[scriptName] || '');
  assert.ok(command, `missing vectorbt command: ${scriptName}`);
  assert.equal(/(^|\s)python3(\s|$)/.test(command), false, `${scriptName} must not bypass the Python resolver`);
  assert.match(command, /luna-vectorbt-python\.ts/, `${scriptName} must use the shared Python wrapper`);
}
console.log(`luna-vectorbt-runner-smoke ok python=${pythonBin} vectorbt=${version}`);
