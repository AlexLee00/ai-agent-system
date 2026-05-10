#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const CONFIRM = 'luna-tradingview-position-subscription-sync';
const DEFAULT_BASE_URL = process.env.TV_METRICS_BASE_URL || 'http://127.0.0.1:8083';
const DEFAULT_TIMEFRAMES = '60,240,D';
const DEFAULT_TTL_MS = 15 * 60 * 1000;

function hasArg(name, argv = process.argv.slice(2)) {
  return argv.includes(`--${name}`);
}

function argValue(name, fallback = null, argv = process.argv.slice(2)) {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function parseList(value = '') {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeBinanceTradingViewSymbol(symbol = '') {
  const raw = String(symbol || '').trim().toUpperCase();
  if (!raw) return null;
  if (raw.startsWith('BINANCE:')) return raw;
  const compact = raw.replace('/', '').replace(/[^A-Z0-9]/g, '');
  if (!compact.endsWith('USDT')) return null;
  return `BINANCE:${compact}`;
}

export function buildTradingViewOpenPositionSubscriptionPlan({
  positions = [],
  timeframes = parseList(DEFAULT_TIMEFRAMES),
  baseUrl = DEFAULT_BASE_URL,
  ttlMs = DEFAULT_TTL_MS,
  protect = true,
} = {}) {
  const symbols = [...new Set((positions || [])
    .map((position) => normalizeBinanceTradingViewSymbol(position?.symbol))
    .filter(Boolean))];
  const normalizedTimeframes = [...new Set((timeframes || []).map((item) => String(item || '').trim()).filter(Boolean))];
  const subscriptions = [];
  for (const symbol of symbols) {
    for (const timeframe of normalizedTimeframes) {
      const url = new URL('/subscribe', baseUrl);
      url.searchParams.set('symbol', symbol);
      url.searchParams.set('timeframe', timeframe);
      url.searchParams.set('ttlMs', String(Math.max(30_000, Number(ttlMs || DEFAULT_TTL_MS))));
      if (protect) url.searchParams.set('protected', 'true');
      subscriptions.push({
        symbol,
        timeframe,
        url: url.toString(),
        protected: protect === true,
      });
    }
  }
  return {
    ok: true,
    status: subscriptions.length > 0 ? 'tradingview_position_subscription_sync_ready' : 'tradingview_position_subscription_sync_no_positions',
    symbols,
    timeframes: normalizedTimeframes,
    subscriptions,
    ttlMs: Math.max(30_000, Number(ttlMs || DEFAULT_TTL_MS)),
    protected: protect === true,
    baseUrl,
  };
}

export async function runTradingViewOpenPositionSubscriptionSync({
  exchange = 'binance',
  paper = false,
  timeframes = parseList(process.env.TV_OPEN_POSITION_TIMEFRAMES || DEFAULT_TIMEFRAMES),
  baseUrl = DEFAULT_BASE_URL,
  ttlMs = Number(process.env.TV_OPEN_POSITION_SUBSCRIPTION_TTL_MS || DEFAULT_TTL_MS),
  protect = true,
  apply = false,
  confirm = null,
  fetchImpl = fetch,
  positions = null,
} = {}) {
  if (exchange !== 'binance') {
    return {
      ok: true,
      status: 'tradingview_position_subscription_sync_not_applicable',
      exchange,
      reason: 'tradingview_ws_position_sync_only_supports_binance',
    };
  }
  await db.initSchema();
  const loadedPositions = positions || await db.getOpenPositions(exchange, paper === true).catch(() => []);
  const plan = buildTradingViewOpenPositionSubscriptionPlan({
    positions: loadedPositions,
    timeframes,
    baseUrl,
    ttlMs,
    protect,
  });
  if (!apply) {
    return {
      ok: true,
      status: plan.status,
      dryRun: true,
      applied: false,
      exchange,
      paper: paper === true,
      plan,
      applyCommand: `node scripts/runtime-tradingview-open-position-subscription-sync.ts --apply --confirm=${CONFIRM} --json`,
    };
  }
  if (confirm !== CONFIRM) {
    return {
      ok: false,
      status: 'tradingview_position_subscription_sync_confirm_required',
      dryRun: false,
      applied: false,
      confirmRequired: CONFIRM,
      plan,
    };
  }

  const results = [];
  for (const subscription of plan.subscriptions) {
    try {
      const response = await fetchImpl(subscription.url, { signal: AbortSignal.timeout(5_000) });
      const json = await response.json().catch(() => ({}));
      const serviceProtected = json?.protected === true;
      results.push({
        symbol: subscription.symbol,
        timeframe: subscription.timeframe,
        ok: response.ok && json?.ok !== false,
        status: response.status,
        requestedProtected: subscription.protected,
        serviceProtected,
        key: json?.key || null,
        warning: subscription.protected && !serviceProtected ? 'tradingview_service_protected_echo_missing_until_reload' : null,
        error: json?.error || null,
      });
    } catch (error) {
      results.push({
        symbol: subscription.symbol,
        timeframe: subscription.timeframe,
        ok: false,
        requestedProtected: subscription.protected,
        serviceProtected: false,
        error: error?.message || String(error),
      });
    }
  }
  const failed = results.filter((row) => row.ok !== true);
  const warnings = results.map((row) => row.warning).filter(Boolean);
  return {
    ok: failed.length === 0,
    status: failed.length === 0
      ? warnings.length > 0
        ? 'tradingview_position_subscription_sync_applied_with_warnings'
        : 'tradingview_position_subscription_sync_applied'
      : 'tradingview_position_subscription_sync_degraded',
    dryRun: false,
    applied: true,
    exchange,
    paper: paper === true,
    plan,
    results,
    failed,
    warnings,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const result = await runTradingViewOpenPositionSubscriptionSync({
    exchange: argValue('exchange', 'binance', argv),
    paper: hasArg('paper', argv),
    timeframes: parseList(argValue('timeframes', process.env.TV_OPEN_POSITION_TIMEFRAMES || DEFAULT_TIMEFRAMES, argv)),
    baseUrl: argValue('base-url', DEFAULT_BASE_URL, argv),
    ttlMs: Math.max(30_000, Number(argValue('ttl-ms', process.env.TV_OPEN_POSITION_SUBSCRIPTION_TTL_MS || DEFAULT_TTL_MS, argv)) || DEFAULT_TTL_MS),
    protect: !hasArg('no-protect', argv),
    apply: hasArg('apply', argv),
    confirm: argValue('confirm', null, argv),
  });
  if (hasArg('json', argv)) console.log(JSON.stringify(result, null, 2));
  else console.log(`runtime-tradingview-open-position-subscription-sync ${result.status}`);
  if (!result.ok) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-tradingview-open-position-subscription-sync 실패:',
  });
}
