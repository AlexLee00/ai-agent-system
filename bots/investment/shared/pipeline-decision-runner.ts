// @ts-nocheck
import { buildRiskApprovalRationalePayload } from './pipeline-approved-decision.ts';
import { runDecisionExecutionStateMachine } from './pipeline-decision-state-machine.ts';
export { buildDecisionBridgeMeta, loadDecisionPlannerCompact } from './pipeline-decision-bridge.ts';

export { buildRiskApprovalRationalePayload };

export async function runDecisionExecutionPipeline(args = {}) {
  return runDecisionExecutionStateMachine(args);
}

export default {
  runDecisionExecutionPipeline,
};
