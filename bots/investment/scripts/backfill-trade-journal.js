#!/usr/bin/env node

import * as db from '../shared/db.js';
import * as journalDb from '../shared/trade-journal-db.js';

function marketFromExchange(exchange) {
  if (exchange === 'binance') return 'crypto';
  if (exchange === 'kis') return 'domestic';
  if (exchange === 'kis_overseas') return 'overseas';
  return exchange || 'unknown';
}

function toMs(value) {
  return value ? new Date(value).getTime() : Date.now();
}

async function getLatestPositionMap() {
  const rows = await db.query(`
    SELECT symbol, exchange, paper, amount, avg_price
    FROM investment.positions
    WHERE amount > 0
  `);
  return new Map(rows.map(row => [`${row.exchange}:${row.symbol}`, row]));
}

async function reconcileTradePaperFlags(positions, { dryRun = false } = {}) {
  const mismatches = await db.query(`
    SELECT t.id, t.symbol, t.exchange, t.paper AS trade_paper, p.paper AS position_paper
    FROM investment.trades t
    JOIN investment.positions p ON p.symbol = t.symbol AND p.exchange = t.exchange
    WHERE t.side = 'buy'
      AND p.amount > 0
      AND COALESCE(t.paper, false) <> COALESCE(p.paper, false)
  `);

  if (!dryRun) {
    for (const row of mismatches) {
      const position = positions.get(`${row.exchange}:${row.symbol}`);
      if (!position) continue;
      await db.run(`UPDATE trades SET paper = $1 WHERE id = $2`, [Boolean(position.paper), row.id]);
    }
  }

  return mismatches.length;
}

async function backfillTradeJournal({ dryRun = false } = {}) {
  await db.initSchema();
  await journalDb.initJournalSchema();

  const [trades, existingEntries, positions] = await Promise.all([
    db.query(`
      SELECT id, signal_id, symbol, side, amount, price, total_usdt, paper, exchange, executed_at
      FROM investment.trades
      ORDER BY executed_at ASC
    `),
    db.query(`
      SELECT trade_id, signal_id, symbol, exchange, entry_time, status, is_paper
      FROM investment.trade_journal
      ORDER BY entry_time ASC
    `),
    getLatestPositionMap(),
  ]);

  const reconciledTradeFlags = await reconcileTradePaperFlags(positions, { dryRun });

  const existingBySignal = new Set(existingEntries.filter(e => e.signal_id).map(e => `${e.exchange}:${e.signal_id}`));
  const openEntries = new Map(
    existingEntries
      .filter(e => e.status === 'open')
      .map(e => [`${e.exchange}:${e.symbol}:${Boolean(e.is_paper)}`, e]),
  );

  let inserted = 0;
  let closed = 0;
  let skipped = 0;

  for (const trade of trades) {
    const exchange = trade.exchange || 'binance';
    const market = marketFromExchange(exchange);
    const signalKey = trade.signal_id ? `${exchange}:${trade.signal_id}` : null;
    const executedMs = toMs(trade.executed_at);
    const position = positions.get(`${exchange}:${trade.symbol}`);
    const effectivePaper = position && trade.side === 'buy'
      ? Boolean(position.paper)
      : Boolean(trade.paper);

    if (signalKey && existingBySignal.has(signalKey)) {
      skipped++;
      continue;
    }

    if ((trade.side || '').toLowerCase() === 'buy') {
      const tradeId = dryRun ? `DRY-${trade.id}` : await journalDb.generateTradeId();
      if (!dryRun) {
        await journalDb.insertJournalEntry({
          trade_id: tradeId,
          signal_id: trade.signal_id,
          market,
          exchange,
          symbol: trade.symbol,
          is_paper: effectivePaper,
          entry_time: executedMs,
          entry_price: trade.price || 0,
          entry_size: trade.amount || 0,
          entry_value: trade.total_usdt || 0,
          direction: 'long',
        });
        if (trade.signal_id) {
          await journalDb.linkRationaleToTrade(tradeId, trade.signal_id).catch(() => {});
        }
      }
      openEntries.set(`${exchange}:${trade.symbol}:${effectivePaper}`, {
        trade_id: tradeId,
        signal_id: trade.signal_id,
        symbol: trade.symbol,
        exchange,
        is_paper: effectivePaper,
        entry_time: executedMs,
        entry_value: trade.total_usdt || 0,
      });
      if (signalKey) existingBySignal.add(signalKey);
      inserted++;
      continue;
    }

    if ((trade.side || '').toLowerCase() === 'sell') {
      const openKey = `${exchange}:${trade.symbol}:${effectivePaper}`;
      const openEntry = openEntries.get(openKey);
      if (!openEntry) {
        skipped++;
        continue;
      }
      if (!dryRun) {
        const pnlAmount = (trade.total_usdt || 0) - (openEntry.entry_value || 0);
        const pnlPercent = openEntry.entry_value > 0
          ? journalDb.ratioToPercent(pnlAmount / openEntry.entry_value)
          : null;
        await journalDb.closeJournalEntry(openEntry.trade_id, {
          exitTime: executedMs,
          exitPrice: trade.price || null,
          exitValue: trade.total_usdt || null,
          exitReason: 'backfilled_sell',
          pnlAmount,
          pnlPercent,
          pnlNet: pnlAmount,
        });
      }
      openEntries.delete(openKey);
      closed++;
      if (signalKey) existingBySignal.add(signalKey);
      continue;
    }

    skipped++;
  }

  return {
    totalTrades: trades.length,
    inserted,
    closed,
    skipped,
    reconciledTradeFlags,
    dryRun,
  };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const result = await backfillTradeJournal({ dryRun });
  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error('❌ trade_journal 백필 실패:', err?.message || String(err));
  process.exit(1);
});
