#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  normalizeOpenDartDisclosure,
  normalizeOpenDartFinancialRow,
  resolveOpenDartApiKeyFromSources,
} from '../lib/korea-data/opendart-client.ts';
import {
  calculateCorpFundamental,
  rankCorpFundamentals,
  buildFundamentalQuantRecommendation,
  buildEarningsSurpriseRecommendation,
} from '../lib/korea-data/corp-fundamental.ts';
import { buildKoreanFactorSnapshot } from '../shared/korean-factor-model.ts';
import { calculateKoreanWorldQuantAlphas } from '../shared/worldquant-101-korean.ts';
import { runLunaOpenDartDisclosureRefresh } from './runtime-luna-opendart-disclosure-refresh.ts';
import { runLunaOpenDartFinancialBatchRefresh } from './runtime-luna-opendart-financial-batch-refresh.ts';
import { runLunaOpenDartFinancialRefresh } from './runtime-luna-opendart-financial-refresh.ts';
import { runLunaEarningsSurpriseTrading } from './runtime-luna-earnings-surprise-trading.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INVESTMENT_ROOT = resolve(__dirname, '..');

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function sampleBars() {
  return Array.from({ length: 30 }, (_, index) => {
    const base = 100 + index * 1.2;
    return { open: base - 0.4, high: base + 1.8, low: base - 1.1, close: base + (index % 4) * 0.3, volume: 100000 + index * 5000 };
  });
}

export async function runLunaKoreaDataSmoke() {
  const migrations = [
    '20260523000001_corp_fundamentals.sql',
    '20260523000002_corp_disclosures.sql',
    '20260523000003_corp_financial_reports.sql',
    '20260523000004_korean_factor_log.sql',
    '20260523000005_korea_public_data_shadow_signals.sql',
  ];
  for (const migration of migrations) {
    const file = resolve(INVESTMENT_ROOT, 'migrations', migration);
    assert.equal(existsSync(file), true, `migration exists ${migration}`);
    assert.match(readFileSync(file, 'utf8'), /CREATE TABLE IF NOT EXISTS investment\./u);
  }

  const disclosure = normalizeOpenDartDisclosure({
    corp_code: '00126380',
    corp_name: '삼성전자',
    stock_code: '005930',
    report_nm: '유상증자결정',
    rcept_no: '20260523000003',
    rcept_dt: '20260523',
  });
  assert.equal(disclosure.reportType, 'dilution');
  assert.ok(disclosure.importanceScore >= 8);

  const financialRows = [
    ['ifrs-full_Revenue', '매출액', 1000],
    ['dart_OperatingIncomeLoss', '영업이익', 160],
    ['ifrs-full_ProfitLoss', '당기순이익', 120],
    ['ifrs-full_Assets', '자산총계', 2200],
    ['ifrs-full_Liabilities', '부채총계', 800],
    ['ifrs-full_Equity', '자본총계', 1400],
    ['ifrs-full_CurrentAssets', '유동자산', 900],
    ['ifrs-full_CurrentLiabilities', '유동부채', 450],
  ].map(([account_id, account_nm, thstrm_amount]) => normalizeOpenDartFinancialRow({
    corp_code: '00126380',
    bsns_year: '2024',
    reprt_code: '11011',
    account_id,
    account_nm,
    thstrm_amount,
  }));
  const fundamental = calculateCorpFundamental({
    stockCode: '005930',
    corpCode: '00126380',
    companyName: '삼성전자',
    financialRows,
    marketCap: 1800,
    listedShares: 10,
    price: 180,
    previousFinancial: { revenue: 900, operatingIncome: 100 },
  });
  assert.equal(fundamental.roe, 0.085714);
  assert.equal(fundamental.currentRatio, 2);
  const ranked = rankCorpFundamentals([
    fundamental,
    { ...fundamental, stockCode: '000660', companyName: 'SK하이닉스', roe: 0.22, per: 8, pbr: 1.1, debtRatio: 0.5, revenueGrowth: 0.4 },
  ]);
  assert.equal(ranked[0].rank, 1);
  assert.equal(buildFundamentalQuantRecommendation(ranked[0]).shadowOnly, true);
  assert.equal(buildEarningsSurpriseRecommendation(fundamental, { revenue: 900, operatingIncome: 100 }).action, 'positive_surprise_watchlist');

  const factor = buildKoreanFactorSnapshot(ranked);
  assert.equal(factor.ok, true);
  assert.equal(factor.factorNames.includes('HML'), true);

  const worldquant = calculateKoreanWorldQuantAlphas({ bars: sampleBars(), factors: factor.top[0].factors });
  assert.equal(worldquant.ok, true);
  assert.equal(Object.keys(worldquant.alphas).length, 20);

  const dartApiKeyField = ['dart', 'api', 'key'].join('_');
  const configNewsCredential = resolveOpenDartApiKeyFromSources({
    config: { news: { [dartApiKeyField]: 'fixture-opendart-token' } },
  });
  assert.equal(configNewsCredential.source, 'hub:config.news.dart_api_key');

  const directNewsCredential = resolveOpenDartApiKeyFromSources({
    news: { [dartApiKeyField]: 'fixture-opendart-token' },
  });
  assert.equal(directNewsCredential.source, 'hub:news.dart_api_key');

  const disclosureRuntime = await runLunaOpenDartDisclosureRefresh({ fixture: true });
  assert.equal(disclosureRuntime.dryRun, true);
  assert.equal(disclosureRuntime.rows, 2);
  const financialRuntime = await runLunaOpenDartFinancialRefresh({ fixture: true });
  assert.equal(financialRuntime.dryRun, true);
  assert.ok(financialRuntime.factorScores.composite > 0);
  const financialBatchRuntime = await runLunaOpenDartFinancialBatchRefresh({
    fixture: true,
    limit: 2,
    writeReport: false,
  });
  assert.equal(financialBatchRuntime.dryRun, true);
  assert.equal(financialBatchRuntime.counts.readyToFetch, 2);
  assert.equal(financialBatchRuntime.counts.refreshed, 2);
  assert.ok(financialBatchRuntime.counts.rows >= 16);
  const earningsRuntime = await runLunaEarningsSurpriseTrading({ fixture: true, writeReport: false });
  assert.equal(earningsRuntime.result.output.recommendation.action, 'positive_surprise_watchlist');

  return {
    ok: true,
    smoke: 'luna-korea-data',
    migrations: migrations.length,
    disclosureRows: disclosureRuntime.rows,
    financialRows: financialRuntime.rows,
    financialBatchRows: financialBatchRuntime.counts.rows,
    earningsAction: earningsRuntime.result.output.recommendation.action,
    worldquantAlphas: Object.keys(worldquant.alphas).length,
    shadowOnly: true,
  };
}

async function main() {
  const result = await runLunaKoreaDataSmoke();
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna-korea-data-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'luna-korea-data-smoke error:' });
}
