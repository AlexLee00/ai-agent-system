#!/usr/bin/env node
// @ts-nocheck
/**
 * Operational health check for ai.investment.daily-feedback.
 *
 * This does not kickstart launchd or run live feedback. It verifies the runtime
 * entrypoint through the same Node path and reports launchd/log state so the
 * operator can safely decide when to restart the job.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const __filename = fileURLToPath(import.meta.url);
const scriptsDir = dirname(__filename);
const investmentRoot = resolve(scriptsDir, '..');
const feedbackEntrypoint = join(scriptsDir, 'daily-trade-feedback.ts');
const DEFAULT_ERROR_LOG = '/tmp/investment-daily-feedback.err.log';
const LAUNCHD_LABEL = 'ai.investment.daily-feedback';
const CRASH_PATTERNS = [
  /ERR_MODULE_NOT_FOUND/i,
  /strip-only mode/i,
  /TypeScript import equals declaration/i,
  /SyntaxError/i,
  /ReferenceError/i,
  /UnhandledPromiseRejection/i,
];

function parseArgs(argv = process.argv.slice(2)) {
  return {
    json: argv.includes('--json'),
    strict: argv.includes('--strict'),
    logPath: argv.find((arg) => arg.startsWith('--log='))?.split('=')[1] || DEFAULT_ERROR_LOG,
  };
}

function runDailyFeedbackDryRun() {
  const startedAtMs = Date.now();
  const result = spawnSync(process.execPath, [
    feedbackEntrypoint,
    '--dry-run',
    '--json',
    '--date=1900-01-01',
    '--market=binance',
  ], {
    cwd: investmentRoot,
    env: {
      ...process.env,
      INVESTMENT_SUPPRESS_TEST_ALERTS: '1',
    },
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 1024 * 1024 * 8,
  });
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  return {
    ok: !result.error && result.status === 0 && stdout.includes('"dryRun": true') && !CRASH_PATTERNS.some((pattern) => pattern.test(stderr)),
    status: result.status,
    error: result.error ? String(result.error?.message || result.error) : null,
    startedAtMs,
    stdoutPreview: stdout.slice(0, 500),
    stderrPreview: stderr.slice(0, 500),
  };
}

function inspectLaunchdStatus() {
  const result = spawnSync('launchctl', ['list'], { encoding: 'utf8', timeout: 10_000 });
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      label: LAUNCHD_LABEL,
      error: String(result.error?.message || result.stderr || 'launchctl_failed').slice(0, 240),
    };
  }
  const line = String(result.stdout || '').split(/\r?\n/).find((item) => item.includes(LAUNCHD_LABEL));
  if (!line) {
    return {
      ok: false,
      label: LAUNCHD_LABEL,
      loaded: false,
      lastExitStatus: null,
      pid: null,
    };
  }
  const parts = line.trim().split(/\s+/);
  const pid = parts[0] === '-' ? null : Number(parts[0]);
  const lastExitStatus = parts[1] == null || parts[1] === '-' ? null : Number(parts[1]);
  return {
    ok: true,
    label: LAUNCHD_LABEL,
    loaded: true,
    pid: Number.isFinite(pid) ? pid : null,
    lastExitStatus: Number.isFinite(lastExitStatus) ? lastExitStatus : null,
    raw: line.trim(),
  };
}

function inspectErrorLog(logPath, sinceMs) {
  if (!existsSync(logPath)) {
    return {
      ok: true,
      path: logPath,
      exists: false,
      recentCrashPattern: false,
      matchedPatterns: [],
    };
  }
  const stat = statSync(logPath);
  const updatedAtMs = stat.mtimeMs;
  const content = readFileSync(logPath, 'utf8');
  const tail = content.slice(-16_000);
  const matchedPatterns = CRASH_PATTERNS
    .filter((pattern) => pattern.test(tail))
    .map((pattern) => String(pattern).replace(/^\/|\/[a-z]*$/gi, ''));
  return {
    ok: matchedPatterns.length === 0 || updatedAtMs < sinceMs,
    path: logPath,
    exists: true,
    updatedAt: new Date(updatedAtMs).toISOString(),
    updatedDuringCheck: updatedAtMs >= sinceMs,
    recentCrashPattern: updatedAtMs >= sinceMs && matchedPatterns.length > 0,
    matchedPatterns,
    tailPreview: tail.slice(-800),
  };
}

export async function buildDailyFeedbackHealth({ strict = false, logPath = DEFAULT_ERROR_LOG } = {}) {
  const runtime = runDailyFeedbackDryRun();
  const launchd = inspectLaunchdStatus();
  const errorLog = inspectErrorLog(logPath, runtime.startedAtMs);
  const warnings = [];
  const blockers = [];

  if (!runtime.ok) blockers.push('daily_feedback_runtime_dry_run_failed');
  if (errorLog.recentCrashPattern) blockers.push('daily_feedback_recent_crash_log');
  if (!launchd.loaded) warnings.push('daily_feedback_launchd_not_loaded');
  if (launchd.loaded && launchd.lastExitStatus != null && launchd.lastExitStatus !== 0) {
    warnings.push(`daily_feedback_previous_exit_status_${launchd.lastExitStatus}`);
    if (strict) blockers.push('daily_feedback_launchd_previous_exit_nonzero');
  }

  return {
    ok: blockers.length === 0,
    status: blockers.length ? 'daily_feedback_health_blocked' : 'daily_feedback_health_clear',
    generatedAt: new Date().toISOString(),
    strict,
    runtime,
    launchd,
    errorLog,
    warnings,
    blockers,
    nextAction: blockers.length
      ? 'fix_daily_feedback_runtime_before_kickstart'
      : (warnings.length ? 'kickstart_or_wait_for_launchd_to_clear_previous_exit' : 'daily_feedback_operational'),
  };
}

async function main() {
  const args = parseArgs();
  const report = await buildDailyFeedbackHealth(args);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(`${report.status} warnings=${report.warnings.length} blockers=${report.blockers.length}`);
  return report;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ daily-feedback-health 실패:',
  });
}

