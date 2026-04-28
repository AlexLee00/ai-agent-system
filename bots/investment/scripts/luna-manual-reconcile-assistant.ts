#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import * as db from '../shared/db.ts';
import { initJournalSchema } from '../shared/trade-journal-db.ts';
import { getBinanceBalanceSnapshot, getTickerLastPrice } from '../shared/binance-client.ts';
import { publishAlert } from '../shared/alert-publisher.ts';

const DEFAULT_SYMBOL = 'LUNC/USDT';
const DUST_QTY_EPSILON = 1e-8;
const DUST_VALUE_USDT = 10;

function hasFlag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function round(value, digits = 8) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function baseAsset(symbol = '') {
  return String(symbol || '').split('/')[0]?.trim().toUpperCase() || '';
}

function classifyParity({ walletQty = 0, positionQty = 0, journalQty = 0, lastPrice = 0 } = {}) {
  const walletValue = Number(walletQty || 0) * Number(lastPrice || 0);
  const qtyDeltaPosition = Number(walletQty || 0) - Number(positionQty || 0);
  const qtyDeltaJournal = Number(walletQty || 0) - Number(journalQty || 0);
  const qtyTolerance = Math.max(DUST_QTY_EPSILON, Math.abs(Number(walletQty || 0)) * 0.001);
  const positionClear = Math.abs(qtyDeltaPosition) <= qtyTolerance;
  const journalClear = Math.abs(qtyDeltaJournal) <= qtyTolerance;
  if (positionClear && journalClear) return 'wallet_position_journal_aligned';
  if (Math.abs(Number(walletQty || 0)) <= DUST_QTY_EPSILON && Math.abs(Number(positionQty || 0)) <= DUST_QTY_EPSILON && Math.abs(Number(journalQty || 0)) <= DUST_QTY_EPSILON) {
    return 'no_live_holding';
  }
  if (walletValue > 0 && walletValue < DUST_VALUE_USDT) return 'dust_reconcile_required';
  if (!positionClear && !journalClear) return 'position_and_journal_mismatch';
  if (!positionClear) return 'position_mismatch';
  return 'journal_mismatch';
}

function buildRecommendedSteps({ signalRows = [], parityClass = '', walletQty = 0, positionQty = 0, journalQty = 0 } = {}) {
  const steps = [];
  const hardSignals = signalRows.filter((row) => String(row.block_code || '') === 'manual_reconcile_required');
  if (hardSignals.length > 0) {
    steps.push(`manual_reconcile_required signal ${hardSignals.length}건의 block_meta와 주문/잔고 증빙을 보존한다.`);
  }
  if (parityClass === 'wallet_position_journal_aligned') {
    steps.push('지갑/positions/open journal 수량이 정렬되어 있으므로 block_meta ACK 또는 사유 정리만 검토한다.');
  } else if (parityClass === 'no_live_holding') {
    steps.push('실제 보유/로컬 포지션/open journal이 모두 0이면 체결 부재 또는 종료 완료 증빙으로 정리한다.');
  } else {
    steps.push(`수량 차이 확인: wallet=${round(walletQty)} / position=${round(positionQty)} / openJournal=${round(journalQty)}`);
    steps.push('실제 거래소 체결 내역과 local trades/trade_journal/positions를 대조해 누락 row 또는 잘못된 수량을 보정한다.');
  }
  steps.push('보정은 별도 migration/수동 보정 스크립트로 수행하고, live-fire final gate를 재실행한다.');
  return steps;
}

export function buildManualReconcileAssistantFromSnapshots({
  symbol = DEFAULT_SYMBOL,
  exchange = 'binance',
  wallet = {},
  position = null,
  openJournal = {},
  signalRows = [],
  trades = [],
  journals = [],
  lastPrice = 0,
} = {}) {
  const walletQty = Number(wallet.total || 0);
  const positionQty = Number(position?.amount || 0);
  const journalQty = Number(openJournal.open_size || 0);
  const parityClass = classifyParity({ walletQty, positionQty, journalQty, lastPrice });
  const blockers = [];
  if (signalRows.some((row) => String(row.block_code || '') === 'manual_reconcile_required')) blockers.push('manual_reconcile_signal_present');
  if (!['wallet_position_journal_aligned', 'no_live_holding'].includes(parityClass)) blockers.push(parityClass);
  return {
    ok: blockers.length === 0,
    checkedAt: new Date().toISOString(),
    status: blockers.length === 0 ? 'manual_reconcile_assistant_clear' : 'manual_reconcile_assistant_required',
    exchange,
    symbol,
    blockers,
    parity: {
      class: parityClass,
      lastPrice: round(lastPrice, 8),
      walletQty: round(walletQty, 8),
      walletFree: round(wallet.free || 0, 8),
      walletUsed: round(wallet.used || 0, 8),
      walletValueUsdt: round(walletQty * Number(lastPrice || 0), 4),
      positionQty: round(positionQty, 8),
      positionAvgPrice: round(position?.avg_price || 0, 8),
      openJournalQty: round(journalQty, 8),
      openJournalValue: round(openJournal.open_value || 0, 4),
      walletMinusPosition: round(walletQty - positionQty, 8),
      walletMinusJournal: round(walletQty - journalQty, 8),
    },
    evidence: {
      signalCount: signalRows.length,
      manualReconcileSignals: signalRows.filter((row) => String(row.block_code || '') === 'manual_reconcile_required').length,
      tradeCount: trades.length,
      journalCount: journals.length,
      openJournalCount: Number(openJournal.open_count || 0),
      latestSignals: signalRows.slice(0, 5).map((row) => ({
        id: row.id,
        action: row.action,
        status: row.status,
        blockCode: row.block_code,
        createdAt: row.created_at,
      })),
      latestTrades: trades.slice(0, 5).map((row) => ({
        id: row.id,
        signalId: row.signal_id,
        side: row.side,
        amount: Number(row.amount || 0),
        price: Number(row.price || 0),
        totalUsdt: Number(row.total_usdt || 0),
        executedAt: row.executed_at,
      })),
      latestJournals: journals.slice(0, 5).map((row) => ({
        tradeId: row.trade_id,
        signalId: row.signal_id,
        status: row.status,
        entrySize: Number(row.entry_size || 0),
        entryValue: Number(row.entry_value || 0),
        exitValue: Number(row.exit_value || 0),
        createdAt: row.created_at,
      })),
    },
    recommendedSteps: buildRecommendedSteps({ signalRows, parityClass, walletQty, positionQty, journalQty }),
  };
}

async function loadOpenJournal(symbol, exchange) {
  const rows = await db.query(
    `SELECT
       COALESCE(SUM(entry_size), 0) AS open_size,
       COALESCE(SUM(entry_value), 0) AS open_value,
       COUNT(*)::int AS open_count
     FROM investment.trade_journal
     WHERE symbol = $1 AND exchange = $2 AND is_paper = false AND status = 'open'`,
    [symbol, exchange],
  ).catch(() => []);
  return rows[0] || {};
}

async function loadContext({ symbol = DEFAULT_SYMBOL, exchange = 'binance', hours = 72, limit = 20 } = {}) {
  await db.initSchema().catch(() => {});
  await initJournalSchema().catch(() => {});
  const [position, recentSignalRows, manualSignalRows, trades, journals, openJournal] = await Promise.all([
    db.getPosition(symbol, { exchange, paper: false }).catch(() => null),
    db.query(
      `SELECT id, symbol, action, status, block_code, block_meta, created_at
       FROM signals
       WHERE symbol = $1 AND exchange = $2 AND created_at >= now() - ($3::int * INTERVAL '1 hour')
       ORDER BY created_at DESC
       LIMIT $4`,
      [symbol, exchange, Math.max(1, Number(hours || 72)), Math.max(1, Number(limit || 20))],
    ).catch(() => []),
    db.query(
      `SELECT id, symbol, action, status, block_code, block_meta, created_at
       FROM signals
       WHERE symbol = $1 AND exchange = $2 AND block_code = 'manual_reconcile_required'
       ORDER BY created_at DESC
       LIMIT $3`,
      [symbol, exchange, Math.max(1, Number(limit || 20))],
    ).catch(() => []),
    db.query(
      `SELECT *
       FROM trades
       WHERE symbol = $1 AND exchange = $2 AND paper = false
       ORDER BY executed_at DESC
       LIMIT $3`,
      [symbol, exchange, Math.max(1, Number(limit || 20))],
    ).catch(() => []),
    db.query(
      `SELECT *
       FROM investment.trade_journal
       WHERE symbol = $1 AND exchange = $2 AND is_paper = false
       ORDER BY created_at DESC
       LIMIT $3`,
      [symbol, exchange, Math.max(1, Number(limit || 20))],
    ).catch(() => []),
    loadOpenJournal(symbol, exchange),
  ]);
  const signalRows = [...manualSignalRows, ...recentSignalRows]
    .filter((row, index, all) => all.findIndex((candidate) => candidate.id === row.id) === index);
  let wallet = {};
  let lastPrice = 0;
  if (exchange === 'binance') {
    const asset = baseAsset(symbol);
    const balance = await getBinanceBalanceSnapshot({ omitZeroBalances: false }).catch(() => ({}));
    wallet = {
      total: Number(balance?.total?.[asset] || 0),
      free: Number(balance?.free?.[asset] || 0),
      used: Number(balance?.used?.[asset] || 0),
    };
    lastPrice = await getTickerLastPrice(symbol).catch(() => 0);
  }
  return { symbol, exchange, wallet, position, openJournal, signalRows, trades, journals, lastPrice };
}

export async function buildLunaManualReconcileAssistant(options = {}) {
  const context = await loadContext(options);
  return buildManualReconcileAssistantFromSnapshots(context);
}

export function renderLunaManualReconcileAssistant(report = {}) {
  return [
    '🧰 Luna manual reconcile assistant',
    `status: ${report.status || 'unknown'} / ${report.exchange || 'n/a'} / ${report.symbol || 'n/a'}`,
    `blockers: ${(report.blockers || []).length ? report.blockers.join(' / ') : 'none'}`,
    `parity: ${report.parity?.class || 'unknown'} / wallet=${report.parity?.walletQty ?? 'n/a'} / position=${report.parity?.positionQty ?? 'n/a'} / journal=${report.parity?.openJournalQty ?? 'n/a'} / value=${report.parity?.walletValueUsdt ?? 'n/a'} USDT`,
    `evidence: signals=${report.evidence?.signalCount ?? 0} / manual=${report.evidence?.manualReconcileSignals ?? 0} / trades=${report.evidence?.tradeCount ?? 0} / journals=${report.evidence?.journalCount ?? 0}`,
    `next: ${(report.recommendedSteps || [])[0] || 'none'}`,
  ].join('\n');
}

export async function publishLunaManualReconcileAssistant(report = {}) {
  return publishAlert({
    from_bot: 'luna',
    event_type: 'report',
    alert_level: report.ok ? 1 : 2,
    message: renderLunaManualReconcileAssistant(report),
    payload: report,
  });
}

export async function runLunaManualReconcileAssistantSmoke() {
  const clear = buildManualReconcileAssistantFromSnapshots({
    symbol: 'LUNC/USDT',
    wallet: { total: 10, free: 10, used: 0 },
    position: { amount: 10, avg_price: 0.0001 },
    openJournal: { open_size: 10, open_value: 0.001, open_count: 1 },
    lastPrice: 0.00011,
    signalRows: [],
  });
  assert.equal(clear.ok, true);
  const blocked = buildManualReconcileAssistantFromSnapshots({
    symbol: 'LUNC/USDT',
    wallet: { total: 100, free: 100, used: 0 },
    position: { amount: 0, avg_price: 0 },
    openJournal: { open_size: 0, open_value: 0, open_count: 0 },
    lastPrice: 0.2,
    signalRows: [{ id: 'sig-1', block_code: 'manual_reconcile_required' }],
  });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.blockers.includes('manual_reconcile_signal_present'));
  return { ok: true, clear, blocked };
}

async function main() {
  const json = hasFlag('--json');
  const smoke = hasFlag('--smoke');
  const telegram = hasFlag('--telegram');
  const symbol = argValue('--symbol', DEFAULT_SYMBOL);
  const exchange = argValue('--exchange', 'binance');
  const hours = Number(argValue('--hours', 72));
  const limit = Number(argValue('--limit', 20));
  const report = smoke ? await runLunaManualReconcileAssistantSmoke() : await buildLunaManualReconcileAssistant({ symbol, exchange, hours, limit });
  if (telegram && !smoke) await publishLunaManualReconcileAssistant(report);
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log(smoke ? 'luna manual reconcile assistant smoke ok' : renderLunaManualReconcileAssistant(report));
  if (!smoke && hasFlag('--fail-on-blocked') && report.ok === false) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna manual reconcile assistant 실패:',
  });
}
