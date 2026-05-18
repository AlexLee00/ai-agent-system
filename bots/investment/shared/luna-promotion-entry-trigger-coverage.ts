// @ts-nocheck

function normalizeSymbol(value = '') {
  return String(value || '').trim().toUpperCase();
}

function parseTime(value) {
  const time = value ? Date.parse(String(value)) : NaN;
  return Number.isFinite(time) ? time : null;
}

function bool(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function triggerKey(row = {}) {
  return `${normalizeSymbol(row.symbol)}|${String(row.exchange || 'binance').trim().toLowerCase()}`;
}

function latestBySymbol(rows = []) {
  const map = new Map();
  for (const row of rows || []) {
    const key = triggerKey(row);
    const prev = map.get(key);
    const rowTime = parseTime(row.updated_at || row.created_at || row.observed_at) || 0;
    const prevTime = parseTime(prev?.updated_at || prev?.created_at || prev?.observed_at) || 0;
    if (!prev || rowTime >= prevTime) map.set(key, row);
  }
  return map;
}

function latestBridgeBySymbol(rows = []) {
  const map = new Map();
  for (const row of rows || []) {
    const key = triggerKey(row);
    const prev = map.get(key);
    const rowTime = parseTime(row.updated_at || row.created_at || row.promotion_observed_at || row.observed_at) || 0;
    const prevTime = parseTime(prev?.updated_at || prev?.created_at || prev?.promotion_observed_at || prev?.observed_at) || 0;
    if (!prev || rowTime >= prevTime) map.set(key, row);
  }
  return map;
}

function activeUnexpiredTriggers(rows = [], nowMs = Date.now()) {
  return (rows || []).filter((row) => {
    const state = String(row.trigger_state || '').toLowerCase();
    if (!['armed', 'waiting'].includes(state)) return false;
    const expiresAt = parseTime(row.expires_at);
    return expiresAt == null || expiresAt > nowMs;
  });
}

function summarizeLatestTrigger(row = null, nowMs = Date.now()) {
  if (!row) return null;
  const expiresAt = parseTime(row.expires_at);
  const expired = expiresAt != null && expiresAt <= nowMs;
  return {
    id: row.id || null,
    state: row.trigger_state || null,
    triggerType: row.trigger_type || null,
    confidence: number(row.confidence, null),
    predictiveScore: row.predictive_score == null ? null : number(row.predictive_score, null),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    expiresAt: row.expires_at || null,
    expired,
  };
}

function bridgePreview(row = {}) {
  return {
    symbol: normalizeSymbol(row.symbol),
    market: String(row.market || 'crypto').toLowerCase(),
    exchange: row.exchange || 'binance',
    action: 'BUY',
    source: 'paper_promotion_gate_shadow',
    confidence: number(row.avg_confidence ?? row.avgConfidence, 0),
    triggerType: 'mtf_alignment',
    setupType: 'promotion_ready_shadow',
    shadowOnly: true,
    liveMutationAllowed: false,
    requiredApproval: 'autonomous_shadow_entry_trigger_materialization_confirm_token',
  };
}

function summarizeBridge(row = null) {
  if (!row) return null;
  const status = row.bridge_status || row.bridgeStatus || null;
  const entryTriggerDbMutation = bool(row.entry_trigger_db_mutation ?? row.entryTriggerDbMutation);
  const liveMutation = bool(row.live_mutation ?? row.liveMutation);
  const materialized = status === 'active_entry_trigger_materialized';
  return {
    id: row.id || null,
    status,
    gapReason: materialized ? 'shadow_entry_trigger_materialized' : (row.gap_reason || row.gapReason || null),
    promotionObservedAt: row.promotion_observed_at || row.promotionObservedAt || null,
    promotionConfidence: number(row.promotion_confidence ?? row.promotionConfidence, null),
    triggerType: row.trigger_type || row.triggerType || null,
    proposedTriggerState: row.proposed_trigger_state || row.proposedTriggerState || null,
    updatedAt: row.updated_at || row.updatedAt || null,
    approvalRequired: materialized
      ? 'autonomous_shadow_entry_trigger_materialization_confirm_token'
      : (row.approval_required || row.approvalRequired || 'autonomous_shadow_entry_trigger_materialization_confirm_token'),
    shadowOnly: bool(row.shadow_only ?? row.shadowOnly ?? true),
    liveMutation,
    entryTriggerDbMutation,
    pendingMaterialization: status === 'shadow_bridge_pending_approval' && !entryTriggerDbMutation && !liveMutation,
  };
}

export function buildPromotionEntryTriggerCoverageReport({
  promotionRows = [],
  activeTriggerRows = [],
  latestTriggerRows = [],
  bridgeRows = [],
  now = new Date(),
  hours = 168,
  market = 'crypto',
  exchange = 'binance',
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const activeByKey = new Map();
  for (const row of activeUnexpiredTriggers(activeTriggerRows, nowMs)) {
    const key = triggerKey(row);
    const list = activeByKey.get(key) || [];
    list.push(row);
    activeByKey.set(key, list);
  }
  const latestByKey = latestBySymbol(latestTriggerRows);
  const bridgeByKey = latestBridgeBySymbol(bridgeRows);

  const candidates = (promotionRows || [])
    .filter((row) => bool(row.promotion_candidate ?? row.promotionCandidate))
    .map((row) => ({
      ...row,
      symbol: normalizeSymbol(row.symbol),
      exchange: row.exchange || exchange,
      market: row.market || market,
    }))
    .sort((a, b) => {
      const scoreGap = number(b.avg_confidence ?? b.avgConfidence, 0) - number(a.avg_confidence ?? a.avgConfidence, 0);
      if (scoreGap !== 0) return scoreGap;
      return normalizeSymbol(a.symbol).localeCompare(normalizeSymbol(b.symbol));
    });

  const rows = candidates.map((candidate) => {
    const key = triggerKey(candidate);
    const active = activeByKey.get(key) || [];
    const latest = latestByKey.get(key) || null;
    const bridge = bridgeByKey.get(key) || null;
    const bridgeSummary = summarizeBridge(bridge);
    const covered = active.length > 0;
    const latestSummary = summarizeLatestTrigger(latest, nowMs);
    const staged = !covered && bridgeSummary?.pendingMaterialization === true;
    const coverageStatus = covered
      ? 'covered_by_active_entry_trigger'
      : staged
        ? 'promotion_ready_staged_for_entry_trigger_materialization'
        : latestSummary
          ? 'promotion_ready_without_active_entry_trigger'
          : 'promotion_ready_without_entry_trigger_history';
    const gapReason = covered
      ? null
      : staged
        ? 'promotion_ready_shadow_materialization_pending'
        : 'promotion_ready_active_entry_trigger_missing';
    return {
      symbol: candidate.symbol,
      market: candidate.market,
      exchange: candidate.exchange,
      promotionDecision: candidate.decision || null,
      promotionCandidate: true,
      observedAt: candidate.observed_at || candidate.observedAt || null,
      cycleCount: number(candidate.cycle_count ?? candidate.cycleCount, 0),
      passCount: number(candidate.pass_count ?? candidate.passCount, 0),
      consecutivePasses: number(candidate.consecutive_passes ?? candidate.consecutivePasses, 0),
      avgConfidence: number(candidate.avg_confidence ?? candidate.avgConfidence, 0),
      activeTriggerCount: active.length,
      activeTriggerTypes: [...new Set(active.map((row) => row.trigger_type).filter(Boolean))],
      latestTrigger: latestSummary,
      bridge: bridgeSummary,
      coverageStatus,
      gapReason,
      bridgePreview: covered ? null : bridgePreview(candidate),
      recommendedCommand: covered
        ? `npm --prefix bots/investment run -s runtime:luna-entry-trigger-diagnose -- --json --symbols=${candidate.symbol}`
        : `npm --prefix bots/investment run -s runtime:luna-entry-trigger-diagnose -- --json --symbols=${candidate.symbol} && npm --prefix bots/investment run -s runtime:luna-hybrid-promotion-review -- --json --strict`,
    };
  });

  const uncovered = rows.filter((row) => row.activeTriggerCount === 0);
  const covered = rows.filter((row) => row.activeTriggerCount > 0);
  const staged = uncovered.filter((row) => row.bridge?.pendingMaterialization === true);
  const unstaged = uncovered.filter((row) => row.bridge?.pendingMaterialization !== true);

  return {
    ok: uncovered.length === 0,
    status: rows.length === 0
      ? 'luna_promotion_entry_trigger_coverage_no_candidates'
      : uncovered.length === 0
        ? 'luna_promotion_entry_trigger_coverage_clear'
        : unstaged.length === 0
          ? 'luna_promotion_entry_trigger_coverage_staged_pending_materialization'
          : 'luna_promotion_entry_trigger_coverage_attention',
    phase: 'luna_promotion_to_entry_trigger_coverage',
    shadowMode: true,
    liveMutation: false,
    protectedPidMutation: false,
    checkedAt: now.toISOString ? now.toISOString() : new Date(nowMs).toISOString(),
    market,
    exchange,
    hours,
    summary: {
      promotionCandidates: rows.length,
      coveredByActiveTrigger: covered.length,
      stagedPendingMaterialization: staged.length,
      unstagedMissingActiveTrigger: unstaged.length,
      missingActiveTrigger: uncovered.length,
      coverageRatio: rows.length ? Number((covered.length / rows.length).toFixed(4)) : 1,
      gapReasons: uncovered.reduce((acc, row) => {
        acc[row.gapReason] = (acc[row.gapReason] || 0) + 1;
        return acc;
      }, {}),
      liveMutation: false,
    },
    rows,
    blockers: uncovered.map((row) => ({
      type: row.bridge?.pendingMaterialization ? 'shadow_materialization_pending' : 'coverage',
      symbol: row.symbol,
      name: row.gapReason,
      detail: row.bridge?.pendingMaterialization
        ? `${row.symbol} is promotion-ready and staged in the bridge; autonomous shadow entry-trigger materialization has not inserted an active trigger yet.`
        : `${row.symbol} is promotion-ready but has no active unexpired entry trigger.`,
    })),
    requiredApproval: 'explicit_master_live_promotion_approval_for_any_live_priority_change',
    nextAction: uncovered.length > 0
      ? unstaged.length === 0
        ? 'run_autonomous_shadow_entry_trigger_materialization'
        : 'inspect_promotion_ready_entry_trigger_bridge_before_live_priority_change'
      : 'continue_entry_trigger_fire_readiness_monitoring',
  };
}

export default {
  buildPromotionEntryTriggerCoverageReport,
};
