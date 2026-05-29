#!/usr/bin/env node
// @ts-nocheck
/**
 * data-source-coherence-check.ts
 *
 * Cross-checks the four trade state sources before analysis:
 *   1. trades net position
 *   2. positions amount
 *   3. open trade_journal
 *   4. exchange balance snapshot (optional, read-only)
 */

import { query, run } from '../shared/db/core.ts';
import { getBinanceBalanceSnapshot } from '../shared/binance-client.ts';

const EPSILON = 1e-12;

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

function buildMismatches({ trades, positions, journals, balances }) {
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

  const mismatches = [];
  for (const symbol of keys) {
    const t = tradeMap.get(symbol);
    const p = positionMap.get(symbol);
    const j = journalMap.get(symbol);
    const b = balanceMap.get(symbol);
    const flags = [
      Math.abs(Number(t?.amount || 0)) > EPSILON,
      Math.abs(Number(p?.amount || 0)) > EPSILON,
      Math.abs(Number(j?.amount || 0)) > EPSILON,
      Number(b?.amount || 0) > EPSILON,
    ];
    if (new Set(flags).size <= 1) continue;
    mismatches.push({
      symbol,
      trades: t || null,
      positions: p || null,
      journal: j || null,
      balance: b || null,
      stateCount: flags.filter(Boolean).length,
    });
  }
  return mismatches.sort((a, b) => b.stateCount - a.stateCount || a.symbol.localeCompare(b.symbol));
}

async function recordSummary({ exchange, includeBalance, counts, mismatches, noWrite }) {
  if (noWrite) return;
  const severity = mismatches.length > 0 ? 'warning' : 'info';
  await run(
    `INSERT INTO investment.guard_events
       (guard_name, exchange, market, reason, severity, guard_metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      'data_source_coherence_check',
      exchange,
      exchange === 'binance' ? 'crypto' : exchange,
      mismatches.length > 0 ? `source_mismatch_detected:${mismatches.length}` : 'source_coherence_clear',
      severity,
      JSON.stringify({
        includeBalance,
        counts,
        mismatchCount: mismatches.length,
        topMismatches: mismatches.slice(0, 20).map((row) => ({
          symbol: row.symbol,
          tradesAmount: Number(row.trades?.amount || 0),
          positionsAmount: Number(row.positions?.amount || 0),
          journalAmount: Number(row.journal?.amount || 0),
          balanceAmount: Number(row.balance?.amount || 0),
        })),
      }),
    ],
  ).catch(() => null);
}

function printText({ exchange, includeBalance, trades, positions, journals, balances, mismatches }) {
  console.log(`[정합성 체크 ${exchange}]`);
  console.log(`trades 순포지션 열림:    ${trades.length} 종목`);
  console.log(`positions amount>0:        ${positions.length} 종목`);
  console.log(`trade_journal open:        ${journals.length} 종목`);
  if (includeBalance) console.log(`거래소 free 양수:         ${balances.length} 자산`);
  console.log(`불일치 종목:              ${mismatches.length} 종목`);

  if (mismatches.length > 0) {
    console.log('\n불일치 종목 top10 (각 소스별 상태):');
    for (const row of mismatches.slice(0, 10)) {
      console.log(
        `  ${row.symbol}: trades=${displayState(row.trades?.amount, '열림')} `
        + `positions=${displayState(row.positions?.amount, '있음')} `
        + `journal=${displayState(row.journal?.amount, 'open')} `
        + `거래소=${displayState(row.balance?.amount, 'free')}`,
      );
    }
  }
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
  const mismatches = buildMismatches({ trades, positions, journals, balances });
  const counts = {
    tradesNetOpen: trades.length,
    positionsOpen: positions.length,
    tradeJournalOpen: journals.length,
    exchangePositiveBalances: balances.length,
  };

  await recordSummary({ exchange, includeBalance, counts, mismatches, noWrite });

  const result = {
    ok: true,
    generatedAt: new Date().toISOString(),
    exchange,
    includeBalance,
    counts,
    mismatchCount: mismatches.length,
    mismatches: mismatches.slice(0, 50).map((row) => ({
      symbol: row.symbol,
      tradesAmount: Number(row.trades?.amount || 0),
      positionsAmount: Number(row.positions?.amount || 0),
      journalAmount: Number(row.journal?.amount || 0),
      balanceAmount: Number(row.balance?.amount || 0),
    })),
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printText({ exchange, includeBalance, trades, positions, journals, balances, mismatches });
  }
}

main().catch((err) => {
  console.error('[data-source-coherence-check] 실패:', err?.message || String(err));
  process.exit(1);
});
