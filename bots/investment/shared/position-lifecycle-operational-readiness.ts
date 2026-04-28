// @ts-nocheck

import {
  POSITION_STAGE_IDS,
  POSITION_STAGE_LABELS,
  buildPositionScopeKey,
} from './lifecycle-contract.ts';

const DEFAULT_REQUIRED_STAGES = [...POSITION_STAGE_IDS];

function normalizeStageId(value) {
  const normalized = String(value || '').trim();
  return DEFAULT_REQUIRED_STAGES.includes(normalized) ? normalized : null;
}

function profileScope(profile = {}) {
  const symbol = profile.symbol || profile?.strategy_state?.symbol;
  const exchange = profile.exchange || profile?.strategy_state?.exchange;
  const tradeMode = profile.trade_mode || profile.tradeMode || profile?.strategy_state?.tradeMode || 'normal';
  if (!symbol || !exchange) return null;
  return buildPositionScopeKey(symbol, exchange, tradeMode);
}

export function summarizeLifecycleStageCoverage({
  events = [],
  activeProfiles = [],
  requiredStages = DEFAULT_REQUIRED_STAGES,
} = {}) {
  const stageSetByScope = new Map();
  for (const event of events || []) {
    const scope = event?.position_scope_key || event?.positionScopeKey || (
      event?.symbol && event?.exchange
        ? buildPositionScopeKey(event.symbol, event.exchange, event.trade_mode || event.tradeMode || 'normal')
        : null
    );
    const stageId = normalizeStageId(event?.stage_id || event?.stageId);
    if (!scope || !stageId) continue;
    if (!stageSetByScope.has(scope)) stageSetByScope.set(scope, new Set());
    stageSetByScope.get(scope).add(stageId);
  }

  const rows = (activeProfiles || [])
    .map((profile) => {
      const scope = profileScope(profile);
      if (!scope) return null;
      const covered = stageSetByScope.get(scope) || new Set();
      const missingStages = requiredStages.filter((stageId) => !covered.has(stageId));
      return {
        positionScopeKey: scope,
        symbol: profile.symbol || null,
        exchange: profile.exchange || null,
        tradeMode: profile.trade_mode || profile.tradeMode || 'normal',
        coveredStages: requiredStages.filter((stageId) => covered.has(stageId)),
        missingStages,
        missingLabels: missingStages.map((stageId) => POSITION_STAGE_LABELS[stageId] || stageId),
        coveragePct: requiredStages.length > 0
          ? Math.round(((requiredStages.length - missingStages.length) / requiredStages.length) * 1000) / 10
          : 100,
      };
    })
    .filter(Boolean);

  const totalExpected = rows.length * requiredStages.length;
  const totalCovered = rows.reduce((sum, row) => sum + row.coveredStages.length, 0);
  const missingByStage = requiredStages.reduce((acc, stageId) => {
    acc[stageId] = rows.filter((row) => row.missingStages.includes(stageId)).length;
    return acc;
  }, {});

  return {
    ok: rows.every((row) => row.missingStages.length === 0),
    activePositions: rows.length,
    requiredStages,
    coveragePct: totalExpected > 0 ? Math.round((totalCovered / totalExpected) * 1000) / 10 : 100,
    missingByStage,
    rows,
  };
}

export function summarizeLifecyclePositionSync(syncResults = []) {
  const results = Array.isArray(syncResults) ? syncResults : [];
  const failed = results.filter((item) => item?.ok === false);
  const mismatchCount = results.reduce((sum, item) => sum + Number(item?.mismatchCount || 0), 0);
  const skipped = results.filter((item) => item?.skipped === true).length;
  return {
    ok: failed.length === 0 && mismatchCount === 0,
    checkedMarkets: results.map((item) => item?.market).filter(Boolean),
    failedMarkets: failed.map((item) => item?.market || 'unknown'),
    mismatchCount,
    skipped,
    results,
  };
}

export function buildLifecycleExecutionReadiness({
  flags = null,
  runtimeReport = null,
  dispatchPreview = null,
  signalRefresh = null,
  positionSyncSummary = null,
  coverageSummary = null,
  requirePositionSync = false,
} = {}) {
  const blockers = [];
  const warnings = [];
  const mode = flags?.mode || 'shadow';

  if (mode !== 'autonomous_l5') {
    warnings.push(`position_lifecycle_mode_${mode}`);
  }
  if (flags?.phaseD?.enabled !== true) warnings.push('signal_refresh_disabled');
  if (flags?.phaseE?.enabled !== true) warnings.push('dynamic_position_sizing_disabled');
  if (flags?.phaseF?.enabled !== true) warnings.push('dynamic_trailing_disabled');
  if (flags?.phaseG?.enabled !== true) warnings.push('reflexive_portfolio_monitoring_disabled');
  if (flags?.phaseH?.enabled !== true) warnings.push('lifecycle_event_stream_disabled');

  const blockedActionable = Number(dispatchPreview?.guardReasonSummary?.blockedActionable || 0);
  if (blockedActionable > 0 && (dispatchPreview?.candidates || []).length === 0) {
    warnings.push(`dispatch_blocked_actionable_${blockedActionable}`);
  }

  if (signalRefresh?.ok === false) {
    blockers.push('signal_refresh_failed');
  }

  if (requirePositionSync) {
    if (!positionSyncSummary) {
      blockers.push('position_sync_required_but_missing');
    } else if (positionSyncSummary.ok !== true) {
      blockers.push(`position_sync_mismatch_or_failure:${positionSyncSummary.mismatchCount || 0}`);
    }
  }

  const coveragePct = Number(coverageSummary?.coveragePct ?? 100);
  if (coverageSummary && coveragePct < 50) {
    warnings.push(`low_lifecycle_stage_coverage_${coveragePct}`);
  }

  const runtimeMetrics = runtimeReport?.decision?.metrics || {};
  return {
    ok: blockers.length === 0,
    status: blockers.length > 0
      ? 'position_lifecycle_operational_blocked'
      : warnings.length > 0
        ? 'position_lifecycle_operational_attention'
        : 'position_lifecycle_operational_ready',
    mode,
    blockers,
    warnings,
    metrics: {
      active: Number(runtimeMetrics.active || 0),
      adjustReady: Number(runtimeMetrics.adjustReady || 0),
      exitReady: Number(runtimeMetrics.exitReady || 0),
      dispatchCandidates: Array.isArray(dispatchPreview?.candidates) ? dispatchPreview.candidates.length : 0,
      blockedActionable,
      signalRefreshCount: Number(signalRefresh?.count || 0),
      lifecycleCoveragePct: coverageSummary?.coveragePct ?? null,
      positionSyncMismatchCount: positionSyncSummary?.mismatchCount ?? null,
    },
  };
}

export default {
  summarizeLifecycleStageCoverage,
  summarizeLifecyclePositionSync,
  buildLifecycleExecutionReadiness,
};
