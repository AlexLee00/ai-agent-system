#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { handleTask } from '../a2a/handlers/task-handler.ts';
import {
  createCommunicationInfrastructureGateHandler,
  registerCommunicationInfrastructureGateSkill,
} from '../a2a/skills/communication-infrastructure-gate.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export async function runLunaCommunicationInfraA2ASmoke() {
  registerCommunicationInfrastructureGateSkill();

  const result = await handleTask({
    id: 'communication-infra-a2a-smoke-1',
    skill: { id: 'communication-infrastructure-gate' },
    params: { broadcast: false },
  });
  assert.equal(result.id, 'communication-infra-a2a-smoke-1');
  assert.equal(result.status, 'completed', JSON.stringify(result.error || result.output, null, 2));
  assert.equal(result.output.ok, true);
  assert.equal(result.output.skill, 'communication-infrastructure-gate');
  assert.equal(result.output.shadowMode, true);
  assert.equal(result.output.liveMutation, false);
  assert.equal(result.output.broadcastPlanned, false);
  assert.ok(result.output.a2aSkills >= 1);

  const previous = process.env.LUNA_A2A_BROADCAST_ENABLED;
  process.env.LUNA_A2A_BROADCAST_ENABLED = 'true';
  const enabled = await createCommunicationInfrastructureGateHandler()({});
  assert.equal(enabled.output.broadcastPlanned, true);
  if (previous == null) delete process.env.LUNA_A2A_BROADCAST_ENABLED;
  else process.env.LUNA_A2A_BROADCAST_ENABLED = previous;

  return {
    ok: true,
    smoke: 'luna-communication-infra-a2a-phase9',
    status: result.output.status,
    broadcastDefault: result.output.broadcastPlanned,
    broadcastEnabled: enabled.output.broadcastPlanned,
    liveMutation: result.output.liveMutation,
  };
}

async function main() {
  const result = await runLunaCommunicationInfraA2ASmoke();
  console.log(JSON.stringify(result, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: 'luna communication infra A2A smoke failed:',
  });
}
