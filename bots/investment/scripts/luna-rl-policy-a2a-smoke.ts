#!/usr/bin/env node

import assert from 'node:assert/strict';
import { handleTask } from '../a2a/handlers/task-handler.ts';
import {
  createRlPolicyShadowHandler,
  createRlPolicyUpdateHandler,
  registerRlPolicyShadowSkills,
} from '../a2a/skills/rl-policy-shadow.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function fakeQuery(sql) {
  if (sql.includes('luna_rl_policy_shadow')) {
    return [{
      symbol: 'BTC/USDT',
      exchange: 'binance',
      market: 'crypto',
      state_vector: { featureNames: ['momentum20'], values: [0.6] },
      action: 0.18,
      action_type: 'buy',
      action_size_pct: 0.0216,
      confidence: 0.52,
      reward_estimate: 0.031,
      model_status: 'missing_optional_deps_or_model',
      data_health: 'ready',
      context_evidence: { source: 'fixture' },
      shadow_only: true,
      observed_at: '2026-05-12T00:00:00.000Z',
    }];
  }
  return [];
}

export async function runLunaRlPolicyA2ASmoke() {
  registerRlPolicyShadowSkills({ queryFn: fakeQuery });

  const result = await handleTask({
    id: 'rl-policy-a2a-smoke-1',
    skill: { id: 'policy-inference' },
    params: { symbol: 'BTC/USDT', exchange: 'binance' },
  });
  assert.equal(result.id, 'rl-policy-a2a-smoke-1');
  assert.equal(result.status, 'completed');
  assert.equal(result.output.ok, true);
  assert.equal(result.output.skill, 'policy-inference');
  assert.equal(result.output.actionType, 'buy');
  assert.equal(result.output.dataHealth, 'ready');
  assert.equal(result.output.shadowMode, true);
  assert.equal(result.output.broadcastPlanned, false);

  const previous = process.env.LUNA_A2A_BROADCAST_ENABLED;
  process.env.LUNA_A2A_BROADCAST_ENABLED = 'true';
  const enabled = await createRlPolicyShadowHandler({ queryFn: fakeQuery, skillId: 'rl-policy-shadow' })({
    symbol: 'BTC/USDT',
    exchange: 'binance',
  });
  assert.equal(enabled.output.broadcastPlanned, true);
  if (previous == null) delete process.env.LUNA_A2A_BROADCAST_ENABLED;
  else process.env.LUNA_A2A_BROADCAST_ENABLED = previous;

  const candidateOnly = await createRlPolicyShadowHandler({ queryFn: () => [], skillId: 'rl-policy-shadow' })({
    symbol: 'NVDA',
    exchange: 'kis_overseas',
    bars: Array.from({ length: 24 }, (_, index) => ({ close: 800 + index * 3, high: 805 + index * 3, low: 795 + index * 3, volume: 1000 })),
    factorEvidence: { compositeScore: 0.7 },
    entryEvidence: { confidence: 0.62 },
    regimeEvidence: { confidence: 0.58 },
  });
  assert.equal(candidateOnly.status, 'completed');
  assert.equal(candidateOnly.output.skill, 'rl-policy-shadow');
  assert.equal(candidateOnly.output.market, 'overseas');
  assert.equal(candidateOnly.output.dataHealth, 'ready');

  const updatePlan = await createRlPolicyUpdateHandler()({ broadcast: false });
  assert.equal(updatePlan.status, 'completed');
  assert.equal(updatePlan.output.trainingPlanned, false);
  assert.equal(updatePlan.output.liveMutation, false);

  return {
    ok: true,
    smoke: 'luna-rl-policy-a2a-phase7',
    skill: result.output.skill,
    broadcastDefault: result.output.broadcastPlanned,
    broadcastEnabled: enabled.output.broadcastPlanned,
    candidateOnly: candidateOnly.output.dataHealth,
    policyUpdateShadow: updatePlan.output.shadowMode,
  };
}

async function main() {
  const result = await runLunaRlPolicyA2ASmoke();
  console.log(JSON.stringify(result, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: 'luna rl policy A2A smoke failed:',
  });
}
