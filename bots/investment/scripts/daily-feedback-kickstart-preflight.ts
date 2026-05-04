#!/usr/bin/env node
// @ts-nocheck

import { buildDailyFeedbackHealth } from './daily-feedback-health.ts';
import { runLaunchdKickstart } from '../shared/launchd-service.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getServiceOwnership, isRetiredService } = require('../../../packages/core/lib/service-ownership');
const LABEL = 'ai.investment.daily-feedback';
const REQUIRED_CONFIRM = 'daily-feedback-kickstart';

function parseArgs(argv = process.argv.slice(2)) {
  return {
    json: argv.includes('--json'),
    apply: argv.includes('--apply'),
    strict: argv.includes('--strict'),
    confirm: argv.find((arg) => arg.startsWith('--confirm='))?.split('=')[1] || null,
  };
}

export async function buildDailyFeedbackKickstartPreflight({
  apply = false,
  strict = false,
  confirm = null,
} = {}) {
  const health = await buildDailyFeedbackHealth({ strict });
  const ownership = getServiceOwnership(LABEL);
  const retired = isRetiredService(LABEL);
  const blockers = [...(health.blockers || [])];
  if (health.launchd?.loaded !== true && !retired) blockers.push('daily_feedback_launchd_not_loaded');

  const canKickstart = blockers.length === 0 && !retired;
  const kickstart = retired
    ? {
        ok: true,
        dryRun: !apply,
        applied: false,
        label: LABEL,
        retired: true,
        replacement: ownership?.replacement || 'ai.luna.ops-scheduler',
      }
    : canKickstart
    ? runLaunchdKickstart(LABEL, {
        apply,
        confirm,
        requiredConfirm: REQUIRED_CONFIRM,
      })
    : {
        ok: false,
        dryRun: !apply,
        applied: false,
        label: LABEL,
        error: 'preflight_blocked',
      };

  return {
    ok: (canKickstart || retired) && kickstart.ok === true,
    status: retired
      ? 'daily_feedback_migrated_to_luna_ops_scheduler'
      : canKickstart
      ? (apply ? (kickstart.applied ? 'daily_feedback_kickstart_applied' : 'daily_feedback_kickstart_not_applied') : 'daily_feedback_kickstart_ready')
      : 'daily_feedback_kickstart_blocked',
    generatedAt: new Date().toISOString(),
    dryRun: !apply,
    requiredConfirm: REQUIRED_CONFIRM,
    retired,
    replacement: retired ? (ownership?.replacement || 'ai.luna.ops-scheduler') : null,
    blockers,
    health: {
      ok: health.ok,
      status: health.status,
      warnings: health.warnings,
      blockers: health.blockers,
      launchd: health.launchd,
      errorLog: {
        path: health.errorLog?.path,
        updatedDuringCheck: health.errorLog?.updatedDuringCheck,
        recentCrashPattern: health.errorLog?.recentCrashPattern,
      },
    },
    kickstart,
    nextAction: retired
      ? 'monitor_via_luna_ops_scheduler'
      : canKickstart
      ? (apply ? 'verify_launchd_status_after_kickstart' : `rerun_with_--apply_--confirm=${REQUIRED_CONFIRM}`)
      : 'fix_daily_feedback_health_blockers',
  };
}

async function main() {
  const args = parseArgs();
  const report = await buildDailyFeedbackKickstartPreflight(args);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`${report.status} dryRun=${report.dryRun} blockers=${report.blockers.length}`);
    console.log(`next: ${report.nextAction}`);
  }
  if (args.strict && report.ok !== true) process.exitCode = 1;
  return report;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ daily-feedback-kickstart-preflight 실패:',
  });
}
