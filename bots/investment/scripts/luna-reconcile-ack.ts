#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { publishAlert } from '../shared/alert-publisher.ts';
import * as db from '../shared/db.ts';
import {
  classifyReconcileBlocker,
  parseReconcileBlockMeta,
  isReconcileAcked,
} from './luna-reconcile-blocker-report.ts';
import { buildLunaReconcileBlockerReport } from './luna-reconcile-blocker-report.ts';
import { isRecentEvidence } from '../shared/luna-reconcile-evidence-pack.ts';

const CONFIRM = 'ack-luna-reconcile';

function hasFlag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function loadSignalTarget({ signalId = null, clientOrderId = null, exchange = 'binance' } = {}) {
  await db.initSchema().catch(() => {});
  if (signalId) {
    return db.getSignalById(signalId);
  }
  if (clientOrderId) {
    return db.get(
      `SELECT *
         FROM signals
        WHERE exchange = $1
          AND (
            block_meta->>'clientOrderId' = $2
            OR block_meta->'pendingReconcile'->>'clientOrderId' = $2
          )
        ORDER BY created_at DESC
        LIMIT 1`,
      [exchange, clientOrderId],
    );
  }
  return null;
}

export function evaluateReconcileAckEligibility(row = {}) {
  if (!row?.id) {
    return {
      ok: false,
      status: 'reconcile_ack_target_missing',
      blockers: ['signal_target_missing'],
    };
  }
  const meta = parseReconcileBlockMeta(row.block_meta);
  const classified = classifyReconcileBlocker(row);
  if (isReconcileAcked(meta)) {
    return {
      ok: true,
      status: 'reconcile_already_acknowledged',
      blockers: [],
      classified,
      existingAck: meta.reconcileAck,
    };
  }
  const recoveryText = String(classified.identifiers?.recoveryErrorCode || classified.identifiers?.recoveryError || '');
  const lookupRetryWithoutSubmittedOrder = classified.resolutionClass === 'exchange_lookup_retry'
    && classified.identifiers?.clientOrderId
    && classified.identifiers?.orderAttempted === false
    && !classified.identifiers?.submittedAtMs;
  const blockers = [];
  if (classified.resolutionClass !== 'manual_ack_required' && !lookupRetryWithoutSubmittedOrder) {
    blockers.push(`resolution_class_not_ackable:${classified.resolutionClass || 'unknown'}`);
  }
  if (classified.resolutionClass === 'manual_ack_required' && !recoveryText.includes('not_found')) {
    blockers.push('recovery_not_not_found');
  }
  if (!classified.identifiers?.clientOrderId) {
    blockers.push('client_order_id_missing');
  }
  return {
    ok: blockers.length === 0,
    status: blockers.length === 0
      ? lookupRetryWithoutSubmittedOrder
        ? 'reconcile_unsubmitted_lookup_ack_eligible'
        : 'reconcile_ack_eligible'
      : 'reconcile_ack_blocked',
    blockers,
    classified,
  };
}

function buildAckMeta({ row, eligibility, ackedBy, reason, evidence } = {}) {
  return {
    reconcileAck: {
      status: 'acknowledged',
      ackedAt: new Date().toISOString(),
      ackedBy: ackedBy || process.env.USER || 'unknown',
      reason,
      evidence,
      operatorEvidenceRef: evidence?.operatorEvidenceRef || null,
      preflightEvidenceHash: evidence?.preflightEvidenceHash || null,
      preflightExpiresAt: evidence?.preflightExpiresAt || null,
      previousBlockCode: row.block_code || null,
      previousStatus: row.status || null,
      resolutionClass: eligibility.classified?.resolutionClass || null,
      clientOrderId: eligibility.classified?.identifiers?.clientOrderId || null,
      orderId: eligibility.classified?.identifiers?.orderId || null,
    },
  };
}

export async function runLunaReconcileAck({
  signalId = null,
  clientOrderId = null,
  exchange = 'binance',
  apply = false,
  confirm = '',
  ackedBy = null,
  reason = null,
  evidence = null,
  preflightEvidenceHash = null,
  preflightExpiresAt = null,
  operatorEvidenceRef = null,
} = {}) {
  const row = await loadSignalTarget({ signalId, clientOrderId, exchange });
  const eligibility = evaluateReconcileAckEligibility(row);
  const result = {
    ok: eligibility.ok,
    checkedAt: new Date().toISOString(),
    status: eligibility.status,
    dryRun: !apply,
    applied: false,
    confirmRequired: CONFIRM,
    target: row ? {
      id: row.id,
      symbol: row.symbol,
      action: row.action,
      status: row.status,
      blockCode: row.block_code,
      createdAt: row.created_at,
    } : null,
    eligibility,
  };
  if (!apply) return result;
  if (!eligibility.ok) {
    return { ...result, ok: false, applyBlockedReason: 'ack_not_eligible' };
  }
  if (eligibility.status === 'reconcile_already_acknowledged') {
    return { ...result, applied: false, applyBlockedReason: 'already_acknowledged' };
  }
  if (confirm !== CONFIRM) {
    return { ...result, ok: false, applyBlockedReason: 'confirm_required' };
  }
  if (!reason || !evidence) {
    return { ...result, ok: false, applyBlockedReason: 'reason_and_evidence_required' };
  }
  const evidenceCheck = operatorEvidenceRef
    ? { ok: true, reason: 'operator_evidence_ref_present' }
    : isRecentEvidence({ evidenceHash: preflightEvidenceHash, expiresAt: preflightExpiresAt });
  if (!evidenceCheck.ok) {
    return {
      ...result,
      ok: false,
      applyBlockedReason: evidenceCheck.reason || 'preflight_evidence_or_operator_ref_required',
    };
  }
  const ackMeta = buildAckMeta({
    row,
    eligibility,
    ackedBy,
    reason,
    evidence: {
      note: evidence,
      operatorEvidenceRef,
      preflightEvidenceHash,
      preflightExpiresAt,
      evidenceCheck: evidenceCheck.reason,
    },
  });
  await db.mergeSignalBlockMeta(row.id, ackMeta);
  const after = await buildLunaReconcileBlockerReport({ exchange, hours: 24, limit: 100 });
  return {
    ...result,
    ok: true,
    status: 'reconcile_ack_applied',
    applied: true,
    ackMeta: ackMeta.reconcileAck,
    after: {
      status: after.status,
      summary: after.summary,
    },
  };
}

export function renderLunaReconcileAck(result = {}) {
  return [
    '✅ Luna reconcile ACK',
    `status: ${result.status || 'unknown'} / dryRun=${result.dryRun === true}`,
    `target: ${result.target?.symbol || 'n/a'} ${result.target?.action || 'n/a'} ${result.target?.id || 'n/a'}`,
    `blockers: ${(result.eligibility?.blockers || []).length ? result.eligibility.blockers.join(' / ') : 'none'}`,
    `applied: ${result.applied === true}`,
  ].join('\n');
}

export async function publishLunaReconcileAck(result = {}) {
  return publishAlert({
    from_bot: 'luna',
    event_type: 'report',
    alert_level: result.ok ? 1 : 2,
    message: renderLunaReconcileAck(result),
    payload: {
      checkedAt: result.checkedAt,
      status: result.status,
      target: result.target,
      eligibility: result.eligibility,
      after: result.after || null,
    },
  });
}

export async function runLunaReconcileAckSmoke() {
  const eligible = evaluateReconcileAckEligibility({
    id: 'sig-1',
    symbol: 'ORCA/USDT',
    action: 'BUY',
    status: 'failed',
    block_code: 'manual_reconcile_required',
    block_meta: {
      clientOrderId: 'client-1',
      recoveryErrorCode: 'binance_order_lookup_not_found',
    },
  });
  assert.equal(eligible.ok, true);
  const unsubmittedLookup = evaluateReconcileAckEligibility({
    id: 'sig-lookup',
    symbol: 'UTK/USDT',
    action: 'BUY',
    status: 'failed',
    block_code: 'broker_execution_error',
    block_meta: {
      clientOrderId: 'client-lookup',
      orderAttempted: false,
    },
  });
  assert.equal(unsubmittedLookup.ok, true);
  assert.equal(unsubmittedLookup.status, 'reconcile_unsubmitted_lookup_ack_eligible');
  const submittedLookup = evaluateReconcileAckEligibility({
    id: 'sig-submitted',
    symbol: 'UTK/USDT',
    action: 'BUY',
    status: 'failed',
    block_code: 'broker_execution_error',
    block_meta: {
      clientOrderId: 'client-submitted',
      orderAttempted: true,
      submittedAtMs: 1777817066755,
    },
  });
  assert.equal(submittedLookup.ok, false);
  assert.ok(submittedLookup.blockers.includes('resolution_class_not_ackable:exchange_lookup_retry'));
  const blocked = evaluateReconcileAckEligibility({
    id: 'sig-2',
    symbol: 'LUNC/USDT',
    action: 'BUY',
    status: 'executed',
    block_code: 'manual_reconcile_required',
    block_meta: {},
  });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.blockers.includes('resolution_class_not_ackable:manual_reconcile_required'));
  const evidenceBlocked = await runLunaReconcileAck({
    apply: true,
    confirm: CONFIRM,
    reason: 'operator_verified_absent_order',
    evidence: 'binance_client_order_lookup_not_found',
    signalId: 'missing-smoke',
  });
  assert.equal(evidenceBlocked.ok, false);
  assert.equal(evidenceBlocked.applyBlockedReason, 'ack_not_eligible');
  const expired = isRecentEvidence({
    evidenceHash: 'a'.repeat(64),
    expiresAt: '2026-01-01T00:00:00.000Z',
    now: new Date('2026-01-01T00:01:00.000Z'),
  });
  assert.equal(expired.ok, false);
  return { ok: true, eligible, blocked, evidenceBlocked };
}

async function main() {
  const json = hasFlag('--json');
  const smoke = hasFlag('--smoke');
  const telegram = hasFlag('--telegram');
  const apply = hasFlag('--apply');
  const signalId = argValue('--signal-id', null);
  const clientOrderId = argValue('--client-order-id', null);
  const exchange = argValue('--exchange', 'binance');
  const confirm = argValue('--confirm', '');
  const ackedBy = argValue('--acked-by', process.env.USER || 'unknown');
  const reason = argValue('--reason', null);
  const evidence = argValue('--evidence', null);
  const preflightEvidenceHash = argValue('--preflight-evidence-hash', null);
  const preflightExpiresAt = argValue('--preflight-expires-at', null);
  const operatorEvidenceRef = argValue('--operator-evidence-ref', null);
  const result = smoke
    ? await runLunaReconcileAckSmoke()
    : await runLunaReconcileAck({
      signalId,
      clientOrderId,
      exchange,
      apply,
      confirm,
      ackedBy,
      reason,
      evidence,
      preflightEvidenceHash,
      preflightExpiresAt,
      operatorEvidenceRef,
    });
  if (telegram && !smoke) await publishLunaReconcileAck(result);
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(smoke ? 'luna reconcile ack smoke ok' : renderLunaReconcileAck(result));
  if (!smoke && apply && result.ok === false) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna reconcile ack 실패:',
  });
}
