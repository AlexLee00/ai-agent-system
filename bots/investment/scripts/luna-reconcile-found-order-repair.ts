#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import * as db from '../shared/db.ts';
import { buildEvidenceHash } from '../shared/luna-reconcile-evidence-pack.ts';
import { classifyReconcileBlocker } from './luna-reconcile-blocker-report.ts';
import { verifyAckCandidateAgainstExchange } from './luna-reconcile-ack-preflight.ts';

const CONFIRM = 'luna-found-order-repair';
const QTY_EPSILON = 1e-8;
const COST_EPSILON_USDT = 0.05;

function hasFlag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function sideForAction(action = '') {
  return String(action || '').trim().toUpperCase() === 'BUY' ? 'buy' : 'sell';
}

function closeEnough(a, b, epsilon) {
  return Math.abs(toNumber(a) - toNumber(b)) <= epsilon;
}

function normalizeSignalRow(row = {}) {
  return {
    id: row.id || null,
    symbol: row.symbol || null,
    action: row.action || null,
    status: row.status || null,
    blockCode: row.block_code || row.blockCode || null,
    createdAt: row.created_at || row.createdAt || null,
  };
}

async function loadSignal(signalId) {
  await db.initSchema().catch(() => {});
  if (!signalId) return null;
  return db.getSignalById(signalId);
}

async function loadLocalArtifacts(signal = {}) {
  const side = sideForAction(signal.action);
  const [trades, journals, position] = await Promise.all([
    db.query(
      `SELECT id, signal_id, symbol, side, amount, price, total_usdt, paper, exchange, trade_mode, incident_link, executed_at
         FROM trades
        WHERE signal_id = $1
          AND symbol = $2
          AND side = $3
          AND exchange = $4
          AND paper = false
        ORDER BY executed_at DESC
        LIMIT 10`,
      [signal.id, signal.symbol, side, signal.exchange || 'binance'],
    ).catch(() => []),
    db.query(
      `SELECT *
         FROM investment.trade_journal
        WHERE signal_id = $1
          AND symbol = $2
          AND exchange = $3
          AND is_paper = false
        ORDER BY created_at DESC
        LIMIT 10`,
      [signal.id, signal.symbol, signal.exchange || 'binance'],
    ).catch(() => []),
    db.getPosition(signal.symbol, { exchange: signal.exchange || 'binance', paper: false }).catch(() => null),
  ]);
  return { trades, journals, position };
}

function findMatchingTrade({ trades = [], action = '', order = {} } = {}) {
  const side = sideForAction(action);
  const filled = toNumber(order.filled);
  const cost = toNumber(order.cost);
  return (trades || []).find((trade) => {
    if (String(trade.side || '').toLowerCase() !== side) return false;
    const amountOk = closeEnough(trade.amount, filled, Math.max(QTY_EPSILON, Math.abs(filled) * 0.001));
    const costOk = cost <= 0 || closeEnough(trade.total_usdt, cost, COST_EPSILON_USDT);
    return amountOk && costOk;
  }) || null;
}

function hasJournalCoverage({ journals = [], action = '' } = {}) {
  const expectedStatus = sideForAction(action) === 'sell' ? 'closed' : 'open';
  return (journals || []).some((row) => String(row.status || '').toLowerCase() === expectedStatus);
}

export function evaluateFoundOrderRepairReadiness({
  signal = {},
  preflight = {},
  localArtifacts = {},
} = {}) {
  const order = preflight.order || {};
  const blockers = [];
  if (!signal?.id) blockers.push('signal_target_missing');
  if (preflight.status !== 'order_found_block_ack') blockers.push(`exchange_order_not_verified:${preflight.status || 'unknown'}`);
  if (String(order.status || '').toLowerCase() !== 'closed') blockers.push(`exchange_order_not_closed:${order.status || 'unknown'}`);

  const matchingTrade = findMatchingTrade({
    trades: localArtifacts.trades || [],
    action: signal.action,
    order,
  });
  if (!matchingTrade) blockers.push('local_trade_row_missing_or_mismatch');

  const journalCovered = hasJournalCoverage({
    journals: localArtifacts.journals || [],
    action: signal.action,
  });
  if (!journalCovered) blockers.push('trade_journal_coverage_missing');

  const evidenceInput = {
    type: 'found_order_repair',
    signal: normalizeSignalRow(signal),
    order: {
      id: order.id || null,
      status: order.status || null,
      filled: toNumber(order.filled),
      cost: toNumber(order.cost),
    },
    matchingTrade: matchingTrade ? {
      id: matchingTrade.id || null,
      amount: toNumber(matchingTrade.amount),
      totalUsdt: toNumber(matchingTrade.total_usdt),
      executedAt: matchingTrade.executed_at || null,
    } : null,
    journalCoverage: {
      covered: journalCovered,
      rows: (localArtifacts.journals || []).slice(0, 5).map((row) => ({
        tradeId: row.trade_id || null,
        status: row.status || null,
      })),
    },
  };
  const ready = blockers.length === 0;
  return {
    ok: ready,
    status: ready ? 'found_order_repair_ready' : 'found_order_repair_blocked',
    readyToApply: ready,
    blockers,
    evidenceHash: buildEvidenceHash(evidenceInput),
    evidenceInput,
    matchingTrade: matchingTrade ? {
      id: matchingTrade.id || null,
      amount: toNumber(matchingTrade.amount),
      totalUsdt: toNumber(matchingTrade.total_usdt),
      executedAt: matchingTrade.executed_at || null,
    } : null,
    journalCovered,
  };
}

export async function runLunaFoundOrderRepair({
  signalId = null,
  exchange = 'binance',
  liveLookup = false,
  apply = false,
  confirm = '',
  repairedBy = null,
  reason = null,
  fetchOrder = null,
  localArtifacts = null,
} = {}) {
  const signal = await loadSignal(signalId);
  const target = signal ? normalizeSignalRow(signal) : null;
  const candidate = signal ? classifyReconcileBlocker(signal) : {};
  const preflight = signal
    ? await verifyAckCandidateAgainstExchange(candidate, {
      fetchOrder: fetchOrder || undefined,
      liveLookup,
    })
    : { ok: false, status: 'signal_target_missing', blockers: ['signal_target_missing'] };
  const artifacts = localArtifacts || (signal ? await loadLocalArtifacts({ ...signal, exchange }) : { trades: [], journals: [], position: null });
  const readiness = evaluateFoundOrderRepairReadiness({ signal: signal || {}, preflight, localArtifacts: artifacts });
  const result = {
    ok: readiness.ok,
    checkedAt: new Date().toISOString(),
    status: readiness.status,
    dryRun: !apply,
    applied: false,
    confirmRequired: CONFIRM,
    target,
    preflight: {
      status: preflight.status || null,
      blockers: preflight.blockers || [],
      order: preflight.order || null,
    },
    readiness,
    localArtifacts: {
      trades: (artifacts.trades || []).slice(0, 5).map((trade) => ({
        id: trade.id || null,
        side: trade.side || null,
        amount: toNumber(trade.amount),
        totalUsdt: toNumber(trade.total_usdt),
        executedAt: trade.executed_at || null,
      })),
      journals: (artifacts.journals || []).slice(0, 5).map((row) => ({
        tradeId: row.trade_id || null,
        status: row.status || null,
        entrySize: toNumber(row.entry_size),
        exitValue: toNumber(row.exit_value),
      })),
      position: artifacts.position ? {
        amount: toNumber(artifacts.position.amount),
        avgPrice: toNumber(artifacts.position.avg_price),
      } : null,
    },
    nextCommand: signalId
      ? `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-reconcile-found-order-repair -- --signal-id=${signalId} --live-lookup --apply --confirm=${CONFIRM} --reason=exchange_order_found_local_trade_journal_verified --json`
      : null,
  };

  if (!apply) return result;
  if (!readiness.ok) return { ...result, ok: false, applyBlockedReason: 'found_order_repair_not_ready' };
  if (confirm !== CONFIRM) return { ...result, ok: false, applyBlockedReason: 'confirm_required' };
  if (!reason) return { ...result, ok: false, applyBlockedReason: 'reason_required' };

  const repairMeta = {
    foundOrderRepair: {
      status: 'applied',
      appliedAt: new Date().toISOString(),
      appliedBy: repairedBy || process.env.USER || 'unknown',
      reason,
      evidenceHash: readiness.evidenceHash,
      previousStatus: signal.status || null,
      previousBlockCode: signal.block_code || null,
      order: preflight.order || null,
      matchingTrade: readiness.matchingTrade || null,
    },
    manualReconcileResolution: {
      status: 'resolved',
      resolvedAt: new Date().toISOString(),
      resolvedBy: repairedBy || process.env.USER || 'unknown',
      reason,
      evidence: 'exchange_order_found_local_trade_journal_verified',
      resolutionType: 'found_order_status_repair',
      evidenceHash: readiness.evidenceHash,
    },
  };
  await db.updateSignalBlock(signal.id, {
    status: 'executed',
    reason: '거래소 체결 및 로컬 trade/journal 기록 확인 — 실패 block 해소',
    code: 'order_found_repaired',
  });
  await db.mergeSignalBlockMeta(signal.id, repairMeta);
  return {
    ...result,
    ok: true,
    status: 'found_order_repair_applied',
    applied: true,
    repairMeta: repairMeta.foundOrderRepair,
  };
}

export async function runLunaFoundOrderRepairSmoke() {
  const signal = { id: 'sig-mega', symbol: 'MEGA/USDT', action: 'SELL', status: 'failed', block_code: 'broker_execution_error' };
  const ready = evaluateFoundOrderRepairReadiness({
    signal,
    preflight: { status: 'order_found_block_ack', order: { id: '20723926', status: 'closed', filled: 837.9, cost: 115.362072 } },
    localArtifacts: {
      trades: [{ id: 'trade-1', side: 'sell', amount: 837.9, total_usdt: 115.362072 }],
      journals: [{ trade_id: 'TRD-1', status: 'closed' }],
    },
  });
  assert.equal(ready.ok, true);
  assert.equal(ready.readyToApply, true);
  assert.match(ready.evidenceHash, /^[a-f0-9]{64}$/);

  const missingTrade = evaluateFoundOrderRepairReadiness({
    signal,
    preflight: { status: 'order_found_block_ack', order: { id: '20723926', status: 'closed', filled: 837.9, cost: 115.362072 } },
    localArtifacts: { trades: [], journals: [{ trade_id: 'TRD-1', status: 'closed' }] },
  });
  assert.equal(missingTrade.ok, false);
  assert.ok(missingTrade.blockers.includes('local_trade_row_missing_or_mismatch'));

  const notFound = evaluateFoundOrderRepairReadiness({
    signal,
    preflight: { status: 'order_absent_confirmed', order: null },
    localArtifacts: { trades: [{ id: 'trade-1', side: 'sell', amount: 837.9, total_usdt: 115.362072 }], journals: [{ trade_id: 'TRD-1', status: 'closed' }] },
  });
  assert.equal(notFound.ok, false);
  assert.ok(notFound.blockers.some((item) => item.startsWith('exchange_order_not_verified')));
  return { ok: true, ready, missingTrade, notFound };
}

async function main() {
  const json = hasFlag('--json');
  const smoke = hasFlag('--smoke');
  const result = smoke ? await runLunaFoundOrderRepairSmoke() : await runLunaFoundOrderRepair({
    signalId: argValue('--signal-id', null),
    exchange: argValue('--exchange', 'binance'),
    liveLookup: hasFlag('--live-lookup'),
    apply: hasFlag('--apply'),
    confirm: argValue('--confirm', ''),
    repairedBy: argValue('--repaired-by', process.env.USER || 'unknown'),
    reason: argValue('--reason', null),
  });
  if (json) console.log(JSON.stringify(result, null, 2));
  else if (smoke) console.log('luna reconcile found-order repair smoke ok');
  else {
    console.log(`${result.status} ok=${result.ok} applied=${result.applied === true}`);
    console.log(`blockers=${(result.readiness?.blockers || []).join(',') || 'none'}`);
    console.log(`next=${result.nextCommand || 'none'}`);
  }
  if (!smoke && hasFlag('--apply') && result.ok === false) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna reconcile found-order repair 실패:',
  });
}
