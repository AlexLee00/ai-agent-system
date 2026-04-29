#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPosttradeFeedbackDashboard, recordPosttradeFeedbackDashboard } from './runtime-posttrade-feedback-dashboard.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = path.join(__dirname, '..', 'migrations', '20260428_posttrade_feedback_loop.sql');

function assertMigrationCoverage() {
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  for (const marker of [
    'investment.trade_quality_evaluations',
    'investment.trade_decision_attribution',
    'investment.luna_failure_reflexions',
    'idx_lfr_trade_unique',
    'investment.feedback_to_action_map',
    'investment.luna_posttrade_skills',
    'idx_lps_market_type',
  ]) {
    assert.ok(sql.includes(marker), `migration contains ${marker}`);
  }
}

async function runSmoke() {
  assertMigrationCoverage();
  const dashboard = await buildPosttradeFeedbackDashboard({ days: 7, market: 'all' });
  assert.equal(dashboard?.ok, true, 'dashboard builds');
  const dryRecord = await recordPosttradeFeedbackDashboard(dashboard, { dryRun: true });
  assert.equal(dryRecord?.ok, true, 'dashboard dry-record ok');
  assert.equal(dryRecord?.recorded, false, 'dry-record is non-mutating');

  return {
    ok: true,
    migrationPath: MIGRATION_PATH,
    dashboardEventType: dashboard.event_type,
    dryRecord,
  };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('posttrade-feedback-integration-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ posttrade-feedback-integration-smoke 실패:',
  });
}

