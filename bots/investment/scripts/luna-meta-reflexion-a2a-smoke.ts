#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { handleTask } from '../a2a/handlers/task-handler.ts';
import { createMetaNeuralReflexionHandler, registerMetaNeuralReflexionSkill } from '../a2a/skills/meta-neural-reflexion.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function fakeQuery(sql) {
  if (sql.includes('luna_meta_reflexion_shadow')) {
    return [{
      event_type: 'luna_meta_reflexion_shadow',
      payload: {
        layer: 'l2',
        scope: 'smoke',
        periodStart: '2026-05-11',
        periodEnd: '2026-05-11',
        recommendations: ['check entry timing'],
        lossPatterns: [{ pattern: 'entry_timing_quality', count: 2 }],
        policyRecommendations: {
          layer2: ['entry threshold candidate'],
          layer3: ['compare tpsl shadow'],
          layer4: ['store memory shadow'],
          promotionAllowed: false,
          liveConfigMutationAllowed: false,
        },
        riskAssessment: { riskLevel: 'low' },
        confidence: 0.62,
        priority: 'MEDIUM',
        memoryWritePlanned: true,
        broadcastPlanned: false,
        shadowOnly: true,
      },
      created_at: '2026-05-11T00:00:00.000Z',
    }];
  }
  return [];
}

export async function runLunaMetaReflexionA2ASmoke() {
  registerMetaNeuralReflexionSkill({ queryFn: fakeQuery });

  const result = await handleTask({
    id: 'meta-reflexion-a2a-smoke-1',
    skill: { id: 'meta-neural-reflexion' },
    params: { layer: 'l2', scope: 'smoke' },
  });
  assert.equal(result.id, 'meta-reflexion-a2a-smoke-1');
  assert.equal(result.status, 'completed');
  assert.equal(result.output.ok, true);
  assert.equal(result.output.skill, 'meta-neural-reflexion');
  assert.equal(result.output.dataHealth, 'shadow_ready');
  assert.equal(result.output.layer, 'l2');
  assert.equal(result.output.recommendations[0], 'check entry timing');
  assert.equal(result.output.policyRecommendations.liveConfigMutationAllowed, false);
  assert.equal(result.output.memoryWritePlanned, true);
  assert.equal(result.output.broadcastPlanned, false);

  const previous = process.env.LUNA_A2A_BROADCAST_ENABLED;
  process.env.LUNA_A2A_BROADCAST_ENABLED = 'true';
  const enabled = await createMetaNeuralReflexionHandler({ queryFn: fakeQuery })({
    layer: 'l2',
    scope: 'smoke',
  });
  assert.equal(enabled.output.broadcastPlanned, true);
  if (previous == null) delete process.env.LUNA_A2A_BROADCAST_ENABLED;
  else process.env.LUNA_A2A_BROADCAST_ENABLED = previous;

  const candidateOnly = await createMetaNeuralReflexionHandler({ queryFn: () => [] })({
    layer: 'l3',
    scope: 'smoke',
    dpoRows: [{
      score: 0.3,
      category: 'rejected',
      critique: 'risk sizing failed',
      outcome_summary: { symbol: 'BTC/USDT' },
    }],
  });
  assert.equal(candidateOnly.status, 'completed');
  assert.equal(candidateOnly.output.dataHealth, 'candidate_only');
  assert.equal(candidateOnly.output.layer, 'l3');
  assert.equal(candidateOnly.output.shadowMode, true);
  assert.equal(candidateOnly.output.policyRecommendations.liveConfigMutationAllowed, false);

  return {
    ok: true,
    smoke: 'luna-meta-reflexion-a2a-phase4',
    skill: result.output.skill,
    broadcastDefault: result.output.broadcastPlanned,
    broadcastEnabled: enabled.output.broadcastPlanned,
    candidateOnly: candidateOnly.output.dataHealth,
  };
}

async function main() {
  const result = await runLunaMetaReflexionA2ASmoke();
  console.log(JSON.stringify(result, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna meta reflexion A2A smoke 실패:',
  });
}
