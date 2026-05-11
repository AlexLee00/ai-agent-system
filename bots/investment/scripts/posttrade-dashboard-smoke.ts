#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { buildPosttradeFeedbackDashboard } from './runtime-posttrade-feedback-dashboard.ts';
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function runSmoke() {
  const all = await buildPosttradeFeedbackDashboard({ days: 7, market: 'all' });
  assert.equal(all?.ok, true, 'dashboard all market ok');
  assert.equal(all?.event_type, 'posttrade_dashboard_report', 'event_type standardized');
  assert.ok(all?.quality && Number.isFinite(Number(all.quality.total || 0)), 'quality total exists');
  const directQuality = await db.get(
    `SELECT COUNT(*)::int AS cnt
       FROM investment.trade_quality_evaluations
      WHERE evaluated_at >= NOW() - (7 * INTERVAL '1 day')`,
    [],
  ).catch(() => null);
  if (Number(directQuality?.cnt || 0) > 0) {
    assert.ok(Number(all.quality.total || 0) > 0, 'dashboard includes journal-backed trade quality rows');
  }

  const crypto = await buildPosttradeFeedbackDashboard({ days: 7, market: 'crypto' });
  assert.equal(crypto?.ok, true, 'dashboard crypto ok');
  assert.equal(crypto?.market, 'crypto', 'market filter applied');

  return {
    ok: true,
    all: {
      totalQuality: all?.quality?.total ?? 0,
      extractedSkills: all?.learning_channels?.extracted_skills ?? 0,
    },
    crypto: {
      totalQuality: crypto?.quality?.total ?? 0,
      extractedSkills: crypto?.learning_channels?.extracted_skills ?? 0,
    },
  };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('posttrade-dashboard-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ posttrade-dashboard-smoke 실패:',
  });
}
