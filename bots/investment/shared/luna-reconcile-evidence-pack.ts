// @ts-nocheck

import crypto from 'node:crypto';

const ACK_EVIDENCE_TTL_MINUTES = 30;

function asObject(value = {}) {
  return value && typeof value === 'object' ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function compact(value, fallback = null) {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((acc, key) => {
    acc[key] = stable(value[key]);
    return acc;
  }, {});
}

export function buildEvidenceHash(value = {}) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
}

export function buildAckEvidenceExpiry(checkedAt = new Date().toISOString(), ttlMinutes = ACK_EVIDENCE_TTL_MINUTES) {
  const base = new Date(checkedAt);
  return new Date(base.getTime() + Math.max(1, Number(ttlMinutes || ACK_EVIDENCE_TTL_MINUTES)) * 60_000).toISOString();
}

export function isRecentEvidence({ evidenceHash = null, expiresAt = null, now = new Date() } = {}) {
  const hashOk = /^[a-f0-9]{64}$/i.test(String(evidenceHash || ''));
  if (!hashOk) return { ok: false, reason: 'preflight_evidence_hash_invalid' };
  if (!expiresAt) return { ok: false, reason: 'preflight_evidence_expiry_missing' };
  const expiry = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiry)) return { ok: false, reason: 'preflight_evidence_expiry_invalid' };
  if (expiry <= now.getTime()) return { ok: false, reason: 'preflight_evidence_expired' };
  return { ok: true, reason: 'preflight_evidence_recent' };
}

export function buildAckPreflightEvidence({
  candidate = {},
  eligibility = {},
  lookup = {},
  checkedAt = new Date().toISOString(),
  ttlMinutes = ACK_EVIDENCE_TTL_MINUTES,
} = {}) {
  const classified = eligibility.classified || candidate || {};
  const identifiers = classified.identifiers || candidate.identifiers || {};
  const body = {
    type: 'manual_ack_preflight',
    signalId: candidate.id || classified.id || null,
    symbol: candidate.symbol || classified.symbol || null,
    action: candidate.action || classified.action || null,
    resolutionClass: classified.resolutionClass || null,
    clientOrderId: identifiers.clientOrderId || null,
    orderId: identifiers.orderId || null,
    lookupStatus: lookup.status || null,
    lookupErrorCode: lookup.lookupErrorCode || null,
    orderFound: lookup.orderFound === true,
    checkedAt,
    expiresAt: buildAckEvidenceExpiry(checkedAt, ttlMinutes),
  };
  return {
    ...body,
    evidenceHash: buildEvidenceHash(body),
  };
}

export function buildReconcileEvidenceTask(blocker = {}) {
  const identifiers = asObject(blocker.identifiers);
  const symbol = compact(blocker.symbol, compact(blocker.id, 'unknown'));
  const checkedAt = new Date().toISOString();
  const base = {
    id: blocker.id || null,
    symbol,
    action: blocker.action || null,
    blockCode: blocker.blockCode || null,
    resolutionClass: blocker.resolutionClass || null,
    severity: blocker.severity || null,
    identifiers: {
      orderId: identifiers.orderId || null,
      clientOrderId: identifiers.clientOrderId || null,
      recoveryErrorCode: identifiers.recoveryErrorCode || null,
    },
  };
  const evidenceEnvelope = (task) => {
    const body = {
      id: task.id,
      symbol: task.symbol,
      action: task.action,
      blockCode: task.blockCode,
      resolutionClass: task.resolutionClass,
      type: task.type,
      identifiers: task.identifiers,
      requiredEvidence: task.requiredEvidence,
      requiredSnapshots: task.requiredSnapshots || [],
      checkedAt,
    };
    return {
      ...task,
      checkedAt,
      evidenceHash: buildEvidenceHash(body),
      evidenceHashInput: body,
    };
  };
  if (blocker.acked || blocker.resolutionClass === 'acknowledged' || blocker.severity === 'acknowledged') {
    return {
      ...base,
      type: 'acknowledged_history',
      safeToAutomate: false,
      auditOnly: true,
      reconcileAck: blocker.reconcileAck || null,
    };
  }
  if (blocker.resolutionClass === 'exchange_lookup_retry') {
    return evidenceEnvelope({
      ...base,
      type: 'exchange_lookup_retry',
      safeToAutomate: false,
      requiredEvidence: [
        'fresh_exchange_lookup_result_by_client_order_id',
        'exchange_wallet_snapshot',
        'local_position_row',
        'trade_journal_row',
        'operator_resolution_note',
      ],
      requiredSnapshots: [
        'wallet_balance',
        'position_balance',
        'trade_journal',
        'exchange_order_lookup',
      ],
      nextCommand: `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-reconcile-ack-preflight -- --signal-id=${base.id || 'SIGNAL_ID'} --live-lookup --json`,
      repairCommand: `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-reconcile-found-order-repair -- --signal-id=${base.id || 'SIGNAL_ID'} --live-lookup --json`,
      manualFallbackCommand: `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-manual-reconcile-playbook -- --symbol=${symbol} --json`,
    });
  }
  if (blocker.resolutionClass === 'manual_ack_required') {
    return evidenceEnvelope({
      ...base,
      type: 'manual_ack_required',
      safeToAutomate: false,
      requiredEvidence: [
        'client_order_id_or_order_id',
        'fresh_exchange_lookup_result',
        'preflight_evidence_hash_or_operator_evidence_ref',
        'operator_ack_reason',
      ],
      nextCommand: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-reconcile-ack-preflight -- --live-lookup --json',
    });
  }
  return evidenceEnvelope({
    ...base,
    type: 'manual_reconcile_required',
    safeToAutomate: false,
    requiredEvidence: [
      'exchange_wallet_snapshot',
      'local_position_row',
      'trade_journal_row',
      'operator_resolution_note',
    ],
    requiredSnapshots: [
      'wallet_balance',
      'position_balance',
      'trade_journal',
    ],
    nextCommand: `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-manual-reconcile-playbook -- --symbol=${symbol} --json`,
  });
}

export function buildLunaReconcileEvidencePackFromReport(report = {}) {
  const tasks = asArray(report.blockers).map(buildReconcileEvidenceTask);
  const manualTasks = tasks.filter((task) => task.type === 'manual_reconcile_required');
  const ackTasks = tasks.filter((task) => task.type === 'manual_ack_required');
  const lookupRetryTasks = tasks.filter((task) => task.type === 'exchange_lookup_retry');
  const acknowledgedHistory = tasks.filter((task) => task.type === 'acknowledged_history');
  return {
    ok: manualTasks.length === 0 && ackTasks.length === 0 && lookupRetryTasks.length === 0,
    status: manualTasks.length || ackTasks.length || lookupRetryTasks.length
      ? 'reconcile_evidence_required'
      : 'reconcile_evidence_clear',
    checkedAt: report.checkedAt || new Date().toISOString(),
    exchange: report.exchange || null,
    summary: {
      total: tasks.length,
      manualReconcileRequired: manualTasks.length,
      manualAckRequired: ackTasks.length,
      exchangeLookupRetry: lookupRetryTasks.length,
      acknowledgedHistory: acknowledgedHistory.length,
    },
    manualTasks,
    ackTasks,
    lookupRetryTasks,
    acknowledgedHistory,
    tasks,
  };
}

export default {
  buildAckPreflightEvidence,
  buildEvidenceHash,
  buildLunaReconcileEvidencePackFromReport,
  buildReconcileEvidenceTask,
  isRecentEvidence,
};
