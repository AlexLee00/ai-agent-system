#!/usr/bin/env node
// @ts-nocheck

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { query, run } from '../shared/db.ts';
import {
  OpenDartClient,
  extractOpenDartFinancialRows,
  normalizeOpenDartFinancialRow,
} from '../lib/korea-data/opendart-client.ts';
import {
  calculateCorpFundamental,
  scoreCorpFundamental,
} from '../lib/korea-data/corp-fundamental.ts';

const MIGRATIONS = [
  'migrations/20260523000001_corp_fundamentals.sql',
  'migrations/20260523000003_corp_financial_reports.sql',
  'migrations/20260523000004_korean_factor_log.sql',
];
const __dirname = dirname(fileURLToPath(import.meta.url));
const INVESTMENT_ROOT = resolve(__dirname, '..');

export function openDartFinancialRowKey(row = {}) {
  return [
    row.fsDiv,
    row.sjDiv,
    row.accountId,
    row.accountName,
    row.accountDetail,
    row.ordinal,
  ].map((value) => String(value ?? '').trim()).join('|');
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function ensureSchema(runFn = run) {
  for (const file of MIGRATIONS) {
    const sql = readFileSync(resolve(INVESTMENT_ROOT, file), 'utf8');
    for (const statement of sql.split(/;\s*(?:\n|$)/u).map((part) => part.trim()).filter(Boolean)) {
      await Promise.resolve(runFn(statement));
    }
  }
  if (runFn === run) await ensureFinancialReportsRowKeyPrimaryKey(runFn);
}

async function ensureFinancialReportsRowKeyPrimaryKey(runFn = run) {
  const rows = await query(
    `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
        AND tc.table_name = kcu.table_name
      WHERE tc.table_schema='investment'
        AND tc.table_name='corp_financial_reports'
        AND tc.constraint_type='PRIMARY KEY'
      ORDER BY kcu.ordinal_position`,
  ).catch(() => []);
  const columns = rows.map((row) => row.column_name).join(',');
  if (columns === 'corp_code,bsns_year,reprt_code,row_key') return;
  await Promise.resolve(runFn('ALTER TABLE investment.corp_financial_reports DROP CONSTRAINT IF EXISTS corp_financial_reports_pkey'));
  await Promise.resolve(runFn(
    `ALTER TABLE investment.corp_financial_reports
       ADD CONSTRAINT corp_financial_reports_pkey
       PRIMARY KEY (corp_code, bsns_year, reprt_code, row_key)`,
  ));
}

function fixtureFinancialRows() {
  const base = { corp_code: '00126380', bsns_year: '2024', reprt_code: '11011', fs_div: 'CFS' };
  return [
    { ...base, sj_div: 'IS', account_id: 'ifrs-full_Revenue', account_nm: '매출액', thstrm_amount: '300870903000000', frmtrm_amount: '258935494000000' },
    { ...base, sj_div: 'IS', account_id: 'dart_OperatingIncomeLoss', account_nm: '영업이익', thstrm_amount: '32726076000000', frmtrm_amount: '6566976000000' },
    { ...base, sj_div: 'IS', account_id: 'ifrs-full_ProfitLoss', account_nm: '당기순이익', thstrm_amount: '34451420000000', frmtrm_amount: '15487100000000' },
    { ...base, sj_div: 'BS', account_id: 'ifrs-full_Assets', account_nm: '자산총계', thstrm_amount: '455905980000000', frmtrm_amount: '455905980000000' },
    { ...base, sj_div: 'BS', account_id: 'ifrs-full_Liabilities', account_nm: '부채총계', thstrm_amount: '92228115000000', frmtrm_amount: '92228115000000' },
    { ...base, sj_div: 'BS', account_id: 'ifrs-full_Equity', account_nm: '자본총계', thstrm_amount: '363677865000000', frmtrm_amount: '363677865000000' },
    { ...base, sj_div: 'BS', account_id: 'ifrs-full_CurrentAssets', account_nm: '유동자산', thstrm_amount: '195936557000000', frmtrm_amount: '195936557000000' },
    { ...base, sj_div: 'BS', account_id: 'ifrs-full_CurrentLiabilities', account_nm: '유동부채', thstrm_amount: '77073042000000', frmtrm_amount: '77073042000000' },
  ].map(normalizeOpenDartFinancialRow);
}

function bigintAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

async function insertFinancialRow(row, meta, runFn = run) {
  await Promise.resolve(runFn(
    `INSERT INTO investment.corp_financial_reports
       (corp_code, stock_code, company_name, bsns_year, reprt_code, row_key, fs_div, sj_div,
        account_id, account_nm, account_detail, thstrm_amount, frmtrm_amount,
        bfefrmtrm_amount, ordinal, raw_data, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17)
     ON CONFLICT (corp_code, bsns_year, reprt_code, row_key) DO UPDATE SET
       stock_code = EXCLUDED.stock_code,
       company_name = EXCLUDED.company_name,
       thstrm_amount = EXCLUDED.thstrm_amount,
       frmtrm_amount = EXCLUDED.frmtrm_amount,
       bfefrmtrm_amount = EXCLUDED.bfefrmtrm_amount,
       raw_data = EXCLUDED.raw_data,
       collected_at = NOW()`,
    [
      row.corpCode || meta.corpCode,
      meta.stockCode || null,
      meta.companyName || null,
      row.bsnsYear || meta.bsnsYear,
      row.reprtCode || meta.reprtCode,
      openDartFinancialRowKey(row),
      row.fsDiv || null,
      row.sjDiv || null,
      row.accountId,
      row.accountName,
      row.accountDetail || null,
      bigintAmount(row.currentAmount),
      bigintAmount(row.previousAmount),
      bigintAmount(row.beforePreviousAmount),
      row.ordinal,
      JSON.stringify(row.raw || {}),
      'opendart',
    ],
  ));
}

async function upsertFundamental(fundamental, runFn = run) {
  await Promise.resolve(runFn(
    `INSERT INTO investment.corp_fundamentals
       (stock_code, corp_code, company_name, bsns_year, reprt_code, per, pbr, roe, roa,
        eps, bps, market_cap, listed_shares, debt_ratio, current_ratio,
        operating_margin, net_margin, revenue_growth, operating_income_growth,
        factor_scores, source, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21,NOW())
     ON CONFLICT (stock_code, bsns_year, reprt_code) DO UPDATE SET
       corp_code = EXCLUDED.corp_code,
       company_name = EXCLUDED.company_name,
       per = EXCLUDED.per,
       pbr = EXCLUDED.pbr,
       roe = EXCLUDED.roe,
       roa = EXCLUDED.roa,
       eps = EXCLUDED.eps,
       bps = EXCLUDED.bps,
       market_cap = EXCLUDED.market_cap,
       listed_shares = EXCLUDED.listed_shares,
       debt_ratio = EXCLUDED.debt_ratio,
       current_ratio = EXCLUDED.current_ratio,
       operating_margin = EXCLUDED.operating_margin,
       net_margin = EXCLUDED.net_margin,
       revenue_growth = EXCLUDED.revenue_growth,
       operating_income_growth = EXCLUDED.operating_income_growth,
       factor_scores = EXCLUDED.factor_scores,
       updated_at = NOW()`,
    [
      fundamental.stockCode,
      fundamental.corpCode || null,
      fundamental.companyName || null,
      fundamental.bsnsYear || null,
      fundamental.reprtCode || null,
      fundamental.per,
      fundamental.pbr,
      fundamental.roe,
      fundamental.roa,
      fundamental.eps,
      fundamental.bps,
      fundamental.marketCap,
      fundamental.listedShares,
      fundamental.debtRatio,
      fundamental.currentRatio,
      fundamental.operatingMargin,
      fundamental.netMargin,
      fundamental.revenueGrowth,
      fundamental.operatingIncomeGrowth,
      JSON.stringify(scoreCorpFundamental(fundamental)),
      'opendart',
    ],
  ));
}

export async function runLunaOpenDartFinancialRefresh(options = {}) {
  const fixture = options.fixture === true;
  const write = options.write === true;
  const meta = {
    corpCode: options.corpCode || '00126380',
    stockCode: options.stockCode || '005930',
    companyName: options.companyName || '삼성전자',
    bsnsYear: options.bsnsYear || '2024',
    reprtCode: options.reprtCode || '11011',
    fsDiv: options.fsDiv || 'CFS',
    marketCap: Number(options.marketCap || 0) || null,
    listedShares: Number(options.listedShares || 0) || null,
    price: Number(options.price || 0) || null,
  };
  let rows = [];
  let request = null;
  if (fixture) {
    rows = fixtureFinancialRows();
  } else {
    const client = await OpenDartClient.fromSecrets(options);
    request = await client.singleFinancialStatementAll(meta);
    rows = request.ok ? extractOpenDartFinancialRows(request) : [];
  }
  const fundamental = calculateCorpFundamental({
    ...meta,
    financialRows: rows,
    source: fixture ? 'fixture' : 'opendart',
  });
  const factorScores = scoreCorpFundamental(fundamental);

  if (write) {
    await ensureSchema(options.run || run);
    for (const row of rows) await insertFinancialRow(row, meta, options.run || run);
    if (fundamental.stockCode) await upsertFundamental(fundamental, options.run || run);
  }

  return {
    ok: fixture || Boolean(request?.ok),
    status: rows.length ? 'luna_opendart_financial_refresh_ready' : 'luna_opendart_financial_refresh_empty',
    dryRun: !write,
    shadowOnly: true,
    meta,
    rows: rows.length,
    fundamental,
    factorScores,
    request: request ? { ok: request.ok, endpoint: request.endpoint, dartStatus: request.dartStatus, error: request.error, usage: request.usage } : null,
    writeApplied: write,
  };
}

async function main() {
  const result = await runLunaOpenDartFinancialRefresh({
    fixture: hasFlag('fixture'),
    write: hasFlag('write') && !hasFlag('dry-run'),
    corpCode: argValue('corp-code', '00126380'),
    stockCode: argValue('stock-code', '005930'),
    companyName: argValue('company-name', '삼성전자'),
    bsnsYear: argValue('bsns-year', '2024'),
    reprtCode: argValue('reprt-code', '11011'),
    fsDiv: argValue('fs-div', 'CFS'),
    marketCap: argValue('market-cap', null),
    listedShares: argValue('listed-shares', null),
    price: argValue('price', null),
  });
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`[luna-opendart-financial-refresh] ${result.status} rows=${result.rows} dryRun=${result.dryRun}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'luna-opendart-financial-refresh error:' });
}
