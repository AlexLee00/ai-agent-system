#!/usr/bin/env node
// @ts-nocheck
/**
 * Archive stale daily-feedback stderr logs after the runtime has recovered.
 *
 * This keeps health reports from showing old crash tails while preserving the
 * original log for forensic review.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const DEFAULT_LOG_PATH = '/tmp/investment-daily-feedback.err.log';
const REQUIRED_CONFIRM = 'archive-daily-feedback-stale-log';
const CRASH_PATTERNS = [
  /ERR_MODULE_NOT_FOUND/i,
  /strip-only mode/i,
  /TypeScript import equals declaration/i,
  /SyntaxError/i,
  /ReferenceError/i,
  /UnhandledPromiseRejection/i,
];

export function buildDailyFeedbackLogHygienePlan({
  logPath = DEFAULT_LOG_PATH,
  nowMs = Date.now(),
  staleMinutes = 5,
} = {}) {
  if (!existsSync(logPath)) {
    return {
      ok: true,
      status: 'daily_feedback_log_absent',
      logPath,
      shouldArchive: false,
      matchedPatterns: [],
      ageMinutes: null,
      archivePath: null,
    };
  }

  const stat = statSync(logPath);
  const content = readFileSync(logPath, 'utf8');
  const tail = content.slice(-16_000);
  const matchedPatterns = CRASH_PATTERNS
    .filter((pattern) => pattern.test(tail))
    .map((pattern) => String(pattern).replace(/^\/|\/[a-z]*$/gi, ''));
  const ageMinutes = Math.max(0, (nowMs - stat.mtimeMs) / 60_000);
  const archivePath = `${logPath}.archived-${new Date(nowMs).toISOString().replace(/[:.]/g, '-')}`;
  const shouldArchive = matchedPatterns.length > 0 && ageMinutes >= staleMinutes;

  return {
    ok: true,
    status: shouldArchive ? 'daily_feedback_stale_crash_log_archive_ready' : 'daily_feedback_log_hygiene_clear',
    logPath,
    shouldArchive,
    matchedPatterns,
    ageMinutes: Number(ageMinutes.toFixed(2)),
    staleMinutes,
    archivePath,
  };
}

export function applyDailyFeedbackLogHygiene(plan) {
  if (!plan?.shouldArchive) {
    return {
      ok: true,
      applied: false,
      status: plan?.status || 'daily_feedback_log_hygiene_clear',
      archivePath: plan?.archivePath || null,
    };
  }
  mkdirSync(dirname(plan.archivePath), { recursive: true });
  renameSync(plan.logPath, plan.archivePath);
  return {
    ok: true,
    applied: true,
    status: 'daily_feedback_stale_crash_log_archived',
    archivePath: plan.archivePath,
  };
}

function parseArgs(argv = process.argv.slice(2)) {
  return {
    json: argv.includes('--json'),
    apply: argv.includes('--apply'),
    confirm: argv.find((arg) => arg.startsWith('--confirm='))?.split('=')[1] || null,
    logPath: argv.find((arg) => arg.startsWith('--log='))?.split('=')[1] || DEFAULT_LOG_PATH,
    staleMinutes: Number(argv.find((arg) => arg.startsWith('--stale-minutes='))?.split('=')[1] || 5),
  };
}

async function main() {
  const args = parseArgs();
  const plan = buildDailyFeedbackLogHygienePlan(args);
  const confirmRequired = args.apply && args.confirm !== REQUIRED_CONFIRM;
  const action = args.apply && !confirmRequired
    ? applyDailyFeedbackLogHygiene(plan)
    : { ok: !confirmRequired, applied: false, status: confirmRequired ? 'confirm_required' : 'dry_run' };
  const report = {
    ok: plan.ok && action.ok,
    requiredConfirm: REQUIRED_CONFIRM,
    dryRun: !args.apply,
    confirmRequired,
    plan,
    action,
  };
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(`${plan.status} applied=${action.applied === true}`);
  return report;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ daily-feedback-log-hygiene 실패:',
  });
}

export default {
  buildDailyFeedbackLogHygienePlan,
  applyDailyFeedbackLogHygiene,
};
