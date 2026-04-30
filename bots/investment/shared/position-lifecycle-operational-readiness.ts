// @ts-nocheck

import {
  POSITION_STAGE_IDS,
  POSITION_STAGE_LABELS,
  buildPositionScopeKey,
} from './lifecycle-contract.ts';

const DEFAULT_REQUIRED_STAGES = [...POSITION_STAGE_IDS];
const DEFAULT_LATE_STAGES = ['stage_4', 'stage_5', 'stage_6', 'stage_7', 'stage_8'];
const ALWAYS_APPLICABLE_LATE_STAGES = ['stage_4', 'stage_5'];

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

function positionScope(position = {}) {
  const symbol = position.symbol || position?.strategy_state?.symbol;
  const exchange = position.exchange || position?.strategy_state?.exchange;
  const tradeMode = position.trade_mode || position.tradeMode || position?.strategy_state?.tradeMode || 'normal';
  if (!symbol || !exchange) return null;
  return buildPositionScopeKey(symbol, exchange, tradeMode);
}

function candidateScope(candidate = {}) {
  if (candidate?.positionId) return String(candidate.positionId);
  const symbol = candidate.symbol || candidate?.strategy_state?.symbol;
  const exchange = candidate.exchange || candidate?.strategy_state?.exchange;
  const tradeMode = candidate.trade_mode || candidate.tradeMode || candidate?.strategy_state?.tradeMode || 'normal';
  if (!symbol || !exchange) return null;
  return buildPositionScopeKey(symbol, exchange, tradeMode);
}

function buildActionableCandidateScopeSet(candidates = null) {
  if (!Array.isArray(candidates)) return null;
  const scopes = new Set();
  for (const candidate of candidates) {
    const action = String(candidate?.action || '').trim().toUpperCase();
    if (!action || action === 'HOLD' || action === 'SKIP') continue;
    const scope = candidateScope(candidate);
    if (scope) scopes.add(scope);
  }
  return scopes;
}

function profileLifecycleStatus(profile = {}) {
  return String(
    profile.lifecycle_status
      || profile.lifecycleStatus
      || profile?.strategy_state?.lifecycleStatus
      || profile?.strategyState?.lifecycleStatus
      || '',
  ).trim().toLowerCase();
}

function isClosedLifecycleStatus(status = '') {
  return [
    'closed',
    'position_closed',
    'exit_completed',
    'exited',
    'sold',
    'completed',
    'posttrade_review',
    'posttrade_completed',
    'feedback_learning',
  ].includes(String(status || '').trim().toLowerCase());
}

function applicableLateStagesForProfile({
  profile = {},
  scope,
  lateStages = DEFAULT_LATE_STAGES,
  covered = new Set(),
  actionableCandidateScopeSet = null,
} = {}) {
  const status = profileLifecycleStatus(profile);
  const closed = isClosedLifecycleStatus(status);
  return lateStages.filter((stageId) => {
    if (ALWAYS_APPLICABLE_LATE_STAGES.includes(stageId)) return true;
    if (covered.has(stageId)) return true;
    if (closed) return true;
    if (stageId === 'stage_6' && actionableCandidateScopeSet?.has(scope)) return true;
    return false;
  });
}

function scopeWithoutTradeMode(scope = '') {
  const parts = String(scope || '').split(':');
  return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : scope;
}

function positionNotionalUsdt(position = {}) {
  const amount = Number(position?.amount ?? position?.qty ?? position?.quantity ?? 0);
  const price = Number(position?.avg_price ?? position?.avgPrice ?? position?.price ?? 0);
  if (!Number.isFinite(amount) || !Number.isFinite(price)) return 0;
  return Math.abs(amount * price);
}

export function filterLifecycleCoverageProfiles({
  activeProfiles = [],
  livePositions = [],
  dustThresholdUsdt = 10,
  includeDust = false,
} = {}) {
  const liveScopeSet = new Set();
  const liveBaseScopeSet = new Set();
  const dustScopeSet = new Set();
  const dustBaseScopeSet = new Set();

  for (const position of livePositions || []) {
    const scope = positionScope(position);
    if (!scope) continue;
    const baseScope = scopeWithoutTradeMode(scope);
    const exchange = String(position?.exchange || '').trim().toLowerCase();
    const notional = positionNotionalUsdt(position);
    const isDust = exchange === 'binance' && notional > 0 && notional < Number(dustThresholdUsdt || 10);
    liveScopeSet.add(scope);
    liveBaseScopeSet.add(baseScope);
    if (isDust) {
      dustScopeSet.add(scope);
      dustBaseScopeSet.add(baseScope);
    }
  }

  const included = [];
  const excludedOrphan = [];
  const excludedDust = [];
  const excludedInvalid = [];

  for (const profile of activeProfiles || []) {
    const scope = profileScope(profile);
    if (!scope) {
      excludedInvalid.push(profile);
      continue;
    }
    const baseScope = scopeWithoutTradeMode(scope);
    const hasLivePosition = liveScopeSet.has(scope) || liveBaseScopeSet.has(baseScope);
    if (!hasLivePosition) {
      excludedOrphan.push(profile);
      continue;
    }
    const isDust = dustScopeSet.has(scope) || dustBaseScopeSet.has(baseScope);
    if (isDust && !includeDust) {
      excludedDust.push(profile);
      continue;
    }
    included.push(profile);
  }

  return {
    included,
    meta: {
      livePositionCount: liveScopeSet.size,
      activeProfileCount: (activeProfiles || []).length,
      includedProfileCount: included.length,
      excludedOrphanProfileCount: excludedOrphan.length,
      excludedDustProfileCount: excludedDust.length,
      excludedInvalidProfileCount: excludedInvalid.length,
      dustThresholdUsdt: Number(dustThresholdUsdt || 10),
      includeDust: Boolean(includeDust),
    },
  };
}

export function summarizeLifecycleStageCoverage({
  events = [],
  activeProfiles = [],
  requiredStages = DEFAULT_REQUIRED_STAGES,
  actionableCandidates = null,
} = {}) {
  const stageSetByScope = new Map();
  const actionableCandidateScopeSet = buildActionableCandidateScopeSet(actionableCandidates);
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
      const lateStages = DEFAULT_LATE_STAGES.filter((stageId) => requiredStages.includes(stageId));
      const applicableLateStages = actionableCandidateScopeSet == null
        ? lateStages
        : applicableLateStagesForProfile({
          profile,
          scope,
          lateStages,
          covered,
          actionableCandidateScopeSet,
        });
      const coveredLateStages = lateStages.filter((stageId) => covered.has(stageId));
      const missingLateStages = lateStages.filter((stageId) => !covered.has(stageId));
      const coveredApplicableLateStages = applicableLateStages.filter((stageId) => covered.has(stageId));
      const missingApplicableLateStages = applicableLateStages.filter((stageId) => !covered.has(stageId));
      const nonApplicableLateStages = lateStages.filter((stageId) => !applicableLateStages.includes(stageId));
      const missingActionableStages = missingStages.filter((stageId) => !nonApplicableLateStages.includes(stageId));
      return {
        positionScopeKey: scope,
        symbol: profile.symbol || null,
        exchange: profile.exchange || null,
        tradeMode: profile.trade_mode || profile.tradeMode || 'normal',
        lifecycleStatus: profileLifecycleStatus(profile) || null,
        coveredStages: requiredStages.filter((stageId) => covered.has(stageId)),
        missingStages,
        coveredLateStages,
        missingLateStages,
        applicableLateStages,
        nonApplicableLateStages,
        coveredApplicableLateStages,
        missingApplicableLateStages,
        missingLabels: missingActionableStages.map((stageId) => POSITION_STAGE_LABELS[stageId] || stageId),
        allMissingLabels: missingStages.map((stageId) => POSITION_STAGE_LABELS[stageId] || stageId),
        missingApplicableLateLabels: missingApplicableLateStages.map((stageId) => POSITION_STAGE_LABELS[stageId] || stageId),
        nonApplicableLateLabels: nonApplicableLateStages.map((stageId) => POSITION_STAGE_LABELS[stageId] || stageId),
        coveragePct: requiredStages.length > 0
          ? Math.round(((requiredStages.length - missingStages.length) / requiredStages.length) * 1000) / 10
          : 100,
        lateStageCoveragePct: lateStages.length > 0
          ? Math.round((coveredLateStages.length / lateStages.length) * 1000) / 10
          : 100,
        applicableLateStageCoveragePct: applicableLateStages.length > 0
          ? Math.round((coveredApplicableLateStages.length / applicableLateStages.length) * 1000) / 10
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
  const lateTotalExpected = rows.length * DEFAULT_LATE_STAGES.filter((stageId) => requiredStages.includes(stageId)).length;
  const lateTotalCovered = rows.reduce((sum, row) => sum + row.coveredLateStages.length, 0);
  const applicableLateTotalExpected = rows.reduce((sum, row) => sum + row.applicableLateStages.length, 0);
  const applicableLateTotalCovered = rows.reduce((sum, row) => sum + row.coveredApplicableLateStages.length, 0);
  const missingLateByStage = DEFAULT_LATE_STAGES.reduce((acc, stageId) => {
    if (requiredStages.includes(stageId)) acc[stageId] = rows.filter((row) => row.missingLateStages.includes(stageId)).length;
    return acc;
  }, {});

  return {
    ok: rows.every((row) => row.missingStages.length === 0),
    activePositions: rows.length,
    requiredStages,
    coveragePct: totalExpected > 0 ? Math.round((totalCovered / totalExpected) * 1000) / 10 : 100,
    lateStageCoveragePct: lateTotalExpected > 0 ? Math.round((lateTotalCovered / lateTotalExpected) * 1000) / 10 : 100,
    applicableLateStageCoveragePct: applicableLateTotalExpected > 0 ? Math.round((applicableLateTotalCovered / applicableLateTotalExpected) * 1000) / 10 : 100,
    missingByStage,
    missingLateByStage,
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
  const lateStageCoveragePct = Number(coverageSummary?.applicableLateStageCoveragePct ?? coverageSummary?.lateStageCoveragePct ?? 100);
  if (coverageSummary && lateStageCoveragePct < 60) {
    warnings.push(`low_lifecycle_late_stage_coverage_${lateStageCoveragePct}`);
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
      lifecycleLateStageCoveragePct: coverageSummary?.lateStageCoveragePct ?? null,
      lifecycleApplicableLateStageCoveragePct: coverageSummary?.applicableLateStageCoveragePct ?? null,
      positionSyncMismatchCount: positionSyncSummary?.mismatchCount ?? null,
    },
  };
}

export default {
  filterLifecycleCoverageProfiles,
  summarizeLifecycleStageCoverage,
  summarizeLifecyclePositionSync,
  buildLifecycleExecutionReadiness,
};
