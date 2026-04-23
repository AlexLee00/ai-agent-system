#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { publishAlert } from '../shared/alert-publisher.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runVectorBtGrid } from '../shared/vectorbt-runner.ts';

function parseArgs(argv = []) {
  const args = {
    symbol: 'BTC/USDT',
    market: 'binance',
    attention: 'manual',
    source: 'position_watch',
    days: 30,
    json: false,
    noAlert: false,
  };

  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw === '--no-alert') args.noAlert = true;
    else if (raw.startsWith('--symbol=')) args.symbol = raw.split('=').slice(1).join('=') || args.symbol;
    else if (raw.startsWith('--market=')) args.market = raw.split('=').slice(1).join('=') || args.market;
    else if (raw.startsWith('--attention=')) args.attention = raw.split('=').slice(1).join('=') || args.attention;
    else if (raw.startsWith('--source=')) args.source = raw.split('=').slice(1).join('=') || args.source;
    else if (raw.startsWith('--days=')) args.days = Math.max(1, Number(raw.split('=').slice(1).join('=') || 30));
  }

  return args;
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function ensureSchema() {
  await db.initSchema();
  await db.run(`
    CREATE TABLE IF NOT EXISTS vectorbt_backtest_runs (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      days INTEGER NOT NULL,
      tp_pct DOUBLE PRECISION,
      sl_pct DOUBLE PRECISION,
      label TEXT,
      status TEXT DEFAULT 'ok',
      sharpe DOUBLE PRECISION,
      total_return DOUBLE PRECISION,
      max_drawdown DOUBLE PRECISION,
      win_rate DOUBLE PRECISION,
      total_trades INTEGER,
      metadata JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

function scoreRow(row = {}, attention = 'manual') {
  const sharpe = safeNumber(row.sharpe_ratio);
  const totalReturn = safeNumber(row.total_return);
  const maxDrawdown = Math.abs(safeNumber(row.max_drawdown));
  const winRate = safeNumber(row.win_rate);

  if (attention === 'stop_loss_attention' || attention === 'tv_live_bearish') {
    return (sharpe * 1.5) + (winRate * 0.02) + (totalReturn * 0.2) - (maxDrawdown * 0.6);
  }

  if (attention === 'partial_adjust_attention') {
    return (totalReturn * 0.5) + (sharpe * 1.0) + (winRate * 0.03) - (maxDrawdown * 0.3);
  }

  return (sharpe * 1.2) + (totalReturn * 0.3) + (winRate * 0.02) - (maxDrawdown * 0.4);
}

function selectTopResult(rows = [], attention = 'manual') {
  return [...rows]
    .filter((row) => !row?.status || row.status === 'ok')
    .sort((a, b) => scoreRow(b, attention) - scoreRow(a, attention))[0] || null;
}

async function persistRows(symbol, days, attention, source, rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  await ensureSchema();

  for (const row of rows) {
    await db.run(`
      INSERT INTO vectorbt_backtest_runs (
        symbol, days, tp_pct, sl_pct, label, status,
        sharpe, total_return, max_drawdown, win_rate, total_trades, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)
    `, [
      symbol,
      days,
      row.tp ?? null,
      row.sl ?? null,
      row.label || null,
      row.status || 'ok',
      row.sharpe_ratio ?? null,
      row.total_return ?? null,
      row.max_drawdown ?? null,
      row.win_rate ?? null,
      row.total_trades ?? null,
      JSON.stringify({
        trigger: 'active_backtest',
        attention,
        source,
        install: row.install || null,
        missing: row.missing || null,
        error: row.error || null,
      }),
    ]);
  }

  return rows.length;
}

function buildMessage({ symbol, days, attention, topResult, persisted }) {
  const label = topResult?.label || 'n/a';
  const sharpe = safeNumber(topResult?.sharpe_ratio).toFixed(2);
  const totalReturn = safeNumber(topResult?.total_return).toFixed(2);
  const maxDrawdown = safeNumber(topResult?.max_drawdown).toFixed(2);
  const winRate = safeNumber(topResult?.win_rate).toFixed(1);

  return [
    '📈 [루나 액티브 백테스트]',
    `- 심볼: ${symbol}`,
    `- 트리거: ${attention}`,
    `- 기간: ${days}일`,
    `- 최적 후보: ${label}`,
    `- 샤프: ${sharpe} | 수익: ${totalReturn}% | MDD: ${maxDrawdown}% | 승률: ${winRate}%`,
    `- 저장: ${persisted}건`,
  ].join('\n');
}

export async function runActiveBacktest({
  symbol = 'BTC/USDT',
  market = 'binance',
  attention = 'manual',
  source = 'position_watch',
  days = 30,
  json = false,
  noAlert = false,
} = {}) {
  const raw = runVectorBtGrid(symbol, days);

  if (!Array.isArray(raw)) {
    const payload = {
      ok: false,
      status: raw?.status || 'backtest_error',
      symbol,
      market,
      attention,
      days,
      details: raw,
    };
    return json ? payload : JSON.stringify(payload, null, 2);
  }

  const topResult = selectTopResult(raw, attention);
  const persisted = await persistRows(symbol, days, attention, source, raw);

  if (!noAlert && topResult) {
    await publishAlert({
      from_bot: 'luna-active-backtest',
      event_type: 'active_backtest_report',
      alert_level: 1,
      message: buildMessage({ symbol, days, attention, topResult, persisted }),
      payload: {
        symbol,
        market,
        attention,
        days,
        topResult,
        persisted,
      },
    }).catch(() => {});
  }

  const payload = {
    ok: true,
    status: 'active_backtest_ok',
    symbol,
    market,
    attention,
    days,
    persisted,
    topResult,
    totalResults: raw.length,
  };

  return json ? payload : JSON.stringify(payload, null, 2);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => {
      const args = parseArgs(process.argv.slice(2));
      return runActiveBacktest(args);
    },
    onSuccess: async (result) => {
      if (typeof result === 'string') console.log(result);
      else console.log(JSON.stringify(result, null, 2));
    },
    errorPrefix: '❌ runtime-active-backtest 오류:',
  });
}
