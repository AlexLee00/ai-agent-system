#!/usr/bin/env node
// @ts-nocheck
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');

const EDUX_ROOT = path.join(env.PROJECT_ROOT, 'bots', 'edu-x');

function listFiles(dir, predicate, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) listFiles(full, predicate, acc);
    else if (predicate(full)) acc.push(full);
  }
  return acc;
}

function run(label, command, args, options = {}) {
  console.log(`[edu-x/check] ${label}`);
  execFileSync(command, args, {
    cwd: EDUX_ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      EDUX_SKIP_DB: 'true',
      EDUX_DRY_RUN: 'true',
      EDUX_FORMATTER_FIXTURE: 'true',
      EDUX_DISABLE_TRADINGVIEW_READONLY: 'true',
      EDUX_DISABLE_TELEGRAM: 'true',
      ...(options.env || {}),
    },
  });
}

function main() {
  const tsFiles = listFiles(EDUX_ROOT, (filePath) => filePath.endsWith('.ts'));
  for (const filePath of tsFiles) run(`node --check ${path.relative(EDUX_ROOT, filePath)}`, process.execPath, ['--check', filePath]);
  const plists = listFiles(path.join(EDUX_ROOT, 'launchd'), (filePath) => filePath.endsWith('.plist'));
  for (const plist of plists) run(`plutil ${path.basename(plist)}`, 'plutil', ['-lint', plist]);
  run('smoke:client', process.execPath, [path.join(EDUX_ROOT, 'scripts', 'smoke-edux-client.ts')]);
  run('smoke:formatter', process.execPath, [path.join(EDUX_ROOT, 'scripts', 'smoke-edux-formatter.ts')]);
  run('smoke:image', process.execPath, [path.join(EDUX_ROOT, 'scripts', 'smoke-edux-image.ts')]);
  run('smoke:runtime-fixture', process.execPath, [path.join(EDUX_ROOT, 'scripts', 'smoke-edux-runtime-fixture.ts')]);
  run('smoke:market-close', process.execPath, [path.join(EDUX_ROOT, 'scripts', 'smoke-edux-market-close.ts')]);
  run('smoke:seven-slot-quality', process.execPath, [path.join(EDUX_ROOT, 'scripts', 'smoke-edux-seven-slot-quality.ts')]);
  run('smoke:promotion-gate', process.execPath, [path.join(EDUX_ROOT, 'scripts', 'smoke-edux-promotion-gate.ts')]);
  console.log('[edu-x/check] ok');
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('[edu-x/check] failed:', err?.message || err);
    process.exit(1);
  }
}
