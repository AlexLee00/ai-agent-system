'use strict';

function normalizeText(value, fallback = '') {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

function normalizeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function summarizeCommanderDispatch(dispatch) {
  const results = normalizeArray(dispatch?.results);
  const failed = results.filter((result) => !result?.ok);
  const retrying = results.filter((result) => result?.retrying);
  return {
    claimed: Number(dispatch?.claimed || results.length || 0),
    completed: results.length - failed.length,
    failed: failed.length,
    retrying: retrying.length,
    firstError: normalizeText(failed[0]?.error || dispatch?.error || '', '') || null,
  };
}

function summarizeExecuteResponse(executeResponse) {
  const payload = normalizeObject(executeResponse?.payload);
  const result = normalizeArray(payload.result);
  const failed = result.filter((entry) => entry?.ok === false);
  return {
    skipped: Boolean(executeResponse?.skipped),
    reason: normalizeText(executeResponse?.reason || '', '') || null,
    executedSteps: result.length,
    failedSteps: failed.length,
    firstError: normalizeText(failed[0]?.error || executeResponse?.error || '', '') || null,
  };
}

function observeIncidentOutcome(input = {}) {
  const planSteps = normalizeArray(input.planSteps);
  const commander = summarizeCommanderDispatch(input.commanderDispatch);
  const execution = summarizeExecuteResponse(input.executeResponse);
  const warnings = [];
  const nextActions = [];

  if (commander.firstError) {
    warnings.push(`commander:${commander.firstError}`);
    nextActions.push('Review dead_letter/retrying commander task before closing incident.');
  }
  if (execution.firstError) {
    warnings.push(`execute:${execution.firstError}`);
    nextActions.push('Review Hub control execution result before closing incident.');
  }
  if (planSteps.length === 0) {
    warnings.push('plan_has_no_steps');
    nextActions.push('Regenerate plan with a concrete diagnostic or repair step.');
  }

  const status = warnings.length > 0 ? 'needs_follow_up' : 'completed';
  const summary = [
    `planSteps=${planSteps.length}`,
    `commanderClaimed=${commander.claimed}`,
    `commanderFailed=${commander.failed}`,
    `executedSteps=${execution.executedSteps}`,
    `executeFailed=${execution.failedSteps}`,
    `status=${status}`,
  ].join(' / ');

  return {
    ok: status === 'completed',
    status,
    summary,
    warnings,
    nextActions,
    evidence: {
      planSteps: planSteps.length,
      commander,
      execution,
    },
  };
}

module.exports = {
  observeIncidentOutcome,
  _testOnly: {
    summarizeCommanderDispatch,
    summarizeExecuteResponse,
  },
};
