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
  const classification = classifyAgentMessageBusHygiene(busHygiene);
  if (busHygiene.ok === false) {
    return [{
      type: 'hygiene_warning',
      category: 'query_failed',
      staleCount: 0,
      classification,
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
    classification,
    safeToApply: false,
    dryRunOnly: true,
    staleHours: Number(before.staleHours || busHygiene.staleHours || 6),
    rows: asArray(before.rows).slice(0, 10),
    reason: 'stale messages should be reviewed in dry-run before explicit confirmed expiry',
    nextCommand: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:agent-message-bus-hygiene -- --dry-run --json',
    applyCommand: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:agent-message-bus-hygiene -- --apply --confirm=luna-agent-bus-hygiene --json',
  }];
}

export function classifyAgentMessageBusHygiene(busHygiene = {}) {
  const before = busHygiene.before || busHygiene || {};
  if (busHygiene.ok === false || before.ok === false) {
    return {
      ok: false,
      safeExpire: 0,
      reviewRequired: 0,
      blocked: Number(before.staleCount || busHygiene.staleCount || 0),
      rows: asArray(before.rows).map((row) => ({
        ...row,
        hygieneClass: 'blocked',
        reason: 'hygiene_query_failed',
      })),
    };
  }
  const rows = asArray(before.rows).map((row) => {
    const toAgent = String(row.to_agent || row.toAgent || '').toLowerCase();
    const messageType = String(row.message_type || row.messageType || '').toLowerCase();
    const staleCount = Number(row.stale_count || row.staleCount || 0);
    if (toAgent === 'all' || toAgent === 'hermes') {
      return {
        ...row,
        staleCount,
        hygieneClass: 'review_required',
        reason: toAgent === 'all' ? 'broadcast_requires_operator_review' : 'hermes_query_requires_operator_review',
      };
    }
    if (messageType === 'query' || messageType === 'broadcast') {
      return {
        ...row,
        staleCount,
        hygieneClass: 'safe_expire',
        reason: 'stale_unresponded_message_can_be_expired_with_confirm',
      };
    }
    return {
      ...row,
      staleCount,
      hygieneClass: 'blocked',
      reason: 'unsupported_message_type',
    };
  });
  return {
    ok: true,
    safeExpire: rows.filter((row) => row.hygieneClass === 'safe_expire').reduce((sum, row) => sum + Number(row.staleCount || 0), 0),
    reviewRequired: rows.filter((row) => row.hygieneClass === 'review_required').reduce((sum, row) => sum + Number(row.staleCount || 0), 0),
    blocked: rows.filter((row) => row.hygieneClass === 'blocked').reduce((sum, row) => sum + Number(row.staleCount || 0), 0),
    rows,
  };
}

export function buildCurriculumClosureTasks(curriculum = {}) {
  const toCreate = Number(curriculum.toCreate || 0);
  if (toCreate <= 0) return [];
  return [{
    type: 'curriculum_bootstrap_required',
    safeToApply: false,
    dryRunOnly: true,
    toCreate,
    totalAgents: Number(curriculum.totalAgents || 0),
    requiredConfirm: curriculum.requiredConfirm || 'luna-curriculum-bootstrap',
    nextCommand: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-curriculum-bootstrap -- --json',
    applyCommand: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-curriculum-bootstrap -- --apply --confirm=luna-curriculum-bootstrap --json',
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
  lookupRetryTasks = [],
  hygieneTasks = [],
  curriculumTasks = [],
  pendingObservation = [],
  cutover = {},
} = {}) {
  const actions = [];
  if (manualTasks.length > 0) actions.push('complete manual wallet/journal/position reconcile evidence, then rerun operational blocker pack');
  if (lookupRetryTasks.length > 0) actions.push('run exchange lookup retry evidence preflight; fallback to manual reconcile only if lookup remains ambiguous or order is found');
  if (safeAckCandidates.length > 0) actions.push('run live lookup/ack preflight and apply ACK only with explicit evidence and confirm');
  if (hygieneTasks.length > 0) actions.push('run agent message bus hygiene dry-run; apply only with --confirm=luna-agent-bus-hygiene');
  if (curriculumTasks.length > 0) actions.push('run curriculum bootstrap dry-run; apply only with --confirm=luna-curriculum-bootstrap');
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
  curriculum = {},
  reconcileEvidence = {},
  ackPreflight = {},
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
  const lookupRetryTasks = asArray(reconcileEvidence.lookupRetryTasks);
  const hygieneTasks = buildAgentMessageBusHygienePlan(busHygiene);
  const curriculumTasks = buildCurriculumClosureTasks(curriculum);
  const pendingObservation = buildPendingObservation({ sevenDay, fullIntegration, voyager });
  const hardBlockers = uniq([
    ...asArray(closure.hardBlockers),
    ...manualTasks.map((item) => `manual:${item.symbol}:${item.resolutionClass}`),
  ]);
  const status = hardBlockers.length > 0 || manualTasks.length > 0 || safeAckCandidates.length > 0
    ? 'operational_blocked'
    : pendingObservation.length > 0
      ? 'operational_pending'
      : hygieneTasks.length > 0 || curriculumTasks.length > 0
        ? 'operational_warning'
        : 'operational_clear';
  return {
    ok: status === 'operational_clear',
    status,
    hardBlockers,
    safeAckCandidates,
    manualTasks,
    hygieneTasks,
    curriculumTasks,
    acknowledgedHistory,
    pendingObservation,
    nextActions: buildNextActions({ manualTasks, safeAckCandidates, lookupRetryTasks, hygieneTasks, curriculumTasks, pendingObservation, cutover }),
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
      sevenDay: {
        status: sevenDay.status || null,
        criteria: sevenDay.criteria || {},
        pendingReasons: asArray(sevenDay.pendingReasons),
      },
      reconcileEvidence: {
        status: reconcileEvidence.status || null,
        summary: reconcileEvidence.summary || {},
        lookupRetryTasks: asArray(reconcileEvidence.lookupRetryTasks).map((task) => ({
          id: task.id || null,
          symbol: task.symbol || null,
          action: task.action || null,
          resolutionClass: task.resolutionClass || null,
          evidenceHash: task.evidenceHash || null,
          nextCommand: task.nextCommand || null,
          manualFallbackCommand: task.manualFallbackCommand || null,
        })),
      },
      ackPreflight: {
        status: ackPreflight.status || null,
        liveLookup: ackPreflight.liveLookup === true,
        summary: ackPreflight.summary || {},
      },
      busHygiene: {
        status: busHygiene.status || null,
        staleCount: Number(busHygiene.before?.staleCount || busHygiene.staleCount || 0),
        classification: classifyAgentMessageBusHygiene(busHygiene),
        dryRun: busHygiene.action?.dryRun ?? true,
      },
      curriculum: {
        status: curriculum.status || null,
        toCreate: Number(curriculum.toCreate || 0),
        dryRun: curriculum.dryRun !== false,
      },
      voyager: {
        status: voyager.status || null,
        naturalDataReady: voyager.naturalDataReady ?? voyager.readyForExtraction ?? false,
        fixtureUsed: voyager.validationFixture?.fixtureUsed === true,
        productionSkillPromoted: voyager.productionSkillPromoted === true,
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
  buildCurriculumClosureTasks,
  classifyAgentMessageBusHygiene,
  buildLunaOperationalClosurePackFromReports,
  buildManualTaskFromReconcile,
  buildSafeAckCandidate,
};
