#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const scriptPath = path.join(__dirname, 'publish-python-report.ts');
const tsxPath = path.join(__dirname, '..', '..', '..', 'node_modules', '.bin', 'tsx');
const argv = process.argv.slice(2);

if (!fs.existsSync(scriptPath)) {
  console.error(`[publish-python-report] missing source script: ${scriptPath}`);
  process.exit(1);
}

if (!fs.existsSync(tsxPath)) {
  console.error(`[publish-python-report] missing tsx runtime: ${tsxPath}`);
  process.exit(1);
}

const result = spawnSync(tsxPath, [scriptPath, ...argv], {
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  console.error(`[publish-python-report] failed to exec tsx: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 0);
