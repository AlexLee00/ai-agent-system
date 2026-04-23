#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';

function parseArgs(argv = []) {
  return {
    json: argv.includes('--json'),
    limit: Math.max(1, Number((argv.find((arg) => arg.startsWith('--limit=')) || '').split('=')[1] || 30)),
  };
}

function classifyLegGroup(group = {}) {
  const liveModes = new Set(group.legs.filter((leg) => !leg.paper).map((leg) => leg.tradeMode));
  const hasPaper = group.legs.some((leg) => leg.paper);
  const hasLive = group.legs.some((leg) => !leg.paper);
  if (hasLive && hasPaper) return 'mixed_paper_live';
  if (liveModes.size > 1) return 'split_live_modes';
  if (group.legs.length > 1) return 'multi_leg_same_symbol';
  return 'single_leg';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await db.initSchema();

  const [positions, journalRows, signalRows] = await Promise.all([
    db.query(`
      SELECT symbol, exchange, paper, COALESCE(trade_mode, 'normal') AS trade_mode,
             amount, avg_price, unrealized_pnl, updated_at
      FROM investment.positions
      WHERE amount > 0
      ORDER BY exchange, symbol, paper, trade_mode
    `),
    db.query(`
      SELECT symbol, exchange, is_paper, COALESCE(trade_mode, 'normal') AS trade_mode,
             COUNT(*)::int AS open_journal_count,
             COALESCE(SUM(entry_size), 0) AS open_journal_size
      FROM investment.trade_journal
      WHERE status = 'open'
      GROUP BY symbol, exchange, is_paper, COALESCE(trade_mode, 'normal')
    `),
    db.query(`
      SELECT symbol, exchange, COALESCE(trade_mode, 'normal') AS trade_mode,
             status, created_at
      FROM investment.signals
      WHERE created_at >= now() - interval '14 days'
      ORDER BY created_at DESC
    `),
  ]);

  const journalMap = new Map(
    journalRows.map((row) => [
      `${row.exchange}:${row.symbol}:${row.is_paper === true ? 'paper' : 'live'}:${row.trade_mode}`,
      {
        openJournalCount: Number(row.open_journal_count || 0),
        openJournalSize: Number(row.open_journal_size || 0),
      },
    ]),
  );

  const recentSignalMap = new Map();
  for (const row of signalRows) {
    const key = `${row.exchange}:${row.symbol}:${row.trade_mode}`;
    if (!recentSignalMap.has(key)) recentSignalMap.set(key, []);
    if (recentSignalMap.get(key).length < 3) {
      recentSignalMap.get(key).push({
        status: row.status,
        createdAt: row.created_at,
      });
    }
  }

  const grouped = new Map();
  for (const row of positions) {
    const key = `${row.exchange}:${row.symbol}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        exchange: row.exchange,
        symbol: row.symbol,
        legs: [],
      });
    }
    const legKey = `${row.exchange}:${row.symbol}:${row.paper === true ? 'paper' : 'live'}:${row.trade_mode}`;
    grouped.get(key).legs.push({
      paper: row.paper === true,
      scope: row.paper === true ? 'paper' : 'live',
      tradeMode: row.trade_mode,
      amount: Number(row.amount || 0),
      avgPrice: Number(row.avg_price || 0),
      unrealizedPnl: Number(row.unrealized_pnl || 0),
      updatedAt: row.updated_at,
      ...(journalMap.get(legKey) || { openJournalCount: 0, openJournalSize: 0 }),
      recentSignals: recentSignalMap.get(`${row.exchange}:${row.symbol}:${row.trade_mode}`) || [],
    });
  }

  const rows = [...grouped.values()]
    .map((group) => ({
      ...group,
      classification: classifyLegGroup(group),
      legCount: group.legs.length,
    }))
    .sort((a, b) => {
      if (a.classification === 'single_leg' && b.classification !== 'single_leg') return 1;
      if (a.classification !== 'single_leg' && b.classification === 'single_leg') return -1;
      return b.legCount - a.legCount || a.exchange.localeCompare(b.exchange) || a.symbol.localeCompare(b.symbol);
    });

  const summary = rows.reduce((acc, row) => {
    acc.totalSymbols += 1;
    acc[row.classification] = (acc[row.classification] || 0) + 1;
    return acc;
  }, { totalSymbols: 0, single_leg: 0, mixed_paper_live: 0, split_live_modes: 0, multi_leg_same_symbol: 0 });

  const flagged = rows.filter((row) => row.classification !== 'single_leg').slice(0, args.limit);
  const payload = {
    scannedAt: new Date().toISOString(),
    summary,
    rows: flagged,
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log('\n=== Same-symbol Position Leg Review ===\n');
  console.log(
    `symbols=${summary.totalSymbols} mixed_paper_live=${summary.mixed_paper_live} split_live_modes=${summary.split_live_modes} multi_leg_same_symbol=${summary.multi_leg_same_symbol}`,
  );
  if (flagged.length === 0) {
    console.log('같은 심볼 다중 포지션 이슈가 보이지 않습니다.');
    return;
  }

  console.log('');
  for (const row of flagged) {
    console.log(`${row.exchange} ${row.symbol} [${row.classification}]`);
    for (const leg of row.legs) {
      const signals = leg.recentSignals.map((item) => item.status).join(',') || 'none';
      console.log(
        `  - ${leg.scope}/${leg.tradeMode} amount=${leg.amount} avg=${leg.avgPrice} unreal=${leg.unrealizedPnl} openJournal=${leg.openJournalCount}/${leg.openJournalSize} recentSignals=${signals}`,
      );
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
