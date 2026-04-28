'use strict';

function normalizeText(value, fallback = '') {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

function normalizeStatus(value, fallback = 'queued') {
  const allowed = new Set([
    'queued',
    'running',
    'completed',
    'failed',
    'rejected',
    'dead_letter',
    'retrying',
  ]);
  const normalized = normalizeText(value, fallback).toLowerCase();
  return allowed.has(normalized) ? normalized : fallback;
}

function normalizeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function validateCommanderTask(input) {
  const incidentKey = normalizeText(input?.incidentKey);
  const team = normalizeText(input?.team, 'general').toLowerCase();
  const stepId = normalizeText(input?.stepId, 'step');
  const goal = normalizeText(input?.goal, '');
  const planStep = normalizeObject(input?.planStep);
  const payload = normalizeObject(input?.payload);
  const deadlineAt = normalizeText(input?.deadlineAt, '') || null;

  if (!incidentKey) {
    return { ok: false, error: 'incident_key_required' };
  }
  if (!goal && !planStep?.objective && !payload?.objective) {
    return { ok: false, error: 'incident_objective_required' };
  }
  return {
    ok: true,
    data: {
      incidentKey,
      team,
      stepId,
      goal: goal || normalizeText(planStep?.objective || payload?.objective, 'task_execution'),
      planStep,
      payload,
      deadlineAt,
    },
  };
}

function validateCommanderProgress(input) {
  const incidentKey = normalizeText(input?.incidentKey);
  const team = normalizeText(input?.team, 'general').toLowerCase();
  const stepId = normalizeText(input?.stepId, 'step');
  const status = normalizeStatus(input?.status, 'running');
  const evidence = normalizeObject(input?.evidence);
  const message = normalizeText(input?.message, '');

  if (!incidentKey) return { ok: false, error: 'incident_key_required' };
  return {
    ok: true,
    data: {
      incidentKey,
      team,
      stepId,
      status,
      evidence,
      message,
    },
  };
}

function validateCommanderFinalSummary(input) {
  const incidentKey = normalizeText(input?.incidentKey);
  const team = normalizeText(input?.team, 'general').toLowerCase();
  const status = normalizeStatus(input?.status, 'completed');
  const result = normalizeObject(input?.result);
  const evidence = normalizeObject(input?.evidence);
  const summary = normalizeText(input?.summary, '');

  if (!incidentKey) return { ok: false, error: 'incident_key_required' };
  return {
    ok: true,
    data: {
      incidentKey,
      team,
      status,
      result,
      evidence,
      summary,
    },
  };
}

function validateCommanderReject(input) {
  const incidentKey = normalizeText(input?.incidentKey);
  const team = normalizeText(input?.team, 'general').toLowerCase();
  const reason = normalizeText(input?.reason, 'rejected_by_commander');
  if (!incidentKey) return { ok: false, error: 'incident_key_required' };
  return {
    ok: true,
    data: {
      incidentKey,
      team,
      reason,
    },
  };
}

function validateCommanderAdapter(adapter, team = 'unknown') {
  if (!adapter || typeof adapter !== 'object') {
    return { ok: false, error: `adapter_missing:${team}` };
  }
  const required = ['acceptIncidentTask', 'reportProgress', 'finalSummary', 'rejectTask'];
  for (const fn of required) {
    if (typeof adapter[fn] !== 'function') {
      return { ok: false, error: `adapter_method_missing:${team}:${fn}` };
    }
  }
  return { ok: true };
}

function createVirtualCommanderAdapter(team, options = {}) {
  const normalizedTeam = normalizeText(team, 'general').toLowerCase();
  const label = normalizeText(options.label, `${normalizedTeam}-virtual`);

  return {
    team: normalizedTeam,
    label,
    mode: 'virtual',
    async acceptIncidentTask(task) {
      const parsed = validateCommanderTask(task);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      return {
        ok: true,
        status: 'queued',
        team: normalizedTeam,
        incidentKey: parsed.data.incidentKey,
        stepId: parsed.data.stepId,
        acceptedAt: new Date().toISOString(),
      };
    },
    async reportProgress(progress) {
      const parsed = validateCommanderProgress(progress);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      return {
        ok: true,
        status: parsed.data.status,
        team: normalizedTeam,
        incidentKey: parsed.data.incidentKey,
        stepId: parsed.data.stepId,
        updatedAt: new Date().toISOString(),
      };
    },
    async finalSummary(summary) {
      const parsed = validateCommanderFinalSummary(summary);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      return {
        ok: true,
        status: parsed.data.status,
        team: normalizedTeam,
        incidentKey: parsed.data.incidentKey,
        result: parsed.data.result,
        evidence: parsed.data.evidence,
        summary: parsed.data.summary || `${label} completed`,
        completedAt: new Date().toISOString(),
      };
    },
    async rejectTask(rejectInput) {
      const parsed = validateCommanderReject(rejectInput);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      return {
        ok: true,
        status: 'rejected',
        team: normalizedTeam,
        incidentKey: parsed.data.incidentKey,
        reason: parsed.data.reason,
        rejectedAt: new Date().toISOString(),
      };
    },
  };
}

module.exports = {
  validateCommanderTask,
  validateCommanderProgress,
  validateCommanderFinalSummary,
  validateCommanderReject,
  validateCommanderAdapter,
  createVirtualCommanderAdapter,
  normalizeStatus,
};
