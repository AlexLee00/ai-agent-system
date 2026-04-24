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
    urgency: 'normal',
    watchMission: null,
    riskMission: null,
    ownerMode: null,
    strategyName: null,
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
    else if (raw.startsWith('--urgency=')) args.urgency = raw.split('=').slice(1).join('=') || args.urgency;
    else if (raw.startsWith('--watch-mission=')) args.watchMission = raw.split('=').slice(1).join('=') || null;
    else if (raw.startsWith('--risk-mission=')) args.riskMission = raw.split('=').slice(1).join('=') || null;
    else if (raw.startsWith('--owner-mode=')) args.ownerMode = raw.split('=').slice(1).join('=') || null;
    else if (raw.startsWith('--strategy-name=')) args.strategyName = raw.split('=').slice(1).join('=') || null;
  }

  return args;
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeDays(market, days, {
  urgency = 'normal',
  watchMission = null,
  riskMission = null,
} = {}) {
  let base = market === 'binance' ? Math.max(14, days) : Math.max(90, days);

  if (urgency === 'high') {
    base = market === 'binance' ? Math.max(21, base) : Math.max(120, base);
  } else if (urgency === 'low') {
    base = market === 'binance' ? Math.max(14, Math.min(base, 21)) : Math.max(90, Math.min(base, 120));
  }

  if (String(watchMission || '').trim().toLowerCase() === 'backtest_drift_watcher') {
    base += market === 'binance' ? 7 : 14;
  }

  if (String(riskMission || '').trim().toLowerCase() === 'strict_risk_gate') {
    base += market === 'binance' ? 3 : 10;
  }

  return base;
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

function scoreRow(row = {}, attention = 'manual', context = {}) {
  const sharpe = safeNumber(row.sharpe_ratio);
  const totalReturn = safeNumber(row.total_return);
  const maxDrawdown = Math.abs(safeNumber(row.max_drawdown));
  const winRate = safeNumber(row.win_rate);
  const watchMission = String(context.watchMission || '').trim().toLowerCase();
  const riskMission = String(context.riskMission || '').trim().toLowerCase();
  const ownerMode = String(context.ownerMode || '').trim().toLowerCase();

  if (attention === 'stop_loss_attention' || attention === 'tv_live_bearish') {
    let score = (sharpe * 1.5) + (winRate * 0.02) + (totalReturn * 0.2) - (maxDrawdown * 0.6);
    if (riskMission === 'strict_risk_gate') score -= maxDrawdown * 0.15;
    return score;
  }

  if (attention === 'partial_adjust_attention') {
    let score = (totalReturn * 0.5) + (sharpe * 1.0) + (winRate * 0.03) - (maxDrawdown * 0.3);
    if (watchMission === 'backtest_drift_watcher') score += sharpe * 0.2;
    return score;
  }

  let score = (sharpe * 1.2) + (totalReturn * 0.3) + (winRate * 0.02) - (maxDrawdown * 0.4);
  if (ownerMode === 'capital_preservation') score -= maxDrawdown * 0.1;
  if (watchMission === 'backtest_drift_watcher') score += sharpe * 0.1;
  return score;
}

function hasUsableTrades(row = {}) {
  return safeNumber(row?.total_trades) > 0;
}

function selectTopResult(rows = [], attention = 'manual', context = {}) {
  return [...rows]
    .filter((row) => (!row?.status || row.status === 'ok') && hasUsableTrades(row))
    .sort((a, b) => scoreRow(b, attention, context) - scoreRow(a, attention, context))[0] || null;
}

function selectFallbackResult(rows = [], attention = 'manual', context = {}) {
  return [...rows]
    .filter((row) => !row?.status || row.status === 'ok')
    .sort((a, b) => scoreRow(b, attention, context) - scoreRow(a, attention, context))[0] || null;
}

async function persistRows(symbol, market, days, attention, source, rows = [], context = {}) {
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
        market,
        attention,
        source,
        urgency: context.urgency || null,
        watchMission: context.watchMission || null,
        riskMission: context.riskMission || null,
        ownerMode: context.ownerMode || null,
        strategyName: context.strategyName || null,
        install: row.install || null,
        missing: row.missing || null,
        error: row.error || null,
      }),
    ]);
  }

  return rows.length;
}

function classifyBacktestQuality({ market, usableRows = [], topResult = null, context = {} }) {
  if (usableRows.length === 0) {
    return {
      status: 'active_backtest_thin',
      headline: `${market} 표본이 얇아 즉시 전략 변경보다 더 누적이 필요합니다.`,
      actionable: false,
    };
  }

  const driftWatcher = String(context.watchMission || '').trim().toLowerCase() === 'backtest_drift_watcher';
  return {
    status: driftWatcher ? 'active_backtest_priority' : 'active_backtest_ready',
    headline: driftWatcher
      ? `${market} 액티브 백테스트 결과를 전략 drift 재판단의 우선 비교 후보로 봅니다.`
      : `${market} 액티브 백테스트 결과를 바로 전략 비교 후보로 볼 수 있습니다.`,
    actionable: true,
  };
}

function buildMessage({ symbol, market, days, attention, quality, topResult, persisted }) {
  const label = topResult?.label || 'n/a';
  const sharpe = safeNumber(topResult?.sharpe_ratio).toFixed(2);
  const totalReturn = safeNumber(topResult?.total_return).toFixed(2);
  const maxDrawdown = safeNumber(topResult?.max_drawdown).toFixed(2);
  const winRate = safeNumber(topResult?.win_rate).toFixed(1);
  const trades = safeNumber(topResult?.total_trades);

  return [
    '📈 [루나 액티브 백테스트]',
    `- 심볼: ${symbol}`,
    `- 시장: ${market}`,
    `- 트리거: ${attention}`,
    `- 기간: ${days}일`,
    `- 상태: ${quality.status}`,
    `- 해석: ${quality.headline}`,
    `- 최적 후보: ${label}`,
    `- 샤프: ${sharpe} | 수익: ${totalReturn}% | MDD: ${maxDrawdown}% | 승률: ${winRate}% | 거래수: ${trades}`,
    `- 저장: ${persisted}건`,
  ].join('\n');
}

function marketToExchange(market = 'binance') {
  if (market === 'binance') return 'binance';
  if (market === 'kis') return 'kis';
  if (market === 'kis_overseas') return 'kis_overseas';
  return market;
}

async function syncActiveBacktestRuntimeState(symbol, market, payload = {}) {
  const exchange = marketToExchange(market);
  const strategyProfile = await db.getPositionStrategyProfile(symbol, {
    exchange,
    tradeMode: 'normal',
  }).catch(() => null);
  if (!strategyProfile?.id) return;

  const previousRuntime = strategyProfile?.strategy_state?.positionRuntimeState || {};
  const previousExecutionIntent = previousRuntime?.executionIntent || {};
  const severity = payload?.quality?.actionable
    ? payload?.quality?.status === 'active_backtest_priority'
      ? 'warning'
      : 'stable'
    : 'thin';
  const validationState = {
    ...(previousRuntime?.validationState || {}),
    enabled: true,
    severity,
    totalTrades: safeNumber(payload?.topResult?.total_trades, 0),
    sharpeDrop: previousRuntime?.validationState?.sharpeDrop ?? 0,
    returnDropPct: previousRuntime?.validationState?.returnDropPct ?? 0,
    lastBacktestAt: new Date().toISOString(),
    nextBacktestWindowDays: safeNumber(payload?.days, 30),
  };

  const nextRuntime = {
    ...previousRuntime,
    updatedAt: new Date().toISOString(),
    updatedBy: 'runtime_active_backtest',
    validationState,
    executionIntent: {
      ...previousExecutionIntent,
      validationSeverity: severity,
    },
    latestBacktestRuntime: {
      status: payload?.status || null,
      attention: payload?.attention || null,
      topResult: payload?.topResult || null,
      quality: payload?.quality || null,
      persisted: payload?.persisted || 0,
      updatedAt: new Date().toISOString(),
    },
  };

  await db.updatePositionStrategyProfileState(symbol, {
    exchange,
    tradeMode: strategyProfile.trade_mode || 'normal',
    strategyState: {
      latestBacktestValidation: validationState,
      positionRuntimeState: nextRuntime,
      updatedBy: 'runtime_active_backtest',
      updatedAt: new Date().toISOString(),
    },
    lastEvaluationAt: new Date().toISOString(),
    lastAttentionAt: severity === 'warning' ? new Date().toISOString() : null,
  }).catch(() => null);
}

export async function runActiveBacktest({
  symbol = 'BTC/USDT',
  market = 'binance',
  attention = 'manual',
  source = 'position_watch',
  days = 30,
  urgency = 'normal',
  watchMission = null,
  riskMission = null,
  ownerMode = null,
  strategyName = null,
  json = false,
  noAlert = false,
} = {}) {
  const context = {
    urgency,
    watchMission,
    riskMission,
    ownerMode,
    strategyName,
  };
  const effectiveDays = normalizeDays(market, days, context);
  const raw = runVectorBtGrid(symbol, effectiveDays);

  if (!Array.isArray(raw)) {
    const payload = {
      ok: false,
      status: raw?.status || 'backtest_error',
      symbol,
      market,
      attention,
      days: effectiveDays,
      context,
      details: raw,
    };
    return json ? payload : JSON.stringify(payload, null, 2);
  }

  const usableRows = raw.filter((row) => (!row?.status || row.status === 'ok') && hasUsableTrades(row));
  const topResult = selectTopResult(raw, attention, context) || selectFallbackResult(raw, attention, context);
  const quality = classifyBacktestQuality({ market, usableRows, topResult, context });
  const persisted = await persistRows(symbol, market, effectiveDays, attention, source, raw, context);
  const payload = {
    ok: true,
    status: quality.status,
    symbol,
    market,
    attention,
    days: effectiveDays,
    context,
    persisted,
    quality,
    topResult,
    usableResultCount: usableRows.length,
    totalResults: raw.length,
  };

  await syncActiveBacktestRuntimeState(symbol, market, payload).catch(() => null);

  if (!noAlert && topResult) {
    await publishAlert({
      from_bot: 'luna-active-backtest',
      event_type: 'active_backtest_report',
      alert_level: quality.actionable ? 1 : 0,
      message: buildMessage({ symbol, market, days: effectiveDays, attention, quality, topResult, persisted }),
      payload: {
        symbol,
        market,
        attention,
        days: effectiveDays,
        context,
        quality,
        usableResultCount: usableRows.length,
        topResult,
        persisted,
      },
    }).catch(() => {});
  }

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
