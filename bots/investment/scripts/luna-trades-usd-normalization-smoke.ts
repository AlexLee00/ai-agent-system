#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildLunaFxRefreshPlan } from './luna-fx-refresh.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const INVESTMENT_ROOT = path.resolve(import.meta.dirname, '..');
const PROJECT_ROOT = path.resolve(INVESTMENT_ROOT, '../..');

function read(relativePath) {
  return fs.readFileSync(path.join(INVESTMENT_ROOT, relativePath), 'utf8');
}

function readProject(relativePath) {
  return fs.readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

export async function runLunaTradesUsdNormalizationSmoke() {
  const fxSql = read('migrations/20260512_fx_rates.sql');
  const viewSql = read('migrations/20260512_v_trades_real_usd.sql');
  const reportScript = read('scripts/luna-daily-pnl-report.ts');
  const fxRefreshScript = read('scripts/luna-fx-refresh.ts');
  const fxRefreshPlist = read('launchd/ai.luna.fx-refresh.plist');
  const dailyPnlPlist = read('launchd/ai.luna.daily-pnl-report.plist');
  const telegramSenderBridge = readProject('packages/core/lib/telegram-sender.js');

  assert.match(fxSql, /CREATE TABLE IF NOT EXISTS investment\.fx_rates/);
  assert.match(fxSql, /'KRW'\s*,\s*'USD'\s*,\s*0\.000735/);
  assert.match(fxSql, /ON CONFLICT DO NOTHING/);

  assert.match(viewSql, /CREATE MATERIALIZED VIEW IF NOT EXISTS investment\.v_trades_real_usd/);
  assert.doesNotMatch(viewSql, /DROP MATERIALIZED VIEW/i);
  assert.match(viewSql, /journal_reconciled_no_position/);
  assert.match(viewSql, /journal_reconciled_duplicate_open/);
  assert.doesNotMatch(viewSql, /exit_reason NOT LIKE 'journal_reconciled%'/);
  assert.match(viewSql, /WHEN j\.exchange = 'kis'\s+THEN j\.pnl_amount \*/);
  assert.match(viewSql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_v_trades_real_usd_id/);

  assert.match(fxRefreshScript, /REFRESH MATERIALIZED VIEW CONCURRENTLY investment\.v_trades_real_usd/);
  assert.match(fxRefreshScript, /carry_forward/);
  assert.match(fxRefreshPlist, /ai\.luna\.fx-refresh/);
  assert.match(fxRefreshPlist, /luna-fx-refresh\.ts/);
  assert.match(fxRefreshPlist, /<integer>6<\/integer>/);

  assert.match(reportScript, /FROM investment\.v_trades_real_usd/);
  assert.match(reportScript, /query\('investment',/);
  assert.match(reportScript, /telegramSender\.send\('luna', message\)/);
  assert.match(reportScript, /--dry-run/);
  assert.match(telegramSenderBridge, /loadTsSourceBridge\(__dirname, 'telegram-sender'\)/);
  assert.match(dailyPnlPlist, /ai\.luna\.daily-pnl-report/);
  assert.match(dailyPnlPlist, /luna-daily-pnl-report\.ts/);
  assert.match(dailyPnlPlist, /<integer>23<\/integer>/);
  assert.match(dailyPnlPlist, /<integer>30<\/integer>/);

  const plan = buildLunaFxRefreshPlan({ json: true, dryRun: true, database: 'jay' });
  assert.equal(plan.sourceTableMutation, false);
  assert.equal(plan.statements.includes('refresh_materialized_view_concurrently'), true);

  return {
    ok: true,
    smoke: 'luna-trades-usd-normalization',
    fxRates: 'ready',
    materializedView: 'read_only_ready',
    fxRefresh: 'scheduled_runtime_ready',
    dailyPnlReport: 'telegram_dry_run_ready',
  };
}

async function main() {
  const result = await runLunaTradesUsdNormalizationSmoke();
  console.log(JSON.stringify(result, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: 'luna trades usd normalization smoke failed:',
  });
}
