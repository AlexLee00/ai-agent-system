#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { isReconcileAcked, parseReconcileBlockMeta } from './luna-reconcile-blocker-report.ts';
import * as db from '../shared/db.ts';

const HARD_BLOCK_CODES = new Set([
  'manual_reconcile_required',
  'pending_reconcile_enqueue_failed',
  'broker_execution_error',
  'order_fill_unverified',
]);

const PENDING_BLOCK_CODES = new Set([
  'order_pending_reconcile',
  'partial_fill_pending',
  'btc_pair_post_order_reconcile_required',
]);

function hasFlag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function summarizeRows(rows = []) {
  const byStatus = {};
  const byBlockCode = {};
  let pendingReconcile = 0;
  let hardReconcile = 0;
  let acknowledged = 0;
  let firedEntryTriggers = 0;
  let executed = 0;
  for (const row of rows) {
    const status = String(row.status || 'unknown');
    const blockCode = String(row.block_code || '').trim() || 'none';
    const meta = parseReconcileBlockMeta(row.block_meta);
    byStatus[status] = (byStatus[status] || 0) + 1;
    byBlockCode[blockCode] = (byBlockCode[blockCode] || 0) + 1;
    if (isReconcileAcked(meta)) {
      acknowledged++;
      if (meta?.entryTrigger?.state === 'fired' || meta?.event_type === 'autonomous_action_executed') firedEntryTriggers++;
      if (status === 'executed') executed++;
      continue;
    }
    if (PENDING_BLOCK_CODES.has(blockCode)) pendingReconcile++;
    if (HARD_BLOCK_CODES.has(blockCode)) hardReconcile++;
    if (meta?.entryTrigger?.state === 'fired' || meta?.event_type === 'autonomous_action_executed') firedEntryTriggers++;
    if (status === 'executed') executed++;
  }
  return { total: rows.length, byStatus, byBlockCode, pendingReconcile, hardReconcile, acknowledged, firedEntryTriggers, executed };
}

async function loadRecentSignals({ exchange = 'binance', hours = 6, limit = 200 } = {}) {
  await db.initSchema().catch(() => {});
  return db.query(
    `SELECT id, symbol, action, status, block_code, block_meta, created_at
       FROM signals
      WHERE exchange = $1
        AND created_at >= now() - ($2::int * INTERVAL '1 hour')
      ORDER BY created_at DESC
      LIMIT $3`,
    [exchange, Math.max(1, Number(hours || 6)), Math.max(1, Number(limit || 200))],
  );
}

export async function buildLunaTradeReconciliationGate({
  exchange = 'binance',
  hours = 6,
  maxPendingReconcile = 5,
} = {}) {
  let rows = [];
  try {
    rows = await loadRecentSignals({ exchange, hours });
  } catch (error) {
    return {
      ok: false,
      checkedAt: new Date().toISOString(),
      status: 'trade_reconciliation_attention',
      exchange,
      hours,
      maxPendingReconcile,
      blockers: ['trade_reconciliation_query_failed'],
      summary: summarizeRows([]),
      topRows: [],
      queryError: error?.message || String(error),
    };
  }
  const summary = summarizeRows(rows);
  const blockers = [];
  if (summary.hardReconcile > 0) blockers.push(`hard_reconcile_required:${summary.hardReconcile}`);
  if (summary.pendingReconcile > Math.max(0, Number(maxPendingReconcile || 0))) {
    blockers.push(`pending_reconcile_backlog:${summary.pendingReconcile}/${maxPendingReconcile}`);
  }

  const topRows = rows
    .filter((row) => !isReconcileAcked(parseReconcileBlockMeta(row.block_meta)))
    .filter((row) => HARD_BLOCK_CODES.has(String(row.block_code || '')) || PENDING_BLOCK_CODES.has(String(row.block_code || '')))
    .slice(0, 12)
    .map((row) => ({
      id: row.id,
      symbol: row.symbol,
      status: row.status,
      blockCode: row.block_code,
      createdAt: row.created_at,
    }));

  return {
    ok: blockers.length === 0,
    checkedAt: new Date().toISOString(),
    status: blockers.length === 0 ? 'trade_reconciliation_clear' : 'trade_reconciliation_attention',
    exchange,
    hours,
    maxPendingReconcile,
    blockers,
    summary,
    topRows,
  };
}

export function renderLunaTradeReconciliationGate(report = {}) {
  return [
    '🧾 Luna trade reconciliation gate',
    `status: ${report.status || 'unknown'} / exchange=${report.exchange || 'n/a'} / ${report.hours || 6}h`,
    `blockers: ${(report.blockers || []).length ? report.blockers.join(' / ') : 'none'}`,
    `signals=${report.summary?.total ?? 'n/a'} / executed=${report.summary?.executed ?? 'n/a'} / pending=${report.summary?.pendingReconcile ?? 'n/a'} / hard=${report.summary?.hardReconcile ?? 'n/a'} / ack=${report.summary?.acknowledged ?? 'n/a'} / firedEntry=${report.summary?.firedEntryTriggers ?? 'n/a'}`,
  ].join('\n');
}

export async function runLunaTradeReconciliationGateSmoke() {
  const syntheticClear = summarizeRows([
    { status: 'executed', block_code: 'none', block_meta: { entryTrigger: { state: 'fired' } } },
  ]);
  assert.equal(syntheticClear.executed, 1);
  assert.equal(syntheticClear.firedEntryTriggers, 1);
  const syntheticBlocked = summarizeRows([
    { status: 'failed', block_code: 'manual_reconcile_required', block_meta: {} },
    { status: 'executed', block_code: 'order_pending_reconcile', block_meta: {} },
    {
      status: 'failed',
      block_code: 'manual_reconcile_required',
      block_meta: { reconcileAck: { status: 'acknowledged', ackedAt: '2026-01-01T00:00:00Z' } },
    },
  ]);
  assert.equal(syntheticBlocked.hardReconcile, 1);
  assert.equal(syntheticBlocked.pendingReconcile, 1);
  assert.equal(syntheticBlocked.acknowledged, 1);
  return { ok: true, syntheticClear, syntheticBlocked };
}

async function main() {
  const json = hasFlag('--json');
  const smoke = hasFlag('--smoke');
  const exchange = argValue('--exchange', 'binance');
  const hours = Number(argValue('--hours', 6));
  const maxPendingReconcile = Number(argValue('--max-pending-reconcile', process.env.LUNA_TRADE_RECONCILE_MAX_PENDING || 5));
  const report = smoke
    ? await runLunaTradeReconciliationGateSmoke()
    : await buildLunaTradeReconciliationGate({ exchange, hours, maxPendingReconcile });
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log(smoke ? 'luna trade reconciliation gate smoke ok' : renderLunaTradeReconciliationGate(report));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna trade reconciliation gate 실패:',
  });
}
