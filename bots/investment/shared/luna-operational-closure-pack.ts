// @ts-nocheck

const RECONCILE_MANUAL_CLASSES = new Set([
  'manual_reconcile_required',
  'pending_without_lookup_key',
]);

function uniq(items = []) {
  return [...new Set(items.filter(Boolean).map((item) => String(item)))];
}

function compact(value, fallback = null) {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function buildManualTaskFromReconcile(blocker = {}) {
  const resolutionClass = compact(blocker.resolutionClass, 'manual_review');
  const identifier = blocker.identifiers || {};
  const symbol = compact(blocker.symbol, compact(blocker.id, 'unknown'));
  return {
    type: RECONCILE_MANUAL_CLASSES.has(resolutionClass) ? 'manual_reconcile_required' : 'manual_review_required',
    id: blocker.id || null,
    symbol,
    action: blocker.action || null,
    blockCode: blocker.blockCode || null,
    resolutionClass,
    safeToAutomate: false,
    requiredEvidence: [
      'exchange_wallet_snapshot',
      'local_position_row',
      'trade_journal_row',
      'operator_resolution_note',
    ],
    identifiers: {
      orderId: identifier.orderId || null,
      clientOrderId: identifier.clientOrderId || null,
      recoveryErrorCode: identifier.recoveryErrorCode || null,
    },
    nextCommand: `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-manual-reconcile-playbook -- --symbol=${symbol}`,
  };
}

export function buildSafeAckCandidate(blocker = {}) {
  const identifier = blocker.identifiers || {};
  const hasLookupKey = Boolean(identifier.orderId || identifier.clientOrderId);
  const lookupSaysAbsent = String(identifier.recoveryErrorCode || identifier.recoveryError || '').includes('not_found');
  return {
    type: 'manual_ack_required',
    id: blocker.id || null,
    symbol: blocker.symbol || null,
    action: blocker.action || null,
    blockCode: blocker.blockCode || null,
    safeAck: false,
    reason: hasLookupKey && lookupSaysAbsent
      ? 'lookup_absence_observed_but_operator_evidence_required'
      : 'live_lookup_or_operator_evidence_required',
    requiredEvidence: [
      'client_order_id_or_order_id',
      'fresh_exchange_lookup_result',
      'operator_ack_reason',
      'ack_evidence_reference',
    ],
    identifiers: {
      orderId: identifier.orderId || null,
      clientOrderId: identifier.clientOrderId || null,
      recoveryErrorCode: identifier.recoveryErrorCode || null,
    },
    nextCommand: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-reconcile-ack-preflight -- --live-lookup',
  };
}

export function buildAcknowledgedHistory(blocker = {}) {
  return {
    type: 'acknowledged_history',
    id: blocker.id || null,
    symbol: blocker.symbol || null,
    blockCode: blocker.blockCode || null,
    acknowledgedAt: blocker.reconcileAck?.ackedAt || null,
    acknowledgedBy: blocker.reconcileAck?.ackedBy || blocker.reconcileAck?.actor || null,
    auditOnly: true,
  };
}

export function buildAgentMessageBusHygienePlan(busHygiene = {}) {
  const before = busHygiene.before || busHygiene || {};
  const staleCount = Number(before.staleCount || busHygiene.staleCount || 0);
  if (busHygiene.ok === false) {
    return [{
      type: 'hygiene_warning',
      category: 'query_failed',
      staleCount: 0,
      safeToApply: false,
      dryRunOnly: true,
      reason: busHygiene.error || before.error || 'agent_message_bus_hygiene_query_failed',
      nextCommand: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:agent-message-bus-hygiene -- --dry-run --json',
    }];
  }
  if (staleCount <= 0) return [];
  return [{
    type: 'hygiene_warning',
    category: 'stale_agent_messages',
    staleCount,
    safeToApply: false,
    dryRunOnly: true,
    staleHours: Number(before.staleHours || busHygiene.staleHours || 6),
    rows: asArray(before.rows).slice(0, 10),
    reason: 'stale messages should be reviewed in dry-run before explicit confirmed expiry',
    nextCommand: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:agent-message-bus-hygiene -- --dry-run --json',
    applyCommand: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:agent-message-bus-hygiene -- --apply --confirm=luna-agent-bus-hygiene --json',
  }];
}

function buildPendingObservation({ sevenDay = {}, fullIntegration = {}, voyager = {} } = {}) {
  return uniq([
    ...asArray(sevenDay.pendingReasons).map((item) => `7day:${item}`),
    ...asArray(fullIntegration.pendingObservation || fullIntegration.outstandingTasks).map((item) => `100_percent:${item}`),
    ...(voyager.pendingReason ? [`voyager:${voyager.pendingReason}`] : []),
  ]);
}

function buildNextActions({
  manualTasks = [],
  safeAckCandidates = [],
  hygieneTasks = [],
  pendingObservation = [],
  cutover = {},
} = {}) {
  const actions = [];
  if (manualTasks.length > 0) actions.push('complete manual wallet/journal/position reconcile evidence, then rerun operational blocker pack');
  if (safeAckCandidates.length > 0) actions.push('run live lookup/ack preflight and apply ACK only with explicit evidence and confirm');
  if (hygieneTasks.length > 0) actions.push('run agent message bus hygiene dry-run; apply only with --confirm=luna-agent-bus-hygiene');
  if (pendingObservation.some((item) => item.includes('voyager') || item.includes('skill'))) actions.push('wait for natural reflexion count or use validation fixture without production skill promotion');
  if (pendingObservation.some((item) => item.includes('7day') || item.includes('reflexion'))) actions.push('continue natural 7-day observation before operational-complete status');
  if (cutover.ok === false) actions.push('keep launchd cutover blocked until readiness pack has no blockers');
  if (actions.length === 0) actions.push('operator pack clear; live cutover still requires separate master approval');
  return uniq(actions);
}

export function buildLunaOperationalClosurePackFromReports({
  closure = {},
  reconcile = {},
  liveFire = {},
  sevenDay = {},
  fullIntegration = {},
  busHygiene = {},
  voyager = {},
  cutover = {},
} = {}) {
  const blockers = asArray(reconcile.blockers);
  const manualTasks = blockers
    .filter((item) => !item.acked && RECONCILE_MANUAL_CLASSES.has(compact(item.resolutionClass, 'manual_review')))
    .map(buildManualTaskFromReconcile);
  const safeAckCandidates = blockers
    .filter((item) => !item.acked && item.resolutionClass === 'manual_ack_required')
    .map(buildSafeAckCandidate);
  const acknowledgedHistory = blockers
    .filter((item) => item.acked || item.resolutionClass === 'acknowledged' || item.severity === 'acknowledged')
    .map(buildAcknowledgedHistory);
  const hygieneTasks = buildAgentMessageBusHygienePlan(busHygiene);
  const pendingObservation = buildPendingObservation({ sevenDay, fullIntegration, voyager });
  const hardBlockers = uniq([
    ...asArray(closure.hardBlockers),
    ...manualTasks.map((item) => `manual:${item.symbol}:${item.resolutionClass}`),
  ]);
  const status = hardBlockers.length > 0 || manualTasks.length > 0 || safeAckCandidates.length > 0
    ? 'operational_blocked'
    : pendingObservation.length > 0
      ? 'operational_pending'
      : hygieneTasks.length > 0
        ? 'operational_warning'
        : 'operational_clear';
  return {
    ok: status === 'operational_clear',
    status,
    hardBlockers,
    safeAckCandidates,
    manualTasks,
    hygieneTasks,
    acknowledgedHistory,
    pendingObservation,
    nextActions: buildNextActions({ manualTasks, safeAckCandidates, hygieneTasks, pendingObservation, cutover }),
    evidence: {
      closure: {
        ok: closure.ok === true,
        operationalStatus: closure.operationalStatus || null,
        codeComplete: closure.codeComplete !== false,
      },
      reconcile: {
        status: reconcile.status || null,
        summary: reconcile.summary || {},
      },
      liveFire: {
        status: liveFire.status || null,
        blockers: asArray(liveFire.blockers),
      },
      busHygiene: {
        status: busHygiene.status || null,
        staleCount: Number(busHygiene.before?.staleCount || busHygiene.staleCount || 0),
        dryRun: busHygiene.action?.dryRun ?? true,
      },
      voyager: {
        status: voyager.status || null,
        naturalDataReady: voyager.naturalDataReady ?? voyager.readyForExtraction ?? false,
        fixtureUsed: voyager.validationFixture?.fixtureUsed === true,
        productionSkillPromoted: voyager.validationFixture?.productionSkillPromoted === true,
      },
      cutover: {
        status: cutover.status || null,
        ok: cutover.ok ?? null,
        blockers: asArray(cutover.blockers),
      },
    },
  };
}

export default {
  buildAcknowledgedHistory,
  buildAgentMessageBusHygienePlan,
  buildLunaOperationalClosurePackFromReports,
  buildManualTaskFromReconcile,
  buildSafeAckCandidate,
};
