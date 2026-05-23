#!/usr/bin/env node
// @ts-nocheck

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get, query, run } from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildKoreanFactorSnapshot } from '../shared/korean-factor-model.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INVESTMENT_ROOT = resolve(__dirname, '..');
const DEFAULT_OUTPUT = resolve(INVESTMENT_ROOT, 'output/luna-korean-factor-refresh.json');
const MIGRATION = resolve(INVESTMENT_ROOT, 'migrations/20260523000004_korean_factor_log.sql');

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function ensureSchema(runFn = run) {
  const sql = readFileSync(MIGRATION, 'utf8');
  for (const statement of sql.split(/;\s*(?:\n|$)/u).map((part) => part.trim()).filter(Boolean)) {
    await Promise.resolve(runFn(statement));
  }
}

async function loadFundamentals(limit = 300) {
  return query(
    `SELECT stock_code AS "stockCode",
            company_name AS "companyName",
            market_cap AS "marketCap",
            per, pbr, roe, roa,
            debt_ratio AS "debtRatio",
            revenue_growth AS "revenueGrowth",
            updated_at AS "updatedAt"
       FROM investment.corp_fundamentals
      ORDER BY updated_at DESC
      LIMIT $1`,
    [Math.max(1, Number(limit || 300))],
  ).catch(() => []);
}

async function insertFactorRows(snapshot, runFn = run) {
  for (const row of snapshot.rows || []) {
    for (const [name, value] of Object.entries(row.factors || {})) {
      await Promise.resolve(runFn(
        `INSERT INTO investment.korean_factor_log
           (stock_code, company_name, factor_name, factor_value, rank, decile, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [row.stockCode, row.companyName, name, value, row.rank, row.decile, JSON.stringify({ composite: row.composite, allocationHint: row.allocationHint })],
      ));
    }
  }
}

export async function runLunaKoreanFactorRefresh(options = {}) {
  const rows = options.fixture ? [
    { stockCode: '005930', companyName: '삼성전자', marketCap: 1000, pbr: 1.1, roe: 0.18, revenueGrowth: 0.12, momentum: 0.08 },
    { stockCode: '000660', companyName: 'SK하이닉스', marketCap: 800, pbr: 1.6, roe: 0.22, revenueGrowth: 0.2, momentum: 0.12 },
    { stockCode: '005380', companyName: '현대차', marketCap: 500, pbr: 0.7, roe: 0.12, revenueGrowth: 0.05, momentum: 0.03 },
  ] : await loadFundamentals(options.limit || 300);
  const snapshot = buildKoreanFactorSnapshot(rows, { top: 20, bottom: 20 });
  if (options.write === true) {
    await ensureSchema(options.run || run);
    await insertFactorRows(snapshot, options.run || run);
  }
  const payload = {
    ok: snapshot.ok,
    status: snapshot.ok ? 'luna_korean_factor_refresh_ready' : 'luna_korean_factor_refresh_empty',
    dryRun: options.write !== true,
    shadowOnly: true,
    liveOrderAllowed: false,
    snapshot,
    counts: {
      sourceRows: rows.length,
      top: snapshot.top?.length || 0,
      bottom: snapshot.bottom?.length || 0,
    },
  };
  if (options.writeReport !== false) {
    mkdirSync(dirname(options.output || DEFAULT_OUTPUT), { recursive: true });
    writeFileSync(options.output || DEFAULT_OUTPUT, JSON.stringify(payload, null, 2));
  }
  return payload;
}

async function main() {
  const result = await runLunaKoreanFactorRefresh({
    fixture: hasFlag('fixture'),
    write: hasFlag('write') && !hasFlag('dry-run'),
    limit: Number(argValue('limit', 300)),
    output: argValue('output', DEFAULT_OUTPUT),
    writeReport: !hasFlag('no-write'),
  });
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`[luna-korean-factor-refresh] ${result.status}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'luna-korean-factor-refresh error:' });
}
