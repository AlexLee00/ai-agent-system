#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  buildDecisionAgentPlan,
  shouldRunExecutionAuxiliaryNode,
} from '../shared/pipeline-decision-agent-plan.ts';

const defaults = buildDecisionAgentPlan({
  exchange: 'binance',
  defaultDebateLimit: 4,
  runtimeFlags: {
    phases: {
      predictiveValidationEnabled: true,
      entryTriggerEnabled: true,
    },
  },
});
assert.equal(defaults.source, 'default_decision_plan');
assert.equal(defaults.debateEnabled, true);
assert.equal(defaults.debateLimit, 4);
assert.equal(defaults.portfolioEnabled, true);
assert.deepEqual(defaults.immutableSafetyNodeIds, ['L21', 'L30', 'L31', 'L34']);
assert.deepEqual(defaults.auxiliaryExecutionNodeIds, ['L33', 'L32']);
assert.equal(shouldRunExecutionAuxiliaryNode(defaults, 'L33'), true);

const debateOff = buildDecisionAgentPlan({
  exchange: 'kis',
  defaultDebateLimit: 6,
  meta: {
    agentPlan: {
      decision: {
        debate: { enabled: false },
        execution: { auxiliaryNodeIds: ['L32'] },
      },
    },
  },
});
assert.equal(debateOff.source, 'runtime_agent_plan');
assert.equal(debateOff.debateEnabled, false);
assert.equal(debateOff.debateLimit, 0);
assert.deepEqual(debateOff.debateNodeIds, []);
assert.deepEqual(debateOff.auxiliaryExecutionNodeIds, ['L32']);
assert.equal(shouldRunExecutionAuxiliaryNode(debateOff, 'L33'), false);
assert.equal(shouldRunExecutionAuxiliaryNode(debateOff, 'L32'), true);

const safetyBypassRejected = buildDecisionAgentPlan({
  exchange: 'kis_overseas',
  defaultDebateLimit: 10,
  params: {
    decision_agent_plan: {
      debate_limit: 99,
      portfolio_enabled: false,
      predictive_validation_enabled: false,
      entry_trigger_enabled: false,
      execution_auxiliary_node_ids: ['L21', 'L31', 'L33', 'L99'],
    },
  },
  runtimeFlags: {
    phases: {
      predictiveValidationEnabled: true,
      entryTriggerEnabled: true,
    },
  },
});
assert.equal(safetyBypassRejected.debateLimit, 20);
assert.equal(safetyBypassRejected.portfolioEnabled, true);
assert.equal(safetyBypassRejected.predictiveValidationEnabled, true);
assert.equal(safetyBypassRejected.entryTriggerEnabled, true);
assert.deepEqual(safetyBypassRejected.auxiliaryExecutionNodeIds, ['L33']);
assert.equal(safetyBypassRejected.warnings.includes('debate_limit_clamped'), true);
assert.equal(safetyBypassRejected.warnings.includes('immutable_decision_node:L14'), true);
assert.equal(safetyBypassRejected.warnings.includes('immutable_safety_gate:predictive_validation'), true);
assert.equal(safetyBypassRejected.warnings.includes('immutable_safety_gate:entry_trigger'), true);
assert.equal(safetyBypassRejected.warnings.includes('immutable_nodes_ignored:L21,L31'), true);
assert.equal(safetyBypassRejected.warnings.includes('unsupported_execution_aux_nodes:L99'), true);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ok: true, checked: 3 }, null, 2));
} else {
  console.log('pipeline decision agent plan smoke ok');
}
