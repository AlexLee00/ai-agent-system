#!/usr/bin/env node
// @ts-nocheck
/**
 * Luna FX refresh runtime.
 *
 * Applies the USD normalization DDL, carries latest FX rates to today, then
 * refreshes the read-only materialized PnL view. It does not mutate trade
 * source tables.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const INVESTMENT_ROOT = path.resolve(import.meta.dirname, '..');
const FX_MIGRATION = path.join(INVESTMENT_ROOT, 'migrations/20260512_fx_rates.sql');
const VIEW_MIGRATION = path.join(INVESTMENT_ROOT, 'migrations/20260512_v_trades_real_usd.sql');

function parseArgs(argv = process.argv.slice(2)) {
  return {
    json: argv.includes('--json'),
    dryRun: argv.includes('--dry-run') || argv.includes('--no-exec'),
    database: (argv.find((arg) => arg.startsWith('--database=')) || '').slice('--database='.length)
      || process.env.PGDATABASE
      || 'jay',
  };
}

function runPsql(args, { database }) {
  return execFileSync('psql', ['-d', database, '-v', 'ON_ERROR_STOP=1', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function carryForwardFxSql() {
  return `
    INSERT INTO investment.fx_rates
      (base_currency, quote_currency, rate, inverse_rate, source, effective_date)
    SELECT base_currency, quote_currency, rate, inverse_rate, 'carry_forward', CURRENT_DATE
    FROM (
      SELECT DISTINCT ON (base_currency, quote_currency)
        base_currency, quote_currency, rate, inverse_rate
      FROM investment.fx_rates
      WHERE quote_currency = 'USD'
      ORDER BY base_currency, quote_currency, effective_date DESC
    ) latest
    ON CONFLICT DO NOTHING
  `;
}

export function buildLunaFxRefreshPlan(options = parseArgs()) {
  return {
    ok: true,
    status: options.dryRun ? 'luna_fx_refresh_planned' : 'luna_fx_refresh_ready',
    database: options.database,
    dryRun: options.dryRun,
    sourceTableMutation: false,
    migrations: [FX_MIGRATION, VIEW_MIGRATION],
    statements: [
      'apply_fx_rates_migration',
      'apply_v_trades_real_usd_migration',
      'carry_forward_latest_fx_rates_to_current_date',
      'refresh_materialized_view_concurrently',
    ],
  };
}

export async function runLunaFxRefresh(options = parseArgs()) {
  const plan = buildLunaFxRefreshPlan(options);
  if (options.dryRun) return plan;

  const outputs = [];
  outputs.push(runPsql(['-f', FX_MIGRATION], options));
  outputs.push(runPsql(['-f', VIEW_MIGRATION], options));
  outputs.push(runPsql(['-c', carryForwardFxSql()], options));
  outputs.push(runPsql(['-c', 'REFRESH MATERIALIZED VIEW CONCURRENTLY investment.v_trades_real_usd'], options));

  return {
    ...plan,
    status: 'luna_fx_refresh_complete',
    refreshed: true,
    outputBytes: outputs.reduce((sum, text) => sum + String(text || '').length, 0),
    refreshedAt: new Date().toISOString(),
  };
}

async function main() {
  const options = parseArgs();
  const result = await runLunaFxRefresh(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`${result.status} dryRun=${result.dryRun === true} sourceTableMutation=${result.sourceTableMutation === true}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: 'luna fx refresh failed:',
  });
}

export default { buildLunaFxRefreshPlan, runLunaFxRefresh };
