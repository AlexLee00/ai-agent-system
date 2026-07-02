// @ts-nocheck

import { run } from './db/core.ts';

const VALID_DECISIONS = new Set(['pending', 'keep', 'revert']);

function clean(value = '') {
  return String(value || '').trim();
}

export function validateExperimentLedgerPayload(payload = {}) {
  const errors = [];
  if (!clean(payload.hypothesis)) errors.push('hypothesis_required');
  if (!clean(payload.variable)) errors.push('single_variable_required');
  if (Array.isArray(payload.variable)) errors.push('single_variable_violation');
  if (payload.variables && Object.keys(payload.variables || {}).length > 1) errors.push('single_variable_violation');
  if (!clean(payload.target_metric || payload.targetMetric)) errors.push('target_metric_required');
  const decision = clean(payload.decision || 'pending').toLowerCase();
  if (!VALID_DECISIONS.has(decision)) errors.push('invalid_decision');
  return { ok: errors.length === 0, errors, decision };
}

export function buildExperimentLedgerEvent(payload = {}) {
  const validation = validateExperimentLedgerPayload(payload);
  return {
    ok: validation.ok,
    eventType: 'experiment_ledger',
    payload: {
      hypothesis: clean(payload.hypothesis),
      variable: clean(payload.variable),
      old: payload.old ?? null,
      new: payload.new ?? null,
      control_ref: payload.control_ref || payload.controlRef || null,
      target_metric: payload.target_metric || payload.targetMetric || null,
      measured_delta: payload.measured_delta ?? payload.measuredDelta ?? null,
      decision: validation.decision,
      trace: payload.trace || {},
      validation,
    },
    validation,
  };
}

export function attachExperimentLedgerToMutation(mutation = {}, payload = {}) {
  const event = buildExperimentLedgerEvent(payload);
  return {
    ...mutation,
    experimentLedger: event,
    evidence: {
      ...(mutation.evidence || {}),
      experimentLedger: event.payload,
    },
  };
}

export function evaluateExperimentApplyGate({ ledger = null, pboStatus = null, env = process.env } = {}) {
  const enabled = ['1', 'true', 'yes', 'on'].includes(String(env.LUNA_EXPERIMENT_LEDGER_GATE_ENABLED || 'false').toLowerCase());
  const mode = String(env.LUNA_EXPERIMENT_LEDGER_GATE_MODE || 'shadow').toLowerCase() === 'enforce' ? 'enforce' : 'shadow';
  const blockers = [];
  if (!ledger?.ok) blockers.push('experiment_ledger_missing_or_invalid');
  if (pboStatus?.wouldBlock === true || pboStatus?.blocked === true) blockers.push('pbo_gate_would_block');
  const wouldBlock = enabled && blockers.length > 0;
  return {
    ok: !wouldBlock || mode !== 'enforce',
    enabled,
    mode,
    wouldBlock,
    blocked: wouldBlock && mode === 'enforce',
    blockers,
    shadowOnly: mode !== 'enforce',
    liveMutation: false,
  };
}

export async function recordExperimentLedger(payload = {}, options = {}) {
  const event = buildExperimentLedgerEvent(payload);
  if (!event.ok) return { recorded: false, event, errors: event.validation.errors };
  if (options.dryRun !== false) return { recorded: false, dryRun: true, event };
  const result = await (options.runFn || run)(
    `INSERT INTO investment.mapek_knowledge (event_type, payload) VALUES ($1, $2::jsonb)`,
    [event.eventType, JSON.stringify(event.payload)],
  );
  return { recorded: true, dryRun: false, event, result };
}

export default {
  validateExperimentLedgerPayload,
  buildExperimentLedgerEvent,
  attachExperimentLedgerToMutation,
  evaluateExperimentApplyGate,
  recordExperimentLedger,
};
