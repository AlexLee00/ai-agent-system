#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import {
  buildCollaborationMatrix,
  executeCollaboration,
  getCollaborationFlow,
} from '../shared/agent-collaboration-matrix.ts';
import { listAgentDefinitions } from '../shared/agent-yaml-loader.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const DECISION_TYPES = ['discovery_entry', 'risk_execution', 'posttrade_learning', 'maintenance_sync'];

export async function runSmoke() {
  const agents = listAgentDefinitions();
  const matrix = buildCollaborationMatrix(agents);
  assert.equal(matrix.ok, true, `matrix references must resolve: ${JSON.stringify(matrix.missingReferences)}`);

  const flowSummaries = [];
  for (const decisionType of DECISION_TYPES) {
    const first = getCollaborationFlow(decisionType, { agents });
    const second = getCollaborationFlow(decisionType, { agents });
    assert.deepEqual(first, second, `${decisionType} flow must be deterministic`);
    assert.equal(first.ok, true, `${decisionType} flow must resolve all agents`);

    const dryRun = await executeCollaboration(first, {
      incidentKey: `smoke:${decisionType}`,
      summary: { symbol: 'BTC/USDT', mode: 'dry_run' },
    }, { dryRun: true, env: {} });
    assert.equal(dryRun.status, 'collaboration_dry_run');
    assert.equal(dryRun.published.length, 0);
    assert.ok(dryRun.publishPlan.length > 0, `${decisionType} should produce a publish plan`);

    const disabled = await executeCollaboration(first, {
      incidentKey: `smoke:${decisionType}:disabled`,
    }, { dryRun: false, env: {} });
    assert.equal(disabled.status, 'collaboration_publish_disabled');
    assert.equal(disabled.published.length, 0);

    const calls = [];
    const published = await executeCollaboration(first, {
      incidentKey: `smoke:${decisionType}:publish`,
    }, {
      dryRun: false,
      env: { LUNA_COLLABORATION_MATRIX_PUBLISH_ENABLED: 'true' },
      sendMessageFn: async (...args) => {
        calls.push(args);
        return calls.length;
      },
    });
    assert.equal(published.status, 'collaboration_published');
    assert.equal(calls.length, first.steps.reduce((sum, step) => sum + step.to.length, 0));
    assert.equal(published.ok, true);

    flowSummaries.push({ decisionType, steps: first.steps.length, publishPlan: dryRun.publishPlan.length });
  }

  return {
    ok: true,
    totalAgents: agents.length,
    missingReferenceCount: matrix.missingReferences.length,
    flows: flowSummaries,
  };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`agent-collaboration-matrix-smoke ok (${result.flows.length} flows)`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ agent-collaboration-matrix-smoke 실패:' });
}
