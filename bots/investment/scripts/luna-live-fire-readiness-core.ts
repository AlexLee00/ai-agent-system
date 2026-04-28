// @ts-nocheck

function heartbeatResult(worker = {}) {
  return worker?.heartbeat?.payload?.result || {};
}

export function evaluateLunaLiveFireReadinessGate({
  operating = {},
  worker = {},
  minShadowReadyBlocked = 0,
} = {}) {
  const blockers = [];
  const observations = [];
  const killSwitches = operating.killSwitches || {};
  const result = heartbeatResult(worker);
  const mode = String(result?.mode || '').toLowerCase();
  const allowLiveFire = result?.allowLiveFire === true;
  const readyBlocked = Number(result?.readyBlocked || 0);
  const duplicateFiredScopeCount = Number(worker?.stats?.duplicateFiredScopeCount || operating?.entryTrigger?.duplicateFiredScopeCount || 0);
  const heartbeatAgeMinutes = worker?.heartbeat?.ageMinutes ?? operating?.entryTrigger?.heartbeatAgeMinutes ?? null;

  if (operating.status !== 'luna_l5_operating') blockers.push(`operating_not_ready:${operating.status || 'unknown'}`);
  if (Array.isArray(operating.readinessWarnings) && operating.readinessWarnings.length) blockers.push('luna_readiness_warnings');
  if (killSwitches.LUNA_VALIDATION_ENABLED !== 'true') blockers.push('validation_canary_not_enabled');
  if (killSwitches.LUNA_PREDICTION_ENABLED !== 'true') blockers.push('prediction_canary_not_enabled');
  if (!worker.ok) blockers.push(`entry_trigger_worker_not_ready:${worker.status || 'unknown'}`);
  if (duplicateFiredScopeCount > 0) blockers.push(`duplicate_fired_scopes:${duplicateFiredScopeCount}`);
  if (heartbeatAgeMinutes == null) blockers.push('worker_heartbeat_missing');
  if (heartbeatAgeMinutes != null && heartbeatAgeMinutes > 10) blockers.push(`worker_heartbeat_stale:${heartbeatAgeMinutes}m`);
  if (minShadowReadyBlocked > 0 && readyBlocked < minShadowReadyBlocked) {
    blockers.push(`insufficient_shadow_ready_observations:${readyBlocked}/${minShadowReadyBlocked}`);
  }

  if (allowLiveFire || mode === 'autonomous_l5' || mode === 'autonomous') {
    observations.push('entry trigger worker is already in live-fire capable mode');
  } else if (mode === 'shadow') {
    observations.push(`shadow ready-blocked observations: ${readyBlocked}`);
  } else {
    observations.push(`worker mode: ${mode || 'unknown'}`);
  }

  const ready = blockers.length === 0;
  return {
    ok: ready,
    checkedAt: new Date().toISOString(),
    status: ready
      ? (allowLiveFire ? 'live_fire_already_enabled' : 'live_fire_ready')
      : 'live_fire_blocked',
    blockers,
    observations,
    mode: mode || null,
    allowLiveFire,
    heartbeatAgeMinutes,
    readyBlocked,
    duplicateFiredScopeCount,
    commands: ready && !allowLiveFire ? [
      'launchctl setenv LUNA_INTELLIGENT_DISCOVERY_MODE autonomous_l5',
      'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s check:luna-l5',
      'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-entry-trigger-worker-readiness',
    ] : [],
    rollbackCommand: 'launchctl unsetenv LUNA_INTELLIGENT_DISCOVERY_MODE',
  };
}

export function renderLunaLiveFireReadinessGate(report = {}) {
  return [
    '🌙 Luna live-fire readiness gate',
    `status: ${report.status || 'unknown'}`,
    `blockers: ${(report.blockers || []).length ? report.blockers.join(' / ') : 'none'}`,
    `mode: ${report.mode || 'unknown'} / allowLiveFire=${report.allowLiveFire === true}`,
    `heartbeat: ${report.heartbeatAgeMinutes ?? 'n/a'}m / readyBlocked=${report.readyBlocked ?? 'n/a'} / dup=${report.duplicateFiredScopeCount ?? 'n/a'}`,
    `next: ${(report.commands || []).length ? report.commands[0] : 'continue observation'}`,
  ].join('\n');
}
