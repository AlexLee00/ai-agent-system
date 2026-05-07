#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildSignalAgentPlanPayload,
  readExecutionRunnerAgentPlanArg,
  serializeAgentPlanArg,
} from '../shared/execution-runner-agent-plan.ts';

const explicit = {
  execution: {
    hephaestos: {
      disabledFeatures: ['normal_to_validation_fallback'],
    },
    domestic: {
      entrySizingMultiplier: 0.5,
    },
  },
};

const signalPlan = buildSignalAgentPlanPayload({
  explicitAgentPlan: explicit,
  candidate: {
    agentPlan: {
      execution: {
        domestic: {
          entrySizingMultiplier: 0.9,
        },
      },
    },
  },
  runner: 'partial_adjust_runner',
});
assert.equal(signalPlan.execution.hephaestos.disabledFeatures[0], 'normal_to_validation_fallback');
assert.equal(signalPlan.execution.domestic.entrySizingMultiplier, 0.5);
assert.equal(signalPlan.runnerContext.runner, 'partial_adjust_runner');

const fallbackPlan = buildSignalAgentPlanPayload({
  candidate: {
    runtimeState: {
      agentPlan: {
        execution: {
          overseas: {
            entrySizingMultiplier: 0.75,
          },
        },
      },
    },
  },
  runner: 'strategy_exit_runner',
});
assert.equal(fallbackPlan.execution.overseas.entrySizingMultiplier, 0.75);
assert.equal(fallbackPlan.runnerContext.propagatedBy, 'strategy_exit_runner');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-runner-agent-plan-'));
const planFile = path.join(tmpDir, 'agent-plan.json');
fs.writeFileSync(planFile, JSON.stringify({ execution: { kis: { entrySizingMultiplier: 0.6 } } }));
const filePlan = readExecutionRunnerAgentPlanArg([`--agent-plan-file=${planFile}`]);
assert.equal(filePlan.execution.kis.entrySizingMultiplier, 0.6);

const jsonPlan = readExecutionRunnerAgentPlanArg([
  '--agent-plan-json={"execution":{"hephaestos":{"validationLiveReentrySofteningEnabled":false}}}',
]);
assert.equal(jsonPlan.execution.hephaestos.validationLiveReentrySofteningEnabled, false);
assert.equal(
  serializeAgentPlanArg({ execution: { hanul: { disabledFeatures: ['responsibility_execution_sizing'] } } }),
  '{"execution":{"hanul":{"disabledFeatures":["responsibility_execution_sizing"]}}}',
);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({
    ok: true,
    smoke: 'execution-runner-agent-plan',
    propagatedRunners: ['partial_adjust_runner', 'pyramid_adjust_runner', 'strategy_exit_runner', 'force_exit_runner'],
  }, null, 2));
} else {
  console.log('✅ execution runner agent plan smoke passed');
}
