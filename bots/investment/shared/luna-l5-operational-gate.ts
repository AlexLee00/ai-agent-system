// @ts-nocheck

export const LUNA_L5_MARKETS = ['domestic', 'overseas', 'crypto'];
export const LUNA_L5_PHASE_KEYS = ['phaseD', 'phaseE', 'phaseF', 'phaseG', 'phaseH'];
export const LUNA_L5_RUNNERS = new Set([
  'runtime:strategy-exit',
  'runtime:partial-adjust',
  'runtime:pyramid-adjust',
]);
export const LUNA_L5_PHASE_CONFIG_KEYS = {
  phaseD: 'signal_refresh',
  phaseE: 'dynamic_position_sizing',
  phaseF: 'dynamic_trailing',
  phaseG: 'reflexive_portfolio_monitoring',
  phaseH: 'event_stream',
};
export const LUNA_L5_PHASE_SEQUENCE = [
  {
    phase: 'phaseD',
    configKey: 'signal_refresh',
    label: 'signal refresh',
    smokeCommand: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:position-signal-refresh-smoke',
  },
  {
    phase: 'phaseE',
    configKey: 'dynamic_position_sizing',
    label: 'dynamic position sizing',
    smokeCommand: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:dynamic-position-sizer-smoke',
  },
  {
    phase: 'phaseF',
    configKey: 'dynamic_trailing',
    label: 'dynamic trailing',
    smokeCommand: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:dynamic-trail-engine-smoke',
  },
  {
    phase: 'phaseG',
    configKey: 'reflexive_portfolio_monitoring',
    label: 'reflexive portfolio monitoring',
    smokeCommand: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:portfolio-monitor-reflexive-smoke',
  },
  {
    phase: 'phaseH',
    configKey: 'event_stream',
    label: 'lifecycle event stream',
    smokeCommand: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:position-lifecycle-event-stream-smoke',
  },
];

function uniq(items = []) {
  return [...new Set((items || []).filter(Boolean))];
}

export function normalizeLifecycleMode(value = 'shadow') {
  const mode = String(value || 'shadow').trim().toLowerCase();
  if (mode === 'autonomous') return 'autonomous_l5';
  if (mode === 'supervised') return 'supervised_l4';
  if (mode === 'autonomous_l5' || mode === 'supervised_l4' || mode === 'shadow') return mode;
  return 'shadow';
}

function modeRank(mode = 'shadow') {
  switch (normalizeLifecycleMode(mode)) {
    case 'autonomous_l5': return 3;
    case 'supervised_l4': return 2;
    default: return 1;
  }
}

export function normalizeMarketList(markets = LUNA_L5_MARKETS) {
  const raw = Array.isArray(markets) ? markets : String(markets || '').split(',');
  const normalized = raw
    .map((item) => String(item || '').trim().toLowerCase())
    .flatMap((item) => (item === 'all' ? LUNA_L5_MARKETS : [item]))
    .filter((item) => LUNA_L5_MARKETS.includes(item));
  return uniq(normalized.length ? normalized : LUNA_L5_MARKETS);
}

export function buildPositionSyncFinalGate({
  syncSummary = null,
  requiredMarkets = LUNA_L5_MARKETS,
  requireAllMarkets = true,
  checkedAt = null,
} = {}) {
  const markets = normalizeMarketList(requiredMarkets);
  const checked = new Set((syncSummary?.checkedMarkets || []).map((item) => String(item)));
  const blockers = [];
  const warnings = [];

  if (!syncSummary) {
    blockers.push('position_sync_not_run');
  } else {
    if (syncSummary.ok !== true) {
      blockers.push(`position_sync_not_clean:${Number(syncSummary.mismatchCount || 0)}`);
    }
    for (const market of syncSummary.failedMarkets || []) {
      blockers.push(`position_sync_failed:${market}`);
    }
    if (requireAllMarkets) {
      for (const market of markets) {
        if (!checked.has(market)) blockers.push(`position_sync_market_missing:${market}`);
      }
    }
    if (Number(syncSummary.skipped || 0) > 0) {
      warnings.push(`position_sync_skipped:${Number(syncSummary.skipped || 0)}`);
    }
  }

  return {
    ok: blockers.length === 0,
    status: blockers.length === 0 ? 'position_sync_final_gate_clear' : 'position_sync_final_gate_blocked',
    checkedAt: checkedAt || syncSummary?.checkedAt || null,
    requiredMarkets: markets,
    checkedMarkets: syncSummary?.checkedMarkets || [],
    blockers: uniq(blockers),
    warnings: uniq(warnings),
    mismatchCount: Number(syncSummary?.mismatchCount || 0),
    failedMarkets: syncSummary?.failedMarkets || [],
    skipped: Number(syncSummary?.skipped || 0),
  };
}

function ageMinutes(iso = null, nowMs = Date.now()) {
  if (!iso) return null;
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, Math.round((nowMs - ts) / 60000));
}

export function buildRunnerContractSummary({ candidates = [] } = {}) {
  const rows = Array.isArray(candidates) ? candidates : [];
  const blockers = [];
  const warnings = [];
  const byRunner = {};

  for (const candidate of rows) {
    const runner = String(candidate?.runner || '').trim();
    const key = runner || 'missing';
    byRunner[key] = (byRunner[key] || 0) + 1;
    if (!runner) {
      blockers.push(`runner_missing:${candidate?.exchange || 'unknown'}:${candidate?.symbol || 'unknown'}`);
      continue;
    }
    if (!LUNA_L5_RUNNERS.has(runner)) {
      blockers.push(`runner_unsupported:${runner}`);
    }
    if (!candidate?.runnerArgs && !candidate?.autonomousExecuteCommand) {
      blockers.push(`runner_execute_path_missing:${runner}:${candidate?.symbol || 'unknown'}`);
    }
    if (candidate?.action === 'ADJUST' && runner === 'runtime:strategy-exit') {
      warnings.push(`adjust_candidate_uses_exit_runner:${candidate?.symbol || 'unknown'}`);
    }
  }

  return {
    ok: blockers.length === 0,
    status: blockers.length === 0 ? 'runner_contract_clear' : 'runner_contract_blocked',
    candidateCount: rows.length,
    byRunner,
    blockers: uniq(blockers),
    warnings: uniq(warnings),
  };
}

export function buildExecutePreflightDrill({
  autopilotPreview = null,
  dispatchPreview = null,
  lifecycleReadiness = null,
  positionSyncGate = null,
  excludedOrphanCandidates = [],
  positionStrategyAudit = null,
} = {}) {
  const blockers = [];
  const warnings = [];
  const candidates = Array.isArray(dispatchPreview?.candidates) ? dispatchPreview.candidates : [];
  const runnerContract = buildRunnerContractSummary({ candidates });
  const orphanProfiles = Number(positionStrategyAudit?.orphanProfiles ?? 0);

  if (autopilotPreview?.ok === false) blockers.push('autopilot_preview_failed');
  if (dispatchPreview?.ok === false) blockers.push('dispatch_preview_failed');
  if (lifecycleReadiness?.ok === false) {
    blockers.push(...(lifecycleReadiness.blockers || ['lifecycle_readiness_blocked']));
  }
  if (positionSyncGate?.ok === false) {
    blockers.push(...(positionSyncGate.blockers || ['position_sync_gate_blocked']));
  }
  if (runnerContract.ok !== true) blockers.push(...runnerContract.blockers);
  if (orphanProfiles > 0) blockers.push(`orphan_profiles_present:${orphanProfiles}`);
  if (candidates.length === 0) warnings.push('no_execute_candidates_preview');
  if ((excludedOrphanCandidates || []).length > 0) warnings.push(`orphan_execute_candidates_excluded:${excludedOrphanCandidates.length}`);
  if (Number(dispatchPreview?.guardReasonSummary?.blockedActionable || 0) > 0) {
    warnings.push(`blocked_actionable:${Number(dispatchPreview.guardReasonSummary.blockedActionable || 0)}`);
  }

  return {
    ok: blockers.length === 0,
    status: blockers.length === 0 ? 'execute_preflight_drill_clear' : 'execute_preflight_drill_blocked',
    candidateCount: candidates.length,
    excludedOrphanCandidateCount: (excludedOrphanCandidates || []).length,
    blockers: uniq(blockers),
    warnings: uniq([...warnings, ...(runnerContract.warnings || [])]),
    runnerContract,
    candidateCommands: candidates.slice(0, 10).map((candidate) => ({
      exchange: candidate.exchange,
      symbol: candidate.symbol,
      tradeMode: candidate.tradeMode || 'normal',
      action: candidate.action,
      runner: candidate.runner || null,
      command: candidate.autonomousExecuteCommand || candidate.manualExecuteCommand || candidate.previewCommand || null,
    })),
    excludedOrphanCandidates: (excludedOrphanCandidates || []).slice(0, 10).map((candidate) => ({
      exchange: candidate.exchange,
      symbol: candidate.symbol,
      tradeMode: candidate.tradeMode || 'normal',
      action: candidate.action,
      runner: candidate.runner || null,
    })),
  };
}

export function buildSupervisedWarmupGate({
  targetMode = 'supervised_l4',
  currentFlags = null,
  bottleneck = null,
  minSamples = 3,
  minCleanSamples = 3,
} = {}) {
  const target = normalizeLifecycleMode(targetMode);
  if (target !== 'autonomous_l5') {
    return {
      ok: true,
      status: 'supervised_warmup_not_required',
      required: false,
      blockers: [],
      warnings: [],
    };
  }

  const current = normalizeLifecycleMode(currentFlags?.mode || 'shadow');
  const blockers = [];
  const warnings = [];
  const dispatch = bottleneck?.dispatch || {};
  const sampleCount = Number(bottleneck?.sampleCount || 0);
  const cleanStreak = Number(dispatch.cleanStreakSamples || 0);
  const recentHardFailures = Number(dispatch.recentHardFailureCount ?? dispatch.hardFailureCount ?? 0);
  const requiredSamples = Math.max(1, Number(minSamples || 3));
  const requiredClean = Math.max(1, Number(minCleanSamples || 3));

  if (current !== 'supervised_l4' && current !== 'autonomous_l5') {
    blockers.push(`autonomous_requires_supervised_warmup:current=${current}`);
  }
  if (sampleCount < requiredSamples) {
    blockers.push(`supervised_warmup_samples_insufficient:${sampleCount}/${requiredSamples}`);
  }
  if (cleanStreak < requiredClean) {
    blockers.push(`supervised_clean_streak_insufficient:${cleanStreak}/${requiredClean}`);
  }
  if (recentHardFailures > 0) {
    blockers.push(`recent_autopilot_hard_failures:${recentHardFailures}`);
  }
  const recentStaleCandidateCount = Number(dispatch.recentStaleCandidateCount ?? 0);
  if (recentStaleCandidateCount > 0) {
    warnings.push(`recent_stale_candidates_observed:${recentStaleCandidateCount}`);
  }

  return {
    ok: blockers.length === 0,
    status: blockers.length === 0 ? 'supervised_warmup_clear' : 'supervised_warmup_blocked',
    required: true,
    currentMode: current,
    sampleCount,
    cleanStreakSamples: cleanStreak,
    requiredSamples,
    requiredCleanSamples: requiredClean,
    recentHardFailureCount: recentHardFailures,
    latestStatus: bottleneck?.latestStatus || null,
    latestRecordedAt: bottleneck?.latestRecordedAt || null,
    blockers: uniq(blockers),
    warnings: uniq(warnings),
  };
}

export function buildLifecycleCutoverGate({
  targetMode = 'supervised_l4',
  currentFlags = null,
  readiness = null,
  positionSyncGate = null,
  executePreflight = null,
  configDoctor = null,
  supervisedWarmupGate = null,
  autonomousOperationalGate = null,
} = {}) {
  const target = normalizeLifecycleMode(targetMode);
  const current = normalizeLifecycleMode(currentFlags?.mode || 'shadow');
  const blockers = [];
  const warnings = [];

  if (modeRank(target) < modeRank(current)) {
    warnings.push(`cutover_is_downgrade:${current}->${target}`);
  }
  if (target === 'autonomous_l5' && current !== 'supervised_l4' && current !== 'autonomous_l5') {
    blockers.push(`autonomous_requires_supervised_warmup:current=${current}`);
  }

  const phaseStates = {};
  for (const phase of LUNA_L5_PHASE_KEYS) {
    const enabled = currentFlags?.[phase]?.enabled === true;
    phaseStates[phase] = enabled;
    if (target === 'autonomous_l5' && !enabled) blockers.push(`phase_disabled:${phase}`);
    else if (!enabled) warnings.push(`phase_disabled:${phase}`);
  }
  const enabledPhaseCount = Object.values(phaseStates).filter(Boolean).length;
  if (target === 'supervised_l4' && enabledPhaseCount === 0) {
    blockers.push('supervised_cutover_requires_at_least_one_lifecycle_phase');
  }

  if (readiness?.ok === false) blockers.push(...(readiness.blockers || ['lifecycle_readiness_blocked']));
  if (positionSyncGate?.ok === false) blockers.push(...(positionSyncGate.blockers || ['position_sync_gate_blocked']));
  if (executePreflight?.ok === false) blockers.push(...(executePreflight.blockers || ['execute_preflight_blocked']));
  if (configDoctor?.ok === false) blockers.push(...(configDoctor.blockers || ['config_doctor_blocked']));
  if (target === 'autonomous_l5') {
    if (!supervisedWarmupGate) blockers.push('supervised_warmup_gate_missing');
    else if (supervisedWarmupGate.ok !== true) blockers.push(...(supervisedWarmupGate.blockers || ['supervised_warmup_blocked']));
    if (!positionSyncGate) blockers.push('autonomous_requires_position_sync_gate');
    if (!autonomousOperationalGate) blockers.push('autonomous_operational_gate_missing');
    else if (autonomousOperationalGate.ok !== true) blockers.push(...(autonomousOperationalGate.blockers || ['autonomous_operational_gate_blocked']));
  }

  return {
    ok: blockers.length === 0,
    status: blockers.length === 0 ? 'luna_l5_cutover_gate_clear' : 'luna_l5_cutover_gate_blocked',
    currentMode: current,
    targetMode: target,
    phaseStates,
    blockers: uniq(blockers),
    warnings: uniq([
      ...warnings,
      ...(readiness?.warnings || []),
      ...(positionSyncGate?.warnings || []),
      ...(executePreflight?.warnings || []),
      ...(configDoctor?.warnings || []),
      ...(supervisedWarmupGate?.warnings || []),
      ...(autonomousOperationalGate?.warnings || []),
    ]),
    supervisedWarmupGate,
    autonomousOperationalGate,
    nextAction: blockers.length === 0
      ? `apply_position_lifecycle_mode:${target}`
      : 'resolve_cutover_blockers',
  };
}

export function buildAutonomousOperationalGate({
  targetMode = 'supervised_l4',
  positionSyncGate = null,
  manualReconcilePlaybook = null,
  positionStrategyAudit = null,
  bottleneck = null,
  maxPositionSyncAgeMinutes = 30,
  nowMs = Date.now(),
} = {}) {
  const target = normalizeLifecycleMode(targetMode);
  if (target !== 'autonomous_l5') {
    return {
      ok: true,
      status: 'autonomous_operational_gate_not_required',
      required: false,
      blockers: [],
      warnings: [],
    };
  }

  const blockers = [];
  const warnings = [];
  const syncAge = ageMinutes(positionSyncGate?.checkedAt, nowMs);
  const maxSyncAge = Math.max(1, Number(maxPositionSyncAgeMinutes || 30));
  const recentHardFailures = Number(bottleneck?.dispatch?.recentHardFailureCount ?? bottleneck?.dispatch?.hardFailureCount ?? 0);
  const manualTasks = Number(manualReconcilePlaybook?.summary?.tasks ?? 0);
  const dustProfiles = Number(positionStrategyAudit?.dustProfiles ?? 0);
  const orphanProfiles = Number(positionStrategyAudit?.orphanProfiles ?? 0);
  const duplicateManagedProfiles = Number(positionStrategyAudit?.duplicateManagedProfileScopes ?? 0);
  const unmatchedManagedPositions = Number(positionStrategyAudit?.unmatchedManagedPositions ?? 0);

  if (!positionSyncGate) blockers.push('autonomous_position_sync_required');
  else if (positionSyncGate.ok !== true) blockers.push(...(positionSyncGate.blockers || ['position_sync_gate_blocked']));
  if (syncAge == null) blockers.push('autonomous_position_sync_freshness_unknown');
  else if (syncAge > maxSyncAge) blockers.push(`autonomous_position_sync_stale:${syncAge}m>${maxSyncAge}m`);

  if (!manualReconcilePlaybook) blockers.push('manual_reconcile_playbook_required');
  else if (manualReconcilePlaybook.ok !== true || manualTasks > 0) blockers.push(`manual_reconcile_tasks:${manualTasks}`);

  if (!positionStrategyAudit) blockers.push('position_strategy_audit_required');
  else {
    if (dustProfiles > 0) blockers.push(`dust_profiles_present:${dustProfiles}`);
    if (orphanProfiles > 0) blockers.push(`orphan_profiles_present:${orphanProfiles}`);
    if (duplicateManagedProfiles > 0) blockers.push(`duplicate_managed_profiles:${duplicateManagedProfiles}`);
    if (unmatchedManagedPositions > 0) warnings.push(`unmatched_managed_positions:${unmatchedManagedPositions}`);
  }

  if (recentHardFailures > 0) blockers.push(`recent_autopilot_hard_failures:${recentHardFailures}`);

  return {
    ok: blockers.length === 0,
    status: blockers.length === 0 ? 'autonomous_operational_gate_clear' : 'autonomous_operational_gate_blocked',
    required: true,
    checkedAt: new Date(nowMs).toISOString(),
    maxPositionSyncAgeMinutes: maxSyncAge,
    positionSyncAgeMinutes: syncAge,
    manualReconcileTasks: manualTasks,
    dustProfiles,
    orphanProfiles,
    duplicateManagedProfileScopes: duplicateManagedProfiles,
    unmatchedManagedPositions,
    recentHardFailureCount: recentHardFailures,
    blockers: uniq(blockers),
    warnings: uniq(warnings),
  };
}

export function buildLunaL5FinalGate({
  cutoverGate = null,
  positionSyncGate = null,
  executePreflight = null,
  configDoctor = null,
  hephaestosRefactor = null,
  supervisedWarmupGate = null,
  autonomousOperationalGate = null,
} = {}) {
  const blockers = uniq([
    ...(cutoverGate?.blockers || []),
    ...(positionSyncGate?.blockers || []),
    ...(executePreflight?.blockers || []),
    ...(configDoctor?.blockers || []),
    ...(autonomousOperationalGate?.blockers || []),
  ]);
  const warnings = uniq([
    ...(cutoverGate?.warnings || []),
    ...(positionSyncGate?.warnings || []),
    ...(executePreflight?.warnings || []),
    ...(configDoctor?.warnings || []),
    ...(autonomousOperationalGate?.warnings || []),
  ]);
  const technicalDebtWarnings = uniq([
    ...(hephaestosRefactor?.warnings || []),
  ]);
  return {
    ok: blockers.length === 0,
    status: blockers.length === 0 ? 'luna_l5_final_gate_clear' : 'luna_l5_final_gate_blocked',
    checkedAt: new Date().toISOString(),
    blockers,
    warnings,
    technicalDebtWarnings,
    cutoverGate,
    positionSyncGate,
    executePreflight,
    configDoctor,
    hephaestosRefactor,
    supervisedWarmupGate,
    autonomousOperationalGate,
    nextAction: blockers.length === 0 ? 'ready_for_supervised_or_autonomous_cutover' : 'resolve_luna_l5_final_gate_blockers',
  };
}

export function buildLunaL5AlarmPayload(report = {}) {
  const blockerCount = (report.blockers || []).length;
  const warningCount = (report.warnings || []).length;
  return {
    from_bot: 'luna',
    event_type: blockerCount > 0 ? 'error' : 'report',
    alert_level: blockerCount > 0 ? 2 : warningCount > 0 ? 1 : 0,
    message: [
      '🌙 Luna L5 final gate',
      `status: ${report.status || 'unknown'}`,
      `blockers: ${blockerCount ? report.blockers.slice(0, 5).join(' / ') : 'none'}`,
      `warnings: ${warningCount}`,
      `next: ${report.nextAction || 'unknown'}`,
    ].join('\n'),
    payload: {
      checkedAt: report.checkedAt,
      status: report.status,
      blockers: report.blockers || [],
      warnings: report.warnings || [],
      cutoverStatus: report.cutoverGate?.status || null,
      syncStatus: report.positionSyncGate?.status || null,
      preflightStatus: report.executePreflight?.status || null,
      configStatus: report.configDoctor?.status || null,
      autonomousOperationalStatus: report.autonomousOperationalGate?.status || null,
    },
  };
}

export default {
  buildPositionSyncFinalGate,
  buildRunnerContractSummary,
  buildExecutePreflightDrill,
  buildLifecycleCutoverGate,
  buildAutonomousOperationalGate,
  buildSupervisedWarmupGate,
  buildLunaL5FinalGate,
  buildLunaL5AlarmPayload,
  normalizeLifecycleMode,
  normalizeMarketList,
};
