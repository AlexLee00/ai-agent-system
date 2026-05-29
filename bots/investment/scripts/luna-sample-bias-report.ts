#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function argValue(name: string, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function boolEnv(name: string, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on', 'active'].includes(String(raw).trim().toLowerCase());
}

function normalizeKey(value: any, fallback = 'unknown') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function countBy(rows: any[] = [], selector: any = () => 'unknown') {
  return rows.reduce((acc, row) => {
    const key = normalizeKey(selector(row));
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function toSortedEntries(counts: any = {}) {
  return Object.entries(counts)
    .map(([key, count]) => ({ key, count: Number(count || 0) }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function findUnderSampled(counts: any = {}, minSamples = 3, dimension = 'unknown') {
  return toSortedEntries(counts)
    .filter((entry) => entry.count < minSamples)
    .map((entry) => ({ dimension, ...entry, minSamples }));
}

function fixtureRows(now = Date.now()) {
  return [
    { symbol: 'BTC/USDT', market: 'crypto', exchange: 'binance', market_regime: 'trending_bull', strategy_family: 'trend', is_paper: false, trade_mode: 'normal', status: 'closed', entry_time: now - 1000 },
    { symbol: 'ETH/USDT', market: 'crypto', exchange: 'binance', market_regime: 'ranging', strategy_family: 'mean_reversion', is_paper: true, trade_mode: 'paper_data', status: 'open', entry_time: now - 2000 },
    { symbol: 'SOL/USDT', market: 'crypto', exchange: 'binance', market_regime: 'volatile', strategy_family: 'breakout', is_paper: true, trade_mode: 'paper_data', status: 'closed', entry_time: now - 3000 },
    { symbol: '005930', market: 'domestic_stock', exchange: 'kis', market_regime: 'trending_bull', strategy_family: 'fundamental', is_paper: false, trade_mode: 'normal', status: 'closed', entry_time: now - 4000 },
  ];
}

export function buildSampleBiasReport(rows: any[] = [], {
  universeDistinctSymbols = null,
  minSamples = 3,
  days = 14,
  generatedAt = new Date().toISOString(),
} = {}) {
  const total = rows.length;
  const liveRows = rows.filter((row) => row.is_paper !== true);
  const paperRows = rows.filter((row) => row.is_paper === true);
  const distinctSymbols = new Set(rows.map((row) => normalizeKey(row.symbol, '')).filter(Boolean)).size;
  const coverageRatio = universeDistinctSymbols > 0
    ? Number((distinctSymbols / universeDistinctSymbols).toFixed(4))
    : null;

  const bySymbol = countBy(rows, (row) => row.symbol);
  const byMarket = countBy(rows, (row) => row.market || row.exchange);
  const byRegime = countBy(rows, (row) => row.market_regime || row.regime);
  const byStrategy = countBy(rows, (row) => row.strategy_family);
  const byMode = countBy(rows, (row) => row.is_paper === true ? 'paper' : 'live');
  const byStatus = countBy(rows, (row) => row.status);
  const byRegimeStrategy = countBy(rows, (row) => `${normalizeKey(row.market_regime || row.regime)}::${normalizeKey(row.strategy_family)}`);

  const underSampled = [
    ...findUnderSampled(byRegime, minSamples, 'market_regime'),
    ...findUnderSampled(byStrategy, minSamples, 'strategy_family'),
    ...findUnderSampled(byRegimeStrategy, minSamples, 'regime_strategy'),
  ].sort((a, b) => a.count - b.count || a.dimension.localeCompare(b.dimension) || a.key.localeCompare(b.key));

  return {
    ok: true,
    status: 'luna_sample_bias_report_ready',
    generatedAt,
    lookbackDays: days,
    minSamples,
    summary: {
      totalTrades: total,
      liveTrades: liveRows.length,
      paperTrades: paperRows.length,
      paperRatio: total > 0 ? Number((paperRows.length / total).toFixed(4)) : 0,
      distinctSymbols,
      universeDistinctSymbols,
      symbolCoverageRatio: coverageRatio,
      underSampledCount: underSampled.length,
    },
    distributions: {
      byMode: toSortedEntries(byMode),
      byStatus: toSortedEntries(byStatus),
      byMarket: toSortedEntries(byMarket),
      byRegime: toSortedEntries(byRegime),
      byStrategy: toSortedEntries(byStrategy),
      byRegimeStrategy: toSortedEntries(byRegimeStrategy),
      topSymbols: toSortedEntries(bySymbol).slice(0, 25),
    },
    underSampled,
    diversityInputs: {
      preferredUnderSampledSymbols: toSortedEntries(bySymbol)
        .filter((entry) => entry.count < minSamples)
        .slice(0, 25)
        .map((entry) => entry.key),
      preferredRegimes: underSampled
        .filter((entry) => entry.dimension === 'market_regime')
        .map((entry) => entry.key),
      preferredStrategies: underSampled
        .filter((entry) => entry.dimension === 'strategy_family')
        .map((entry) => entry.key),
    },
  };
}

async function loadTradeRows({ days = 14, limit = 5000 } = {}) {
  const sinceMs = Date.now() - (Number(days) * 24 * 60 * 60 * 1000);
  return db.query(
    `SELECT symbol, market, exchange, market_regime, strategy_family,
            is_paper, trade_mode, status, entry_time, pnl_net
       FROM investment.trade_journal
      WHERE entry_time >= ?
      ORDER BY entry_time DESC
      LIMIT ?`,
    [sinceMs, limit],
  );
}

async function loadUniverseDistinctSymbols() {
  const row = await db.get(
    `SELECT COUNT(DISTINCT symbol)::int AS count
       FROM investment.candidate_universe
      WHERE expires_at > NOW()`,
  ).catch(() => null);
  return row?.count == null ? null : Number(row.count);
}

async function writeGuardEvent(report: any = {}) {
  await db.run(
    `INSERT INTO investment.guard_events
       (guard_name, symbol, exchange, market, reason, severity,
        decision_before, decision_after, trade_id, guard_metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?::jsonb)`,
    [
      'luna_sample_bias_report',
      null,
      null,
      'all',
      `sample_bias under_sampled=${report.summary?.underSampledCount ?? 0}`,
      report.summary?.underSampledCount > 0 ? 'info' : 'info',
      null,
      JSON.stringify(report.summary || {}),
      null,
      JSON.stringify({
        lookbackDays: report.lookbackDays,
        distributions: report.distributions,
        underSampled: report.underSampled,
      }),
    ],
  );
}

export async function runLunaSampleBiasReport(options: any = {}) {
  const days = Math.max(1, Number(options.days || process.env.LUNA_SAMPLE_BIAS_LOOKBACK_DAYS || 14));
  const limit = Math.max(1, Number(options.limit || process.env.LUNA_SAMPLE_BIAS_LIMIT || 5000));
  const minSamples = Math.max(1, Number(options.minSamples || process.env.LUNA_SAMPLE_BIAS_MIN_SAMPLES || 3));
  const fixture = options.fixture === true;
  const write = options.write === true;
  const writeEnabled = boolEnv('LUNA_SAMPLE_BIAS_REPORT_WRITE_ENABLED', false);
  const rows = fixture ? fixtureRows() : await loadTradeRows({ days, limit });
  const universeDistinctSymbols = fixture ? 10 : await loadUniverseDistinctSymbols();
  const report = buildSampleBiasReport(rows, {
    universeDistinctSymbols,
    minSamples,
    days,
  });

  report.fixture = fixture;
  report.writeRequested = write;
  report.writeEnabled = writeEnabled;
  report.written = false;

  if (write && writeEnabled) {
    await writeGuardEvent(report).catch((error) => {
      report.writeError = error?.message || String(error);
    });
    report.written = !report.writeError;
  }

  return report;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => runLunaSampleBiasReport({
      json: hasFlag('json'),
      fixture: hasFlag('fixture'),
      write: hasFlag('write'),
      days: Number(argValue('days', process.env.LUNA_SAMPLE_BIAS_LOOKBACK_DAYS || 14)),
      limit: Number(argValue('limit', process.env.LUNA_SAMPLE_BIAS_LIMIT || 5000)),
      minSamples: Number(argValue('min-samples', process.env.LUNA_SAMPLE_BIAS_MIN_SAMPLES || 3)),
    }),
    onSuccess: async (result) => {
      if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`[luna-sample-bias] total=${result.summary.totalTrades} live=${result.summary.liveTrades} paper=${result.summary.paperTrades} underSampled=${result.summary.underSampledCount}`);
      }
    },
    errorPrefix: 'luna-sample-bias-report error:',
  });
}
