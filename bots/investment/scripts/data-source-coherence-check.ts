#!/usr/bin/env node
// @ts-nocheck
/**
 * data-source-coherence-check.ts
 *
 * Cross-checks trade state sources before analysis.
 *
 * Current live/open state is derived from positions + open trade_journal.
 * investment.trades is an execution ledger and may retain legacy unmatched
 * historical net amounts; Binance free balance is also dust/free-only and does
 * not include locked TP/SL inventory. Those two are reported as advisories, not
 * as live open-state blockers.
 */

import { query, run } from '../shared/db/core.ts';
import { getBinanceBalanceSnapshot } from '../shared/binance-client.ts';

const EPSILON = 1e-12;
const POSITION_REL_TOLERANCE = 0.005;

function argValue(name: string, fallback = null) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function normalizeExchange(value = 'binance') {
  return String(value || 'binance').trim().toLowerCase();
}

function normalizeSymbol(symbol = '') {
  const raw = String(symbol || '').trim().toUpperCase();
  if (!raw) return '';
  if (raw.includes('/')) return raw;
  if (raw.endsWith('USDT')) return `${raw.slice(0, -4)}/USDT`;
  return raw;
}

function displayState(value: number | null | undefined, label: string) {
  const n = Number(value || 0);
  return Math.abs(n) > EPSILON ? `${label}(amount=${n})` : '없음';
}

function amountsClose(a: number | null | undefined, b: number | null | undefined) {
  const left = Math.abs(Number(a || 0));
  const right = Math.abs(Number(b || 0));
  const diff = Math.abs(left - right);
  const scale = Math.max(left, right, 1);
  return diff <= Math.max(EPSILON, scale * POSITION_REL_TOLERANCE);
}

async function fetchTradesNet(exchange: string) {
  return query(
    `SELECT
       symbol,
       exchange,
       COALESCE(paper, false) AS paper,
       COUNT(*) FILTER (WHERE LOWER(side) = 'buy') AS buy_count,
       COUNT(*) FILTER (WHERE LOWER(side) = 'sell') AS sell_count,
       SUM(CASE
         WHEN LOWER(side) = 'buy' THEN COALESCE(amount, 0)
         WHEN LOWER(side) = 'sell' THEN -COALESCE(amount, 0)
         ELSE 0
       END) AS net_amount
     FROM investment.trades
     WHERE LOWER(COALESCE(exchange, '')) = $1
       AND COALESCE(paper, false) = false
       AND COALESCE(exclude_from_learning, false) = false
     GROUP BY symbol, exchange, COALESCE(paper, false)
     HAVING ABS(SUM(CASE
       WHEN LOWER(side) = 'buy' THEN COALESCE(amount, 0)
       WHEN LOWER(side) = 'sell' THEN -COALESCE(amount, 0)
       ELSE 0
     END)) > $2
     ORDER BY ABS(SUM(CASE
       WHEN LOWER(side) = 'buy' THEN COALESCE(amount, 0)
       WHEN LOWER(side) = 'sell' THEN -COALESCE(amount, 0)
       ELSE 0
     END)) DESC`,
    [exchange, EPSILON],
  ).catch(() => []);
}

async function fetchPositions(exchange: string) {
  return query(
    `SELECT symbol, exchange, COALESCE(paper, false) AS paper, amount
       FROM investment.positions
      WHERE LOWER(COALESCE(exchange, '')) = $1
        AND COALESCE(paper, false) = false
        AND ABS(COALESCE(amount, 0)) > $2
      ORDER BY ABS(COALESCE(amount, 0)) DESC`,
    [exchange, EPSILON],
  ).catch(() => []);
}

async function fetchOpenJournals(exchange: string) {
  return query(
    `SELECT symbol, exchange, is_paper, COUNT(*) AS open_count, SUM(COALESCE(entry_size, 0)) AS open_amount
       FROM investment.trade_journal
      WHERE LOWER(COALESCE(exchange, '')) = $1
        AND COALESCE(is_paper, false) = false
        AND LOWER(COALESCE(status, '')) = 'open'
      GROUP BY symbol, exchange, is_paper
      ORDER BY open_count DESC, ABS(SUM(COALESCE(entry_size, 0))) DESC`,
    [exchange],
  ).catch(() => []);
}

async function fetchExchangeBalances(exchange: string, includeBalance: boolean) {
  if (!includeBalance) return [];
  if (exchange !== 'binance') return [];
  const snap = await getBinanceBalanceSnapshot().catch(() => ({ free: {} }));
  return Object.entries(snap.free || {})
    .map(([asset, amount]) => ({ asset: String(asset).toUpperCase(), amount: Number(amount || 0) }))
    .filter((row) => row.amount > 0)
    .sort((a, b) => b.amount - a.amount);
}

function indexBySymbol(rows: any[], amountField: string) {
  const map = new Map();
  for (const row of rows || []) {
    const key = normalizeSymbol(row.symbol);
    if (!key) continue;
    map.set(key, {
      ...row,
      amount: Number(row[amountField] || 0),
    });
  }
  return map;
}

function indexBalances(rows: any[]) {
  const map = new Map();
  for (const row of rows || []) {
    if (!row.asset || row.asset === 'USDT') continue;
    map.set(`${row.asset}/USDT`, row);
  }
  return map;
}

function buildCoherence({ trades, positions, journals, balances }) {
  const tradeMap = indexBySymbol(trades, 'net_amount');
  const positionMap = indexBySymbol(positions, 'amount');
  const journalMap = indexBySymbol(journals, 'open_amount');
  const balanceMap = indexBalances(balances);
  const keys = new Set([
    ...tradeMap.keys(),
    ...positionMap.keys(),
    ...journalMap.keys(),
    ...balanceMap.keys(),
  ]);

  const openStateMismatches = [];
  const legacyTradeLedgerResidues = [];
  const exchangeFreeDust = [];
  for (const symbol of keys) {
    const t = tradeMap.get(symbol);
    const p = positionMap.get(symbol);
    const j = journalMap.get(symbol);
    const b = balanceMap.get(symbol);

    const tradeActive = Math.abs(Number(t?.amount || 0)) > EPSILON;
    const positionActive = Math.abs(Number(p?.amount || 0)) > EPSILON;
    const journalActive = Math.abs(Number(j?.amount || 0)) > EPSILON;
    const balanceActive = Number(b?.amount || 0) > EPSILON;

    const row = {
      symbol,
      trades: t || null,
      positions: p || null,
      journal: j || null,
      balance: b || null,
      stateCount: [tradeActive, positionActive, journalActive, balanceActive].filter(Boolean).length,
    };

    if (positionActive !== journalActive || (positionActive && journalActive && !amountsClose(p?.amount, j?.amount))) {
      openStateMismatches.push(row);
      continue;
    }

    if (tradeActive && (!positionActive || !amountsClose(t?.amount, p?.amount))) {
      legacyTradeLedgerResidues.push(row);
      continue;
    }

    if (balanceActive && !positionActive && !journalActive) {
      exchangeFreeDust.push(row);
    }
  }

  const sortRows = (rows) => rows.sort((a, b) => b.stateCount - a.stateCount || a.symbol.localeCompare(b.symbol));
  return {
    openStateMismatches: sortRows(openStateMismatches),
    legacyTradeLedgerResidues: sortRows(legacyTradeLedgerResidues),
    exchangeFreeDust: sortRows(exchangeFreeDust),
  };
}

function rowToAmounts(row) {
  return {
    symbol: row.symbol,
    tradesAmount: Number(row.trades?.amount || 0),
    positionsAmount: Number(row.positions?.amount || 0),
    journalAmount: Number(row.journal?.amount || 0),
    balanceAmount: Number(row.balance?.amount || 0),
  };
}

async function recordSummary({ exchange, includeBalance, counts, openStateMismatches, legacyTradeLedgerResidues, exchangeFreeDust, noWrite }) {
  if (noWrite) return;
  const severity = openStateMismatches.length > 0 ? 'warning' : 'info';
  await run(
    `INSERT INTO investment.guard_events
       (guard_name, exchange, market, reason, severity, guard_metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      'data_source_coherence_check',
      exchange,
      exchange === 'binance' ? 'crypto' : exchange,
      openStateMismatches.length > 0
        ? `open_state_mismatch_detected:${openStateMismatches.length}`
        : 'source_coherence_clear',
      severity,
      JSON.stringify({
        includeBalance,
        counts,
        mismatchCount: openStateMismatches.length,
        legacyTradeLedgerResidueCount: legacyTradeLedgerResidues.length,
        exchangeFreeDustCount: exchangeFreeDust.length,
        topMismatches: openStateMismatches.slice(0, 20).map(rowToAmounts),
        topLegacyTradeLedgerResidues: legacyTradeLedgerResidues.slice(0, 20).map(rowToAmounts),
        topExchangeFreeDust: exchangeFreeDust.slice(0, 20).map(rowToAmounts),
      }),
    ],
  ).catch(() => null);
}

function printRows(title: string, rows: any[]) {
  if (rows.length <= 0) return;
  console.log(`\n${title}:`);
  for (const row of rows.slice(0, 10)) {
    console.log(
      `  ${row.symbol}: trades=${displayState(row.trades?.amount, '열림')} `
      + `positions=${displayState(row.positions?.amount, '있음')} `
      + `journal=${displayState(row.journal?.amount, 'open')} `
      + `거래소=${displayState(row.balance?.amount, 'free')}`,
    );
  }
}

function printText({ exchange, includeBalance, trades, positions, journals, balances, openStateMismatches, legacyTradeLedgerResidues, exchangeFreeDust }) {
  console.log(`[정합성 체크 ${exchange}]`);
  console.log(`trades 순포지션 잔여:    ${trades.length} 종목 (legacy ledger advisory)`);
  console.log(`positions amount>0:        ${positions.length} 종목`);
  console.log(`trade_journal open:        ${journals.length} 종목`);
  if (includeBalance) console.log(`거래소 free 양수:         ${balances.length} 자산`);
  console.log(`open-state 불일치:        ${openStateMismatches.length} 종목`);
  console.log(`legacy trades 잔여:       ${legacyTradeLedgerResidues.length} 종목`);
  if (includeBalance) console.log(`거래소 free dust:         ${exchangeFreeDust.length} 종목`);

  printRows('open-state 불일치 top10 (positions vs open journal)', openStateMismatches);
  printRows('legacy trades 잔여 top10 (advisory)', legacyTradeLedgerResidues);
  if (includeBalance) printRows('거래소 free dust top10 (advisory)', exchangeFreeDust);
}

async function main() {
  const exchange = normalizeExchange(argValue('exchange', 'binance'));
  const includeBalance = hasFlag('include-balance');
  const json = hasFlag('json');
  const noWrite = hasFlag('no-write');

  const [trades, positions, journals, balances] = await Promise.all([
    fetchTradesNet(exchange),
    fetchPositions(exchange),
    fetchOpenJournals(exchange),
    fetchExchangeBalances(exchange, includeBalance),
  ]);
  const { openStateMismatches, legacyTradeLedgerResidues, exchangeFreeDust } = buildCoherence({ trades, positions, journals, balances });
  const counts = {
    tradesNetOpen: trades.length,
    positionsOpen: positions.length,
    tradeJournalOpen: journals.length,
    exchangePositiveBalances: balances.length,
  };

  await recordSummary({ exchange, includeBalance, counts, openStateMismatches, legacyTradeLedgerResidues, exchangeFreeDust, noWrite });

  const result = {
    ok: true,
    generatedAt: new Date().toISOString(),
    exchange,
    includeBalance,
    counts,
    mismatchCount: openStateMismatches.length,
    legacyTradeLedgerResidueCount: legacyTradeLedgerResidues.length,
    exchangeFreeDustCount: exchangeFreeDust.length,
    mismatches: openStateMismatches.slice(0, 50).map(rowToAmounts),
    legacyTradeLedgerResidues: legacyTradeLedgerResidues.slice(0, 50).map(rowToAmounts),
    exchangeFreeDust: exchangeFreeDust.slice(0, 50).map(rowToAmounts),
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printText({
      exchange,
      includeBalance,
      trades,
      positions,
      journals,
      balances,
      openStateMismatches,
      legacyTradeLedgerResidues,
      exchangeFreeDust,
    });
  }
}

main().catch((err) => {
  console.error('[data-source-coherence-check] 실패:', err?.message || String(err));
  process.exit(1);
});
