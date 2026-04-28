#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { publishAlert } from '../shared/alert-publisher.ts';
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

export const RECONCILE_BLOCK_CODES = new Set([...HARD_BLOCK_CODES, ...PENDING_BLOCK_CODES]);

function hasFlag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

export function parseReconcileBlockMeta(value = null) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function isReconcileAcked(meta = {}) {
  const ack = meta?.reconcileAck || {};
  return ack?.status === 'acknowledged' && Boolean(ack?.ackedAt);
}

function pickIdentifier(meta = {}) {
  return {
    orderId: meta.orderId || meta.order_id || meta.pendingReconcile?.orderId || null,
    clientOrderId: meta.clientOrderId || meta.client_order_id || meta.pendingReconcile?.clientOrderId || null,
    recoveryErrorCode: meta.recoveryErrorCode || meta.pendingReconcile?.lastErrorCode || null,
    recoveryError: meta.recoveryError || meta.pendingReconcile?.lastError || null,
    orderAttempted: meta.orderAttempted === true || meta.pendingReconcile?.orderAttempted === true,
    submittedAtMs: meta.submittedAtMs || meta.pendingReconcile?.submittedAtMs || null,
  };
}

export function classifyReconcileBlocker(row = {}) {
  const meta = parseReconcileBlockMeta(row.block_meta);
  const id = pickIdentifier(meta);
  const blockCode = String(row.block_code || '').trim();
  const acked = isReconcileAcked(meta);
  const hasLookupKey = Boolean(id.orderId || id.clientOrderId);
  const notFound = String(id.recoveryErrorCode || id.recoveryError || '').includes('not_found');
  const ambiguous = String(id.recoveryErrorCode || id.recoveryError || '').includes('ambiguous');

  let severity = 'attention';
  let resolutionClass = 'manual_review';
  let recommendedAction = 'review_signal_and_exchange_history';

  if (acked) {
    severity = 'acknowledged';
    resolutionClass = 'acknowledged';
    recommendedAction = 'audit_only_already_acknowledged';
  } else if (HARD_BLOCK_CODES.has(blockCode)) {
    severity = 'hard_block';
    if (hasLookupKey && !notFound && !ambiguous) {
      resolutionClass = 'exchange_lookup_retry';
      recommendedAction = 'retry_exchange_lookup_then_requeue_or_ack';
    } else if (hasLookupKey && notFound) {
      resolutionClass = 'manual_ack_required';
      recommendedAction = 'verify_order_absent_by_client_order_id_then_mark_safe_or_manual_reconcile';
    } else {
      resolutionClass = 'manual_reconcile_required';
      recommendedAction = 'manual_wallet_journal_position_reconcile_required';
    }
  } else if (PENDING_BLOCK_CODES.has(blockCode)) {
    severity = 'pending';
    resolutionClass = hasLookupKey ? 'queue_retry_expected' : 'pending_without_lookup_key';
    recommendedAction = hasLookupKey ? 'let_pending_reconcile_worker_retry' : 'manual_reconcile_required_missing_lookup_key';
  }

  return {
    id: row.id,
    symbol: row.symbol,
    action: row.action,
    status: row.status,
    blockCode,
    severity,
    resolutionClass,
    recommendedAction,
    createdAt: row.created_at,
    identifiers: id,
    acked,
    reconcileAck: meta?.reconcileAck || null,
  };
}

function summarizeBlockers(blockers = []) {
  const byCode = {};
  const byResolutionClass = {};
  const bySeverity = {};
  for (const blocker of blockers) {
    byCode[blocker.blockCode] = (byCode[blocker.blockCode] || 0) + 1;
    byResolutionClass[blocker.resolutionClass] = (byResolutionClass[blocker.resolutionClass] || 0) + 1;
    bySeverity[blocker.severity] = (bySeverity[blocker.severity] || 0) + 1;
  }
  return {
    total: blockers.length,
    hard: bySeverity.hard_block || 0,
    pending: bySeverity.pending || 0,
    acknowledged: bySeverity.acknowledged || 0,
    byCode,
    byResolutionClass,
    bySeverity,
  };
}

async function loadBlockerRows({ exchange = 'binance', hours = 24, limit = 100 } = {}) {
  await db.initSchema().catch(() => {});
  return db.query(
    `SELECT id, symbol, action, status, block_code, block_meta, created_at
       FROM signals
      WHERE exchange = $1
        AND created_at >= now() - ($2::int * INTERVAL '1 hour')
        AND block_code = ANY($3::text[])
      ORDER BY created_at DESC
      LIMIT $4`,
    [exchange, Math.max(1, Number(hours || 24)), [...RECONCILE_BLOCK_CODES], Math.max(1, Number(limit || 100))],
  );
}

export async function buildLunaReconcileBlockerReport({
  exchange = 'binance',
  hours = 24,
  limit = 100,
} = {}) {
  try {
    const rows = await loadBlockerRows({ exchange, hours, limit });
    const blockers = rows.map(classifyReconcileBlocker);
    const summary = summarizeBlockers(blockers);
    return {
      ok: summary.hard === 0 && (summary.byResolutionClass.pending_without_lookup_key || 0) === 0,
      checkedAt: new Date().toISOString(),
      status: summary.total === 0 ? 'reconcile_blockers_clear' : 'reconcile_blockers_present',
      exchange,
      hours,
      limit,
      summary,
      blockers,
    };
  } catch (error) {
    return {
      ok: false,
      checkedAt: new Date().toISOString(),
      status: 'reconcile_blocker_query_failed',
      exchange,
      hours,
      limit,
      summary: summarizeBlockers([]),
      blockers: [],
      error: error?.message || String(error),
    };
  }
}

export function renderLunaReconcileBlockerReport(report = {}) {
  const top = (report.blockers || []).slice(0, 5).map((item) => (
    `${item.symbol} ${item.action}/${item.status} ${item.blockCode} -> ${item.resolutionClass}`
  ));
  return [
    '🧾 Luna reconcile blocker report',
    `status: ${report.status || 'unknown'} / exchange=${report.exchange || 'n/a'} / ${report.hours || 24}h`,
    `total=${report.summary?.total ?? 0} / hard=${report.summary?.hard ?? 0} / pending=${report.summary?.pending ?? 0}`,
    `classes: ${JSON.stringify(report.summary?.byResolutionClass || {})}`,
    ...(top.length ? ['top:', ...top] : ['top: none']),
  ].join('\n');
}

export async function publishLunaReconcileBlockerReport(report = {}) {
  return publishAlert({
    from_bot: 'luna',
    event_type: 'report',
    alert_level: report.ok ? 1 : 2,
    message: renderLunaReconcileBlockerReport(report),
    payload: {
      checkedAt: report.checkedAt,
      status: report.status,
      summary: report.summary,
      blockers: (report.blockers || []).slice(0, 10),
    },
  });
}

export async function runLunaReconcileBlockerReportSmoke() {
  const blocker = classifyReconcileBlocker({
    id: 'sig-1',
    symbol: 'ORCA/USDT',
    action: 'BUY',
    status: 'failed',
    block_code: 'manual_reconcile_required',
    block_meta: { clientOrderId: 'client-1', recoveryErrorCode: 'binance_order_lookup_not_found' },
    created_at: '2026-01-01T00:00:00Z',
  });
  assert.equal(blocker.resolutionClass, 'manual_ack_required');
  const pending = classifyReconcileBlocker({
    id: 'sig-2',
    symbol: 'BTC/USDT',
    action: 'BUY',
    status: 'executed',
    block_code: 'order_pending_reconcile',
    block_meta: { pendingReconcile: { clientOrderId: 'client-2' } },
    created_at: '2026-01-01T00:00:00Z',
  });
  assert.equal(pending.resolutionClass, 'queue_retry_expected');
  const acked = classifyReconcileBlocker({
    id: 'sig-3',
    symbol: 'ORCA/USDT',
    action: 'BUY',
    status: 'failed',
    block_code: 'manual_reconcile_required',
    block_meta: {
      clientOrderId: 'client-1',
      recoveryErrorCode: 'binance_order_lookup_not_found',
      reconcileAck: { status: 'acknowledged', ackedAt: '2026-01-01T00:00:00Z' },
    },
    created_at: '2026-01-01T00:00:00Z',
  });
  assert.equal(acked.resolutionClass, 'acknowledged');
  const summary = summarizeBlockers([blocker, pending, acked]);
  assert.equal(summary.acknowledged, 1);
  return { ok: true, blocker, pending, acked };
}

async function main() {
  const json = hasFlag('--json');
  const smoke = hasFlag('--smoke');
  const telegram = hasFlag('--telegram');
  const exchange = argValue('--exchange', 'binance');
  const hours = Number(argValue('--hours', 24));
  const limit = Number(argValue('--limit', 100));
  const report = smoke ? await runLunaReconcileBlockerReportSmoke() : await buildLunaReconcileBlockerReport({ exchange, hours, limit });
  if (telegram && !smoke) await publishLunaReconcileBlockerReport(report);
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log(smoke ? 'luna reconcile blocker report smoke ok' : renderLunaReconcileBlockerReport(report));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna reconcile blocker report 실패:',
  });
}
