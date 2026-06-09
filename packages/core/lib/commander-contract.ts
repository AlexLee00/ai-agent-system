'use strict';

type JsonRecord = Record<string, unknown>;

type CommanderStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'dead_letter'
  | 'retrying';

type CommanderTaskInput = {
  incidentKey?: string;
  team?: string;
  stepId?: string;
  goal?: string;
  planStep?: unknown;
  payload?: unknown;
  deadlineAt?: string;
};

type CommanderProgressInput = {
  incidentKey?: string;
  team?: string;
  stepId?: string;
  status?: string;
  evidence?: unknown;
  message?: string;
};

type CommanderFinalSummaryInput = {
  incidentKey?: string;
  team?: string;
  status?: string;
  result?: unknown;
  evidence?: unknown;
  summary?: string;
};

type CommanderRejectInput = {
  incidentKey?: string;
  team?: string;
  reason?: string;
};

type CommanderTaskData = {
  incidentKey: string;
  team: string;
  stepId: string;
  goal: string;
  planStep: JsonRecord;
  payload: JsonRecord;
  deadlineAt: string | null;
};

type CommanderProgressData = {
  incidentKey: string;
  team: string;
  stepId: string;
  status: CommanderStatus;
  evidence: JsonRecord;
  message: string;
};

type CommanderFinalSummaryData = {
  incidentKey: string;
  team: string;
  status: CommanderStatus;
  result: JsonRecord;
  evidence: JsonRecord;
  summary: string;
};

type CommanderRejectData = {
  incidentKey: string;
  team: string;
  reason: string;
};

type ValidationResult<T> =
  | { ok: false; error: string }
  | { ok: true; data: T };

type CommanderAdapter = {
  acceptIncidentTask?: unknown;
  reportProgress?: unknown;
  finalSummary?: unknown;
  rejectTask?: unknown;
  [key: string]: unknown;
};

type VirtualCommanderOptions = {
  label?: string;
};

function normalizeText(value: unknown, fallback = ''): string {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

function normalizeStatus(value: unknown, fallback: CommanderStatus = 'queued'): CommanderStatus {
  const allowed = new Set<CommanderStatus>([
    'queued',
    'running',
    'completed',
    'failed',
    'rejected',
    'dead_letter',
    'retrying',
  ]);
  const normalized = normalizeText(value, fallback).toLowerCase();
  return allowed.has(normalized as CommanderStatus) ? normalized as CommanderStatus : fallback;
}

function normalizeObject(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as JsonRecord;
}

function validateCommanderTask(input: CommanderTaskInput): ValidationResult<CommanderTaskData> {
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

function validateCommanderProgress(input: CommanderProgressInput): ValidationResult<CommanderProgressData> {
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

function validateCommanderFinalSummary(input: CommanderFinalSummaryInput): ValidationResult<CommanderFinalSummaryData> {
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

function validateCommanderReject(input: CommanderRejectInput): ValidationResult<CommanderRejectData> {
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

function validateCommanderAdapter(adapter: unknown, team = 'unknown') {
  if (!adapter || typeof adapter !== 'object') {
    return { ok: false, error: `adapter_missing:${team}` };
  }
  const commanderAdapter = adapter as CommanderAdapter;
  const required = ['acceptIncidentTask', 'reportProgress', 'finalSummary', 'rejectTask'];
  for (const fn of required) {
    if (typeof commanderAdapter[fn] !== 'function') {
      return { ok: false, error: `adapter_method_missing:${team}:${fn}` };
    }
  }
  return { ok: true };
}

function createVirtualCommanderAdapter(team: unknown, options: VirtualCommanderOptions = {}) {
  const normalizedTeam = normalizeText(team, 'general').toLowerCase();
  const label = normalizeText(options.label, `${normalizedTeam}-virtual`);

  return {
    team: normalizedTeam,
    label,
    mode: 'virtual',
    async acceptIncidentTask(task: CommanderTaskInput) {
      const parsed = validateCommanderTask(task);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      const taskData = parsed.data;
      return {
        ok: true,
        status: 'queued',
        team: normalizedTeam,
        incidentKey: taskData.incidentKey,
        stepId: taskData.stepId,
        acceptedAt: new Date().toISOString(),
      };
    },
    async reportProgress(progress: CommanderProgressInput) {
      const parsed = validateCommanderProgress(progress);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      const progressData = parsed.data;
      return {
        ok: true,
        status: progressData.status,
        team: normalizedTeam,
        incidentKey: progressData.incidentKey,
        stepId: progressData.stepId,
        updatedAt: new Date().toISOString(),
      };
    },
    async finalSummary(summary: CommanderFinalSummaryInput) {
      const parsed = validateCommanderFinalSummary(summary);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      const summaryData = parsed.data;
      return {
        ok: true,
        status: summaryData.status,
        team: normalizedTeam,
        incidentKey: summaryData.incidentKey,
        result: summaryData.result,
        evidence: summaryData.evidence,
        summary: summaryData.summary || `${label} completed`,
        completedAt: new Date().toISOString(),
      };
    },
    async rejectTask(rejectInput: CommanderRejectInput) {
      const parsed = validateCommanderReject(rejectInput);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      const rejectData = parsed.data;
      return {
        ok: true,
        status: 'rejected',
        team: normalizedTeam,
        incidentKey: rejectData.incidentKey,
        reason: rejectData.reason,
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
