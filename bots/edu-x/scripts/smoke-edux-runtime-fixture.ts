#!/usr/bin/env node
// @ts-nocheck
'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const env = require('../../../packages/core/lib/env');

const EDUX_ROOT = path.join(env.PROJECT_ROOT, 'bots', 'edu-x');

function runScript(script, args = []) {
  const stdout = execFileSync(process.execPath, [path.join(EDUX_ROOT, 'scripts', script), '--fixture', '--dry-run', '--json', ...args], {
    cwd: EDUX_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      EDUX_SKIP_DB: 'true',
      EDUX_DRY_RUN: 'true',
      EDUX_FORMATTER_FIXTURE: 'true',
      EDUX_DISABLE_TRADINGVIEW_READONLY: 'true',
      EDUX_DISABLE_TELEGRAM: 'true',
    },
    maxBuffer: 1024 * 1024 * 8,
  });
  assert(stdout.includes('"status": "dry_run"'), `${script} did not dry-run: ${stdout.slice(-500)}`);
  return stdout;
}

function main() {
  runScript('runtime-edux-crypto-daily.ts', ['--slot=0600']);
  runScript('runtime-edux-crypto-daily.ts', ['--slot=1400']);
  runScript('runtime-edux-crypto-daily.ts', ['--slot=2230']);
  runScript('runtime-edux-kis-daily.ts');
  runScript('runtime-edux-overseas-daily.ts');
  console.log(JSON.stringify({ ok: true, slots: ['0600', '0900', '1400', '2200', '2230'] }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
