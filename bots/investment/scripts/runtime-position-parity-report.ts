#!/usr/bin/env node
// @ts-nocheck

import ccxt from 'ccxt';
import * as db from '../shared/db.ts';
import { initHubSecrets, loadSecrets } from '../shared/secrets.ts';
import { syncPositionsAtMarketOpen } from '../shared/position-sync.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const SUPPORTED_SYNC_MARKETS = ['domestic', 'overseas', 'crypto'];

export function parseSyncMarkets(argv = []) {
  const raw = (argv.find((arg) => arg.startsWith('--markets=')) || '').split('=')[1] || 'crypto';
  const tokens = raw.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (tokens.includes('all')) return [...SUPPORTED_SYNC_MARKETS];
  const selected = tokens.filter((item) => SUPPORTED_SYNC_MARKETS.includes(item));
  return selected.length > 0 ? [...new Set(selected)] : ['crypto'];
}

function parseArgs(argv = []) {
  return {
    json: argv.includes('--json'),
    sync: argv.includes('--sync'),
    markets: parseSyncMarkets(argv),
    limit: Math.max(1, Number((argv.find((arg) => arg.startsWith('--limit=')) || '').split('=')[1] || 20)),
  };
}

function getExchange() {
  const secrets = loadSecrets();
  return new ccxt.binance({
    apiKey: secrets.binance_api_key || '',
    secret: secrets.binance_api_secret || '',
    enableRateLimit: true,
    options: { defaultType: 'spot' },
  });
}

function round(value, digits = 8) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function groupLivePositions(rows = []) {
  const grouped = new Map();
  for (const row of rows) {
    const symbol = String(row.symbol || '').trim();
    if (!symbol) continue;
    const amount = Number(row.amount || 0);
    const avgPrice = Number(row.avg_price || 0);
    const unrealizedPnl = Number(row.unrealized_pnl || 0);
    const tradeMode = String(row.trade_mode || 'normal');
    const current = grouped.get(symbol) || {
      symbol,
      amount: 0,
      unrealizedPnl: 0,
      value: 0,
      tradeModes: [],
    };
    current.amount += amount;
    current.unrealizedPnl += unrealizedPnl;
    current.value += amount * avgPrice;
    if (!current.tradeModes.includes(tradeMode)) current.tradeModes.push(tradeMode);
    grouped.set(symbol, current);
  }
  return grouped;
}

async function fetchOpenJournalMap() {
  const rows = await db.query(`
    SELECT
      symbol,
      SUM(entry_size) AS open_size,
      SUM(entry_value) AS open_value,
      COUNT(*)::int AS open_count
    FROM investment.trade_journal
    WHERE exchange = 'binance'
      AND status = 'open'
      AND is_paper = false
    GROUP BY symbol
  `).catch(() => []);

  const mapped = new Map();
  for (const row of rows) {
    const size = Number(row.open_size || 0);
    const value = Number(row.open_value || 0);
    mapped.set(String(row.symbol || '').trim(), {
      openSize: size,
      openValue: value,
      avgPrice: size > 0 ? value / size : 0,
      openCount: Number(row.open_count || 0),
    });
  }
  return mapped;
}

async function fetchWalletMap(exchange) {
  const balance = await exchange.fetchBalance();
  const wallet = new Map();
  for (const [asset, qty] of Object.entries(balance?.total || {})) {
    const amount = Number(qty || 0);
    if (!(amount > 0.0000001)) continue;
    const base = String(asset || '').trim().toUpperCase();
    if (!base || base === 'USDT') continue;
    const symbol = `${base}/USDT`;
    wallet.set(symbol, {
      symbol,
      base,
      total: amount,
      free: Number(balance?.free?.[base] || 0),
      used: Number(balance?.used?.[base] || 0),
    });
  }
  return wallet;
}

async function fetchTickerMap(exchange, symbols = []) {
  if (symbols.length === 0) return {};
  return exchange.fetchTickers(symbols).catch(() => ({}));
}

const DUST_THRESHOLD_USDT = 10;

export function buildParityRows({ walletMap, dbMap, journalMap, tickerMap, dustThresholdUsdt = DUST_THRESHOLD_USDT }) {
  const symbols = [...new Set([
    ...walletMap.keys(),
    ...dbMap.keys(),
    ...journalMap.keys(),
  ])].sort();

  return symbols.map((symbol) => {
    const wallet = walletMap.get(symbol) || null;
    const dbRow = dbMap.get(symbol) || null;
    const journal = journalMap.get(symbol) || null;
    const currentPrice = Number(tickerMap?.[symbol]?.last || 0);
    const walletQty = Number(wallet?.total || 0);
    const dbQty = Number(dbRow?.amount || 0);
    const qtyDelta = walletQty - dbQty;
    const dbAvgPrice = dbRow && dbRow.amount > 0 ? dbRow.value / dbRow.amount : 0;
    const journalAvgPrice = Number(journal?.avgPrice || 0);
    const dbUnrealizedPnl = Number(dbRow?.unrealizedPnl || 0);
    const expectedDbUnrealized = currentPrice > 0 && dbAvgPrice > 0
      ? (currentPrice - dbAvgPrice) * dbQty
      : 0;
    const walletValue = currentPrice > 0 ? walletQty * currentPrice : 0;
    const isWalletJournalDust = wallet
      && !dbRow
      && journal
      && Number(journal.openSize || 0) > 0
      && walletValue < dustThresholdUsdt;
    const isWalletOnlyDust = wallet
      && !dbRow
      && !journal
      && walletValue < dustThresholdUsdt;
    const className = !wallet && dbRow
      ? 'db_only'
      : isWalletJournalDust
        ? 'wallet_journal_dust'
      : isWalletOnlyDust
        ? 'wallet_only_dust'
      : wallet && !dbRow && journal && journal.openSize > 0
        ? 'wallet_journal_only'
        : wallet && !dbRow
        ? 'wallet_only'
        : Math.abs(qtyDelta) > Math.max(0.000001, walletQty * 0.001)
          ? 'quantity_mismatch'
          : Math.abs(dbUnrealizedPnl - expectedDbUnrealized) > Math.max(1, Math.abs(expectedDbUnrealized) * 0.1)
            ? 'pnl_mismatch'
            : 'ok';

    return {
      symbol,
      class: className,
      walletQty: round(walletQty, 8),
      walletFree: round(Number(wallet?.free || 0), 8),
      walletUsed: round(Number(wallet?.used || 0), 8),
      walletValue: round(walletValue, 4),
      dbQty: round(dbQty, 8),
      qtyDelta: round(qtyDelta, 8),
      dbTradeModes: dbRow?.tradeModes || [],
      dbAvgPrice: round(dbAvgPrice, 8),
      journalAvgPrice: round(journalAvgPrice, 8),
      currentPrice: round(currentPrice, 8),
      dbUnrealizedPnl: round(dbUnrealizedPnl, 4),
      expectedDbUnrealized: round(expectedDbUnrealized, 4),
      unrealizedDelta: round(dbUnrealizedPnl - expectedDbUnrealized, 4),
      journalOpenSize: round(Number(journal?.openSize || 0), 8),
      journalOpenCount: Number(journal?.openCount || 0),
    };
  });
}

export function summarize(rows = []) {
  const byClass = rows.reduce((acc, row) => {
    acc[row.class] = (acc[row.class] || 0) + 1;
    return acc;
  }, {});
  return {
    totalSymbols: rows.length,
    ok: byClass.ok || 0,
    quantityMismatch: byClass.quantity_mismatch || 0,
    pnlMismatch: byClass.pnl_mismatch || 0,
    walletOnly: byClass.wallet_only || 0,
    walletOnlyDust: byClass.wallet_only_dust || 0,
    walletJournalOnly: byClass.wallet_journal_only || 0,
    walletJournalDust: byClass.wallet_journal_dust || 0,
    dbOnly: byClass.db_only || 0,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await db.initSchema();
  await initHubSecrets().catch(() => false);

  let syncResults = [];
  if (args.sync) {
    syncResults = await Promise.all(args.markets.map(async (market) => syncPositionsAtMarketOpen(market).catch((error) => ({
      market,
      ok: false,
      error: error?.message || String(error),
    }))));
  }

  const exchange = getExchange();
  await exchange.loadMarkets();

  const [dbRows, walletMap, journalMap] = await Promise.all([
    db.getAllPositions('binance', false).catch(() => []),
    fetchWalletMap(exchange),
    fetchOpenJournalMap(),
  ]);
  const liveRows = dbRows.filter((row) => String(row.exchange || '') === 'binance' && row.paper !== true);
  const dbMap = groupLivePositions(liveRows);
  const tickerMap = await fetchTickerMap(exchange, [...new Set([
    ...walletMap.keys(),
    ...dbMap.keys(),
    ...journalMap.keys(),
  ])]);

  const rows = buildParityRows({ walletMap, dbMap, journalMap, tickerMap });
  const summary = summarize(rows);
  const topRows = rows
    .filter((row) => !['ok', 'wallet_journal_dust', 'wallet_only_dust'].includes(row.class))
    .sort((a, b) => Math.abs(b.walletValue || 0) - Math.abs(a.walletValue || 0))
    .slice(0, args.limit);

  const payload = {
    scannedAt: new Date().toISOString(),
    syncResult: syncResults.find((item) => item?.market === 'crypto') || null,
    syncResults,
    summary,
    rows: topRows,
    paperPositionCount: dbRows.filter((row) => row.paper === true).length,
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log('\n=== Binance Position Parity ===\n');
  if (syncResults.length > 0) {
    const rendered = syncResults.map((result) => `${result.market}:${result.ok === false ? 'failed' : 'ok'}${result?.mismatchCount !== undefined ? `(${result.mismatchCount})` : ''}`);
    console.log(`sync: ${rendered.join(', ')}`);
  }
  console.log(`symbols=${summary.totalSymbols} ok=${summary.ok} qty_mismatch=${summary.quantityMismatch} pnl_mismatch=${summary.pnlMismatch} wallet_journal_only=${summary.walletJournalOnly} wallet_journal_dust=${summary.walletJournalDust} wallet_only=${summary.walletOnly} wallet_only_dust=${summary.walletOnlyDust} db_only=${summary.dbOnly}`);
  console.log(`paper_positions=${payload.paperPositionCount}`);
  if (topRows.length === 0) {
    console.log('live wallet와 DB 포지션이 현재 기준으로 잘 맞습니다.');
    return;
  }

  console.log('');
  for (const row of topRows) {
    console.log([
      `${row.symbol} [${row.class}]`,
      `wallet=${row.walletQty}`,
      `db=${row.dbQty}`,
      `delta=${row.qtyDelta}`,
      `db_avg=${row.dbAvgPrice}`,
      `journal_avg=${row.journalAvgPrice}`,
      `last=${row.currentPrice}`,
      `db_unreal=${row.dbUnrealizedPnl}`,
      `expected=${row.expectedDbUnrealized}`,
    ].join(' | '));
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-position-parity-report 오류:',
  });
}
