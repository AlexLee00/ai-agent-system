// @ts-nocheck
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const env = require('../../../../packages/core/lib/env');

const EDUX_ROOT = path.join(env.PROJECT_ROOT, 'bots', 'edu-x');

function runNodeScript(script, args = []) {
  const stdout = execFileSync(process.execPath, [path.join(EDUX_ROOT, 'scripts', script), ...args], {
    cwd: EDUX_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      EDUX_DRY_RUN: 'true',
      EDUX_SKIP_DB: process.env.EDUX_SKIP_DB || 'false',
    },
    maxBuffer: 1024 * 1024 * 4,
  });
  return stdout;
}

function eduxStatusReport(params = {}) {
  return runNodeScript('runtime-edux-integration-report.ts', ['--json', params.noWrite !== false ? '--no-write' : ''].filter(Boolean));
}

function eduxPromotionReport(params = {}) {
  return runNodeScript('edux-promotion-gate.ts', ['--json', params.fixture ? '--fixture' : '', params.noWrite !== false ? '--no-write' : ''].filter(Boolean));
}

function eduxDryRunSlot(params = {}) {
  const category = params.category || 'crypto';
  const slot = params.slot || (category === 'kis' ? '0900' : category === 'overseas' ? '2200' : '1400');
  const script = category === 'kis'
    ? 'runtime-edux-kis-daily.ts'
    : category === 'overseas'
      ? 'runtime-edux-overseas-daily.ts'
      : 'runtime-edux-crypto-daily.ts';
  const args = ['--dry-run', '--json'];
  if (params.fixture) args.push('--fixture');
  args.push(`--slot=${slot}`);
  return runNodeScript(script, args);
}

module.exports = { eduxStatusReport, eduxPromotionReport, eduxDryRunSlot };
