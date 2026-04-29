#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { buildDailyFeedbackHealth } from './daily-feedback-health.ts';

const report = await buildDailyFeedbackHealth({ strict: true });

assert.equal(report.runtime?.ok, true, 'daily-feedback dry-run must succeed after kickstart');
assert.equal(report.errorLog?.recentCrashPattern, false, 'daily-feedback must not append a fresh crash log');
assert.equal(report.launchd?.loaded, true, 'daily-feedback launchd job must be loaded');
assert.equal(report.launchd?.lastExitStatus, 0, 'daily-feedback launchd last exit status must be clear after kickstart');
assert.equal(report.blockers?.length || 0, 0, `daily-feedback blockers: ${(report.blockers || []).join(', ')}`);

const payload = {
  ok: true,
  smoke: 'daily-feedback-after-kickstart',
  status: report.status,
  launchd: report.launchd,
  warnings: report.warnings,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('daily-feedback-after-kickstart-smoke ok');
}
