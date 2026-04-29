#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  applyDailyFeedbackLogHygiene,
  buildDailyFeedbackLogHygienePlan,
} from './daily-feedback-log-hygiene.ts';

const root = mkdtempSync(join(tmpdir(), 'daily-feedback-log-hygiene-'));
const logPath = join(root, 'daily-feedback.err.log');
writeFileSync(logPath, 'Error [ERR_MODULE_NOT_FOUND]: stale crash\nTypeScript import equals declaration is not supported in strip-only mode\n');
const staleNowMs = statSync(logPath).mtimeMs + (10 * 60_000);

const plan = buildDailyFeedbackLogHygienePlan({
  logPath,
  nowMs: staleNowMs,
  staleMinutes: 5,
});
assert.equal(plan.shouldArchive, true, 'stale crash log should be archive-ready');
assert.equal(plan.matchedPatterns.length >= 1, true, 'crash patterns should be detected');

const action = applyDailyFeedbackLogHygiene(plan);
assert.equal(action.applied, true, 'archive action should apply');
assert.equal(existsSync(logPath), false, 'original log should be moved');
assert.equal(existsSync(action.archivePath), true, 'archive log should exist');

const freshLog = join(root, 'fresh.err.log');
writeFileSync(freshLog, 'Error [ERR_MODULE_NOT_FOUND]: fresh crash\n');
const freshPlan = buildDailyFeedbackLogHygienePlan({
  logPath: freshLog,
  nowMs: statSync(freshLog).mtimeMs + 1_000,
  staleMinutes: 5,
});
assert.equal(freshPlan.shouldArchive, false, 'fresh crash log should not be archived');

const payload = {
  ok: true,
  smoke: 'daily-feedback-log-hygiene',
  archived: action.applied,
  freshArchived: freshPlan.shouldArchive,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('daily-feedback-log-hygiene-smoke ok');
}
