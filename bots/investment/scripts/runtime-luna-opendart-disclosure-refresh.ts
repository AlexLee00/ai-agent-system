#!/usr/bin/env node
// @ts-nocheck

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { run } from '../shared/db.ts';
import {
  OpenDartClient,
  addDaysYyyymmdd,
  extractOpenDartList,
  normalizeOpenDartDisclosure,
} from '../lib/korea-data/opendart-client.ts';

const MIGRATIONS = [
  'migrations/20260523000002_corp_disclosures.sql',
];
const __dirname = dirname(fileURLToPath(import.meta.url));
const INVESTMENT_ROOT = resolve(__dirname, '..');

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function yyyymmddKst(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
  return formatter.format(date).replace(/-/g, '');
}

async function ensureSchema(runFn = run) {
  for (const file of MIGRATIONS) {
    const sql = readFileSync(resolve(INVESTMENT_ROOT, file), 'utf8');
    for (const statement of sql.split(/;\s*(?:\n|$)/u).map((part) => part.trim()).filter(Boolean)) {
      await Promise.resolve(runFn(statement));
    }
  }
}

function fixtureDisclosures() {
  return [
    normalizeOpenDartDisclosure({
      corp_code: '00126380',
      corp_name: '삼성전자',
      stock_code: '005930',
      corp_cls: 'Y',
      report_nm: '영업(잠정)실적(공정공시)',
      rcept_no: '20260523000001',
      rcept_dt: '20260523',
      flr_nm: '삼성전자',
    }),
    normalizeOpenDartDisclosure({
      corp_code: '00164779',
      corp_name: '현대차',
      stock_code: '005380',
      corp_cls: 'Y',
      report_nm: '자기주식취득결정',
      rcept_no: '20260523000002',
      rcept_dt: '20260523',
      flr_nm: '현대차',
    }),
  ];
}

async function insertDisclosure(row, runFn = run) {
  await Promise.resolve(runFn(
    `INSERT INTO investment.corp_disclosures
       (corp_code, stock_code, company_name, corp_cls, rcept_no, rcept_dt, submission_dt,
        report_nm, report_type, importance_score, keywords, raw_data, source)
     VALUES ($1,$2,$3,$4,$5,$6::date,NOW(),$7,$8,$9,$10::jsonb,$11::jsonb,$12)
     ON CONFLICT (rcept_no) DO UPDATE SET
       report_nm = EXCLUDED.report_nm,
       report_type = EXCLUDED.report_type,
       importance_score = EXCLUDED.importance_score,
       keywords = EXCLUDED.keywords,
       raw_data = EXCLUDED.raw_data,
       collected_at = NOW()`,
    [
      row.corpCode,
      row.stockCode || null,
      row.corpName || null,
      row.corpCls || null,
      row.receiptNo,
      row.receiptDate || null,
      row.reportName,
      row.reportType,
      row.importanceScore,
      JSON.stringify(row.keywords || []),
      JSON.stringify(row.raw || {}),
      'opendart',
    ],
  ));
}

export async function runLunaOpenDartDisclosureRefresh(options = {}) {
  const fixture = options.fixture === true;
  const write = options.write === true;
  const endDe = options.endDe || yyyymmddKst();
  const bgnDe = options.bgnDe || addDaysYyyymmdd(endDe, -1);
  let rows = [];
  let source = 'fixture';
  let request = null;
  if (fixture) {
    rows = fixtureDisclosures();
  } else {
    const client = await OpenDartClient.fromSecrets(options);
    request = await client.listDisclosures({
      bgnDe,
      endDe,
      pageNo: options.pageNo || 1,
      pageCount: options.pageCount || 100,
      timeoutMs: options.timeoutMs,
    });
    rows = request.ok ? extractOpenDartList(request) : [];
    source = 'opendart_api';
  }

  if (write) {
    await ensureSchema(options.run || run);
    for (const row of rows) await insertDisclosure(row, options.run || run);
  }

  return {
    ok: fixture || Boolean(request?.ok),
    status: rows.length ? 'luna_opendart_disclosure_refresh_ready' : 'luna_opendart_disclosure_refresh_empty',
    dryRun: !write,
    shadowOnly: true,
    source,
    window: { bgnDe, endDe },
    rows: rows.length,
    highImportance: rows.filter((row) => row.importanceScore >= 7).length,
    top: rows.slice(0, Number(options.limit || 20)),
    request: request ? { ok: request.ok, endpoint: request.endpoint, dartStatus: request.dartStatus, error: request.error, usage: request.usage } : null,
    llmPolicy: {
      hubGatewayRequiredForPromotion: true,
      deterministicFallbackUsed: true,
      liveTradeImpact: false,
    },
    writeApplied: write,
  };
}

async function main() {
  const result = await runLunaOpenDartDisclosureRefresh({
    fixture: hasFlag('fixture'),
    write: hasFlag('write') && !hasFlag('dry-run'),
    bgnDe: argValue('bgn-de', null),
    endDe: argValue('end-de', null),
    pageNo: Number(argValue('page-no', 1)),
    pageCount: Number(argValue('page-count', 100)),
    limit: Number(argValue('limit', 20)),
  });
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`[luna-opendart-disclosure-refresh] ${result.status} rows=${result.rows} dryRun=${result.dryRun}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'luna-opendart-disclosure-refresh error:' });
}
