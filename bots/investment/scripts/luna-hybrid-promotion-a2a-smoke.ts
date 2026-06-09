#!/usr/bin/env node

import assert from 'node:assert/strict';
import { handleTask } from '../a2a/handlers/task-handler.ts';
import {
  createHybridPromotionGateHandler,
  registerHybridPromotionGateSkill,
} from '../a2a/skills/hybrid-promotion-gate.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

type HybridPromotionOutput = {
  ok: boolean;
  skill: string;
  shadowMode: boolean;
  liveMutation: boolean;
  contractReady: boolean;
  dataReady: boolean;
  promotionReady: boolean;
  broadcastPlanned: boolean;
  status: string;
};

type HybridPromotionTaskResult = {
  id: string;
  status: string;
  error?: unknown;
  output: HybridPromotionOutput;
};

function fakeQuery(sql: string) {
  if (
    sql.includes('luna_regime_llm_shadow')
    || sql.includes('luna_entry_llm_shadow')
    || sql.includes('luna_dynamic_tpsl_shadow')
    || sql.includes('luna_factor_model_shadow')
    || sql.includes('luna_stat_arb_shadow')
    || sql.includes('luna_rl_policy_shadow')
    || sql.includes('luna_risk_simulation_shadow')
    || sql.includes('mapek_knowledge')
  ) {
    return [{ count: 2, latest_at: '2026-05-12T00:00:00.000Z' }];
  }
  return [];
}

export async function runLunaHybridPromotionA2ASmoke() {
  registerHybridPromotionGateSkill({ queryFn: fakeQuery });

  const result = await handleTask({
    id: 'hybrid-promotion-a2a-smoke-1',
    skill: { id: 'hybrid-promotion-gate' },
    params: { broadcast: false, hours: 168 },
  }) as HybridPromotionTaskResult;
  assert.equal(result.id, 'hybrid-promotion-a2a-smoke-1');
  assert.equal(result.status, 'completed', JSON.stringify(result.error || result.output, null, 2));
  assert.equal(result.output.ok, true);
  assert.equal(result.output.skill, 'hybrid-promotion-gate');
  assert.equal(result.output.shadowMode, true);
  assert.equal(result.output.liveMutation, false);
  assert.equal(result.output.contractReady, true);
  assert.equal(result.output.dataReady, true);
  assert.equal(result.output.promotionReady, false);
  assert.equal(result.output.broadcastPlanned, false);

  const previous = process.env.LUNA_A2A_BROADCAST_ENABLED;
  process.env.LUNA_A2A_BROADCAST_ENABLED = 'true';
  const enabled = await createHybridPromotionGateHandler({ queryFn: fakeQuery })({ hours: 168 }) as unknown as HybridPromotionTaskResult;
  assert.equal(enabled.output.broadcastPlanned, true);
  if (previous == null) delete process.env.LUNA_A2A_BROADCAST_ENABLED;
  else process.env.LUNA_A2A_BROADCAST_ENABLED = previous;

  return {
    ok: true,
    smoke: 'luna-hybrid-promotion-a2a-phase10',
    status: result.output.status,
    broadcastDefault: result.output.broadcastPlanned,
    broadcastEnabled: enabled.output.broadcastPlanned,
    promotionReady: result.output.promotionReady,
    liveMutation: result.output.liveMutation,
  };
}

async function main() {
  const result = await runLunaHybridPromotionA2ASmoke();
  console.log(JSON.stringify(result, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await (runCliMain as any)({
    run: main,
    errorPrefix: 'luna hybrid promotion A2A smoke failed:',
  });
}
