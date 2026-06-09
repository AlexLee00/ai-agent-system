#!/usr/bin/env node
'use strict';

const path = require('path');
const { buildPatternReadinessReport } = require('../lib/symphony/pattern-readiness.ts');

/** @param {string} name */
function hasFlag(name = '') {
  return process.argv.includes(`--${name}`);
}

const ROOT = path.resolve(__dirname, '..', '..', '..');
const report = buildPatternReadinessReport(ROOT);

if (hasFlag('json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`${report.status}: blockers=${report.blockers.length} warnings=${report.warnings.length}`);
}

if (hasFlag('fail-on-blocked') && !report.ok) {
  process.exitCode = 1;
}
