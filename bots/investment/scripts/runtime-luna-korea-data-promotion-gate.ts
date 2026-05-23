#!/usr/bin/env node
// @ts-nocheck

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildKoreaDataPromotionGate } from '../shared/korea-data-promotion-gate.ts';
import { calculateKoreanWorldQuantAlphas } from '../shared/worldquant-101-korean.ts';
import { resolveOpenDartCredentialStatus } from '../lib/korea-data/opendart-client.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INVESTMENT_ROOT = resolve(__dirname, '..');
const DEFAULT_OUTPUT = resolve(INVESTMENT_ROOT, 'output/luna-korea-data-promotion-gate.json');

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function safeCount(sql) {
  const row = await get(sql).catch((error) => ({ error: String(error?.message || error) }));
  if (row?.error) {
    return {
      count: 0,
      error: row.error,
      tableMissing: /does not exist|relation .* does not exist/i.test(row.error),
    };
  }
  return { count: Number(row?.count || 0), error: null, tableMissing: false };
}

async function safeBacktestMetrics() {
  const row = await get(
    `SELECT COUNT(*)::int AS rows,
            COUNT(*) FILTER (WHERE fresh = true)::int AS fresh,
            COUNT(*) FILTER (WHERE healthy = true)::int AS healthy,
            COUNT(*) FILTER (WHERE gate_status = 'pass')::int AS pass
       FROM candidate_backtest_status
      WHERE market = 'domestic'
        AND updated_at >= NOW() - INTERVAL '7 days'`,
  ).catch((error) => ({ error: String(error?.message || error) }));
  if (row?.error) {
    return {
      rows: { count: 0, error: row.error, tableMissing: /does not exist|relation .* does not exist/i.test(row.error) },
      fresh: 0,
      healthy: 0,
      pass: 0,
    };
  }
  return {
    rows: { count: Number(row?.rows || 0), error: null, tableMissing: false },
    fresh: Number(row?.fresh || 0),
    healthy: Number(row?.healthy || 0),
    pass: Number(row?.pass || 0),
  };
}

function sampleBars() {
  return Array.from({ length: 40 }, (_, index) => {
    const base = 100 + index * 0.9 + Math.sin(index / 4) * 1.4;
    return {
      open: base - 0.3,
      high: base + 1.2,
      low: base - 1.1,
      close: base + 0.4,
      volume: 120000 + index * 4200,
    };
  });
}

function worldquantAlphaCount() {
  const result = calculateKoreanWorldQuantAlphas({
    bars: sampleBars(),
    factors: { hml: 0.6, quality: 0.7 },
  });
  return Object.keys(result.alphas || {}).length;
}

function dartFssAvailable() {
  const script = resolve(INVESTMENT_ROOT, 'python/korea-data/opendart_client.py');
  if (!existsSync(script)) return false;
  const python = spawnSync('python3', [script, '--doctor', '--json'], {
    cwd: INVESTMENT_ROOT,
    encoding: 'utf8',
  });
  try {
    const parsed = JSON.parse(python.stdout || '{}');
    return Boolean(parsed.dartFssAvailable);
  } catch {
    return false;
  }
}

function outputFileFresh(file, maxAgeMs = 7 * 24 * 3600 * 1000) {
  if (!existsSync(file)) return false;
  try {
    const payload = JSON.parse(readFileSync(file, 'utf8'));
    const generatedAt = payload.generatedAt
      || payload.result?.output?.generatedAt
      || payload.result?.metadata?.generatedAt
      || payload.snapshot?.generatedAt
      || null;
    if (!generatedAt) return true;
    const age = Date.now() - new Date(generatedAt).getTime();
    return Number.isFinite(age) ? age <= maxAgeMs : true;
  } catch {
    return false;
  }
}

function outputReportUsable(file) {
  if (!outputFileFresh(file)) return false;
  try {
    const payload = JSON.parse(readFileSync(file, 'utf8'));
    const output = payload.result?.output || payload.output || {};
    if (output.dataHealth && output.dataHealth !== 'shadow_ready') return false;
    if (Array.isArray(output.recommendations)) return output.recommendations.length > 0;
    if (Array.isArray(output.events)) return output.events.length > 0;
    const recommendation = output.recommendation;
    if (recommendation) return Boolean(recommendation.stockCode || recommendation.companyName);
    const snapshotRows = payload.snapshot?.rows;
    if (Array.isArray(snapshotRows)) return snapshotRows.length > 0;
    return Boolean(payload.ok && payload.status && !String(payload.status).includes('empty'));
  } catch {
    return false;
  }
}

function strategyShadowSignalsFromReports() {
  const files = [
    'output/luna-fundamental-quant-shadow.json',
    'output/luna-earnings-surprise-shadow.json',
    'output/luna-disclosure-event-shadow.json',
  ].map((file) => resolve(INVESTMENT_ROOT, file));
  return files.filter((file) => outputReportUsable(file)).length;
}

async function loadDbMetrics() {
  const [secretStatus, financialReports, fundamentals, freshFundamentals, disclosuresToday, factorRows, shadowDays, strategySignals] = await Promise.all([
    resolveOpenDartCredentialStatus({ timeoutMs: 3000 }).catch(() => ({ configured: false, apiKeySource: null })),
    safeCount('SELECT COUNT(*)::int AS count FROM investment.corp_financial_reports'),
    safeCount('SELECT COUNT(DISTINCT stock_code)::int AS count FROM investment.corp_fundamentals'),
    safeCount(`SELECT COUNT(DISTINCT stock_code)::int AS count FROM investment.corp_fundamentals WHERE updated_at >= NOW() - INTERVAL '24 hours'`),
    safeCount('SELECT COUNT(*)::int AS count FROM investment.corp_disclosures WHERE rcept_dt = CURRENT_DATE'),
    safeCount(`SELECT COUNT(*)::int AS count FROM investment.korean_factor_log WHERE created_at >= NOW() - INTERVAL '7 days'`),
    safeCount(`SELECT COUNT(DISTINCT observed_day)::int AS count
                 FROM (
                   SELECT updated_at::date AS observed_day FROM investment.corp_fundamentals
                   UNION ALL
                   SELECT calculation_date AS observed_day FROM investment.korean_factor_log
                 ) days`),
    safeCount(`SELECT COUNT(*)::int AS count
                 FROM investment.korea_public_data_shadow_signals
                WHERE observed_at >= NOW() - INTERVAL '7 days'
                  AND shadow_only = true
                  AND live_order_allowed = false`),
  ]);
  const backtest = await safeBacktestMetrics();
  const reportSignalCount = strategyShadowSignalsFromReports();
  const strategySignalCount = strategySignals.tableMissing
    ? reportSignalCount
    : Math.max(Number(strategySignals.count || 0), reportSignalCount);
  return {
    openDartConfigured: secretStatus.configured,
    openDartSource: secretStatus.apiKeySource,
    dartFssAvailable: dartFssAvailable(),
    corpFinancialReports: financialReports,
    corpFundamentals: fundamentals,
    freshCorpFundamentals24h: freshFundamentals,
    disclosuresToday,
    koreanFactorRows7d: factorRows,
    domesticBacktestRows7d: backtest.rows,
    domesticBacktestFreshRows7d: backtest.fresh,
    domesticBacktestHealthyRows7d: backtest.healthy,
    domesticBacktestPassRows7d: backtest.pass,
    shadowObservationDays: shadowDays,
    strategyShadowSignals7d: strategySignalCount,
    worldquantAlphaCount: worldquantAlphaCount(),
  };
}

function fixtureMetrics() {
  return {
    openDartConfigured: true,
    openDartSource: 'fixture',
    dartFssAvailable: true,
    corpFinancialReports: 1200,
    corpFundamentals: 240,
    freshCorpFundamentals24h: 220,
    disclosuresToday: 120,
    koreanFactorRows7d: 1400,
    domesticBacktestRows7d: 30,
    domesticBacktestFreshRows7d: 28,
    domesticBacktestHealthyRows7d: 24,
    domesticBacktestPassRows7d: 22,
    shadowObservationDays: 8,
    strategyShadowSignals7d: 18,
    worldquantAlphaCount: 20,
  };
}

function thresholdsFromArgs() {
  const mapping = {
    minFinancialReportRows: 'min-financial-rows',
    minCorpFundamentalRows: 'min-fundamental-rows',
    minFreshCorpFundamentalRows24h: 'min-fresh-fundamental-rows',
    minDisclosuresToday: 'min-disclosures-today',
    minKoreanFactorRows7d: 'min-factor-rows',
    minDomesticBacktestRows7d: 'min-backtest-rows',
    minDomesticBacktestFreshRows7d: 'min-fresh-backtest-rows',
    minDomesticBacktestHealthyRows7d: 'min-healthy-backtest-rows',
    minDomesticBacktestPassRate7d: 'min-backtest-pass-rate',
    minShadowObservationDays: 'min-shadow-days',
    minStrategyShadowSignals7d: 'min-strategy-signals',
    minWorldquantAlphaCount: 'min-worldquant-alphas',
  };
  return Object.fromEntries(
    Object.entries(mapping)
      .map(([key, flag]) => [key, argValue(flag, null)])
      .filter(([, value]) => value != null),
  );
}

export async function runLunaKoreaDataPromotionGate(options = {}) {
  const metrics = options.fixture ? fixtureMetrics() : await loadDbMetrics();
  const gate = buildKoreaDataPromotionGate(metrics, {
    thresholds: options.thresholds || {},
  });
  const payload = {
    ...gate,
    fixture: options.fixture === true,
    writeMode: options.writeReport === false ? 'no-write' : 'report-artifact-only',
    output: options.output || DEFAULT_OUTPUT,
  };
  if (options.writeReport !== false) {
    mkdirSync(dirname(options.output || DEFAULT_OUTPUT), { recursive: true });
    writeFileSync(options.output || DEFAULT_OUTPUT, JSON.stringify(payload, null, 2));
  }
  return payload;
}

async function main() {
  const result = await runLunaKoreaDataPromotionGate({
    fixture: hasFlag('fixture'),
    thresholds: thresholdsFromArgs(),
    output: argValue('output', DEFAULT_OUTPUT),
    writeReport: !hasFlag('no-write'),
  });
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`[luna-korea-data-promotion-gate] ${result.status}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'luna-korea-data-promotion-gate error:' });
}
