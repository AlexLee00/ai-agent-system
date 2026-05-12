#!/usr/bin/env node

import assert from 'node:assert/strict';
import { handleTask } from '../a2a/handlers/task-handler.ts';
import {
  createHybridFinalClosureHandler,
  registerHybridFinalClosureSkill,
} from '../a2a/skills/hybrid-final-closure.ts';
import { LUNA_PROTECTED_6 } from '../shared/luna-hybrid-final-closure.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function fixtureParams() {
  return {
    noExec: false,
    phase11Report: {
      ok: true,
      status: 'luna_hybrid_promotion_review_ready',
      liveMutation: false,
      protectedPidMutation: false,
      promotionReady: false,
      readyForMasterReview: true,
      masterApprovalRequired: true,
      gate: { status: 'luna_hybrid_promotion_gate_ready_for_master_review' },
    },
    bottleneckReport: {
      ok: true,
      status: 'luna_bottleneck_clear',
      hardBlockers: [],
      bottlenecks: [],
      warnings: [],
      evidence: {
        marketdata: { ok: true, status: 'marketdata_realtime_connectivity_ready', blockers: [] },
        finalGate: { ok: true, status: 'luna_live_fire_final_gate_clear', blockers: [] },
        postLive: { ok: true, status: 'post_live_fire_verified', blockers: [] },
      },
    },
    protectedPidStatus: { source: 'fixture', visibleLabels: LUNA_PROTECTED_6 },
  };
}

export async function runLunaHybridFinalClosureA2ASmoke() {
  registerHybridFinalClosureSkill();

  const result = await handleTask({
    id: 'hybrid-final-closure-a2a-smoke-1',
    skill: { id: 'hybrid-final-closure' },
    params: { ...fixtureParams(), broadcast: false },
  });
  assert.equal(result.id, 'hybrid-final-closure-a2a-smoke-1');
  assert.equal(result.status, 'completed', JSON.stringify(result.error || result.output, null, 2));
  assert.equal(result.output.ok, true);
  assert.equal(result.output.skill, 'hybrid-final-closure');
  assert.equal(result.output.shadowMode, true);
  assert.equal(result.output.liveMutation, false);
  assert.equal(result.output.protectedPidMutation, false);
  assert.equal(result.output.finalClosureReady, true);
  assert.equal(result.output.masterApprovalRequired, true);
  assert.equal(result.output.promotionReady, false);
  assert.equal(result.output.broadcastPlanned, false);
  assert.ok(result.output.runbook.finalClosureOnly);

  const noExec = await createHybridFinalClosureHandler()({ broadcast: false });
  assert.equal(noExec.status, 'completed', JSON.stringify(noExec.error || noExec.output, null, 2));
  assert.equal(noExec.output.ok, true);
  assert.equal(noExec.output.status, 'luna_hybrid_final_closure_contract_only');
  assert.equal(noExec.output.finalClosureReady, false);
  assert.equal(noExec.output.blockers.length, 0);

  const previous = process.env.LUNA_A2A_BROADCAST_ENABLED;
  process.env.LUNA_A2A_BROADCAST_ENABLED = 'true';
  const enabled = await createHybridFinalClosureHandler()({ ...fixtureParams() });
  assert.equal(enabled.output.broadcastPlanned, true);
  if (previous == null) delete process.env.LUNA_A2A_BROADCAST_ENABLED;
  else process.env.LUNA_A2A_BROADCAST_ENABLED = previous;

  return {
    ok: true,
    smoke: 'luna-hybrid-final-closure-a2a-phase12',
    status: result.output.status,
    noExecStatus: noExec.output.status,
    broadcastDefault: result.output.broadcastPlanned,
    broadcastEnabled: enabled.output.broadcastPlanned,
    finalClosureReady: result.output.finalClosureReady,
    promotionReady: result.output.promotionReady,
    liveMutation: result.output.liveMutation,
  };
}

async function main() {
  const result = await runLunaHybridFinalClosureA2ASmoke();
  console.log(JSON.stringify(result, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: 'luna hybrid final closure A2A smoke failed:',
  });
}
