'use strict';

/**
 * @param {{ id?: unknown }} [task]
 */
function buildSymphonyValidationPlan(task = { id: null }) {
  return {
    mode: 'plan_only',
    taskId: task.id || null,
    outputSchema: 'auto_dev_validation_chain_v1',
    validators: [
      { id: 'reviewer', required: true, command: 'runReview', passField: 'summary.pass' },
      { id: 'guardian', required: true, command: 'runFullSecurityScan', passField: 'pass' },
      { id: 'builder', required: true, command: 'runBuildCheck', passField: 'pass' },
      { id: 'test_runner', required: true, command: 'run scoped test_scope commands', passField: 'pass' },
    ],
    preservesLegacySchema: true,
    relaxesWriteScope: false,
    relaxesTestScope: false,
  };
}

module.exports = {
  buildSymphonyValidationPlan,
};
