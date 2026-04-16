// @ts-nocheck
'use strict';

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function run(input = {}) {
  const chosenTools = toArray(input.chosenTools);
  const notes = toArray(input.notes);
  const outcome = String(input.outcome || '').toLowerCase();
  const hasSelection = Boolean(input.chosenAgent || input.chosenSkill || chosenTools.length);

  const assertions = [
    {
      key: 'outcome_present',
      ok: Boolean(outcome),
    },
    {
      key: 'selection_present',
      ok: hasSelection,
    },
    {
      key: 'followup_present',
      ok: notes.length > 0 || outcome === 'success' || outcome === 'fail',
    },
  ];

  const evidence = [
    `team=${input.team || 'unknown'}`,
    `agent=${input.chosenAgent || 'n/a'}`,
    `skill=${input.chosenSkill || 'n/a'}`,
    `tools=${chosenTools.join(',') || 'n/a'}`,
    `outcome=${outcome || 'unknown'}`,
  ];

  const failures = assertions.filter((item) => !item.ok).map((item) => item.key);
  const nextActions = [];
  if (outcome === 'success') {
    nextActions.push('Promote this combination as a recommended pattern for similar tasks.');
  } else if (outcome === 'fail') {
    nextActions.push('Record this combination into operational learning with a recovery hint.');
  } else {
    nextActions.push('Add explicit outcome and lessons learned before closing the task.');
  }
  if (!hasSelection) nextActions.push('Include selected agent, skill, and tools in the retro context.');
  if (!notes.length) nextActions.push('Capture at least one lesson learned or follow-up note.');

  let finalVerdict = 'pass';
  if (!assertions[0].ok || !assertions[1].ok) {
    finalVerdict = 'fail';
  } else if (!notes.length) {
    finalVerdict = 'warn';
  }

  return {
    workflow: 'retro-workflow',
    inputs: {
      team: input.team || null,
      chosenAgent: input.chosenAgent || null,
      chosenSkill: input.chosenSkill || null,
      chosenTools,
      outcome: outcome || null,
      notes,
    },
    assertions,
    evidence,
    failures,
    finalVerdict,
    nextActions,
  };
}

module.exports = {
  run,
};
