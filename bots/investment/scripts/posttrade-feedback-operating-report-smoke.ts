#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  buildPosttradeFeedbackOperatingReport,
  renderPosttradeFeedbackOperatingReport,
} from './runtime-posttrade-feedback-operating-report.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function runSmoke() {
  const report = await buildPosttradeFeedbackOperatingReport({ days: 7, market: 'all', strict: false });
  assert.ok(report.generatedAt);
  assert.ok(report.config);
  assert.ok(report.doctor);
  assert.ok(report.readiness);
  assert.ok(report.gate);
  assert.ok(report.phasePlan);
  assert.ok(report.launchd);
  assert.ok(report.actionStaging);
  assert.ok(renderPosttradeFeedbackOperatingReport(report).includes('posttrade feedback operating report'));
  return {
    ok: true,
    status: report.status,
    nextAction: report.nextAction,
    blockers: report.blockers || [],
  };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('posttrade feedback operating report smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ posttrade-feedback-operating-report-smoke 실패:',
  });
}
