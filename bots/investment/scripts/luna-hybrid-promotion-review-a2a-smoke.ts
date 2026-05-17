#!/usr/bin/env node

import assert from 'node:assert/strict';
import { handleTask } from '../a2a/handlers/task-handler.ts';
import {
  createHybridPromotionReviewHandler,
  registerHybridPromotionReviewSkill,
} from '../a2a/skills/hybrid-promotion-review.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function fakeQuery(sql) {
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

function fakeQueryWithBridgeFailure(sql) {
  if (sql.includes('luna_promotion_entry_trigger_bridge_shadow')) {
    throw new Error('bridge table missing');
  }
  return fakeQuery(sql);
}

export async function runLunaHybridPromotionReviewA2ASmoke() {
  registerHybridPromotionReviewSkill({ queryFn: fakeQuery });

  const result = await handleTask({
    id: 'hybrid-promotion-review-a2a-smoke-1',
    skill: { id: 'hybrid-promotion-review' },
    params: { broadcast: false, hours: 168 },
  });
  assert.equal(result.id, 'hybrid-promotion-review-a2a-smoke-1');
  assert.equal(result.status, 'completed', JSON.stringify(result.error || result.output, null, 2));
  assert.equal(result.output.ok, true);
  assert.equal(result.output.skill, 'hybrid-promotion-review');
  assert.equal(result.output.shadowMode, true);
  assert.equal(result.output.liveMutation, false);
  assert.equal(result.output.readyForMasterReview, true);
  assert.equal(result.output.masterApprovalRequired, true);
  assert.equal(result.output.promotionReady, false);
  assert.equal(result.output.summary.promotionEntryTriggerBridgePending, 0);
  assert.equal(result.output.promotionEntryTriggerBridge.status, 'promotion_entry_trigger_bridge_clear');
  assert.equal(result.output.broadcastPlanned, false);
  assert.ok(result.output.runbook.reviewOnly);

  const noDb = await createHybridPromotionReviewHandler({ queryFn: fakeQuery })({ noDb: true, broadcast: false, hours: 168 });
  assert.equal(noDb.status, 'completed', JSON.stringify(noDb.error || noDb.output, null, 2));
  assert.equal(noDb.output.ok, true);
  assert.equal(noDb.output.status, 'luna_hybrid_promotion_review_contract_only');
  assert.equal(noDb.output.readyForMasterReview, false);
  assert.equal(noDb.output.blockers.length, 0);
  assert.equal(noDb.output.summary.dataChecked, false);
  assert.equal(noDb.output.summary.dataRequired, false);

  const failedBridge = await createHybridPromotionReviewHandler({ queryFn: fakeQueryWithBridgeFailure })({
    broadcast: false,
    hours: 168,
  });
  assert.equal(failedBridge.status, 'failed', JSON.stringify(failedBridge.error || failedBridge.output, null, 2));
  assert.equal(failedBridge.output.ok, false);
  assert.equal(failedBridge.output.readyForMasterReview, false);
  assert.equal(failedBridge.output.promotionEntryTriggerBridge.status, 'promotion_entry_trigger_bridge_query_failed');
  assert.equal(
    failedBridge.output.blockers.some((blocker) => blocker.name === 'promotion_entry_trigger_bridge_reviewed'),
    true,
  );

  const previous = process.env.LUNA_A2A_BROADCAST_ENABLED;
  process.env.LUNA_A2A_BROADCAST_ENABLED = 'true';
  const enabled = await createHybridPromotionReviewHandler({ queryFn: fakeQuery })({ hours: 168 });
  assert.equal(enabled.output.broadcastPlanned, true);
  if (previous == null) delete process.env.LUNA_A2A_BROADCAST_ENABLED;
  else process.env.LUNA_A2A_BROADCAST_ENABLED = previous;

  return {
    ok: true,
    smoke: 'luna-hybrid-promotion-review-a2a-phase11',
    status: result.output.status,
    noDbStatus: noDb.output.status,
    broadcastDefault: result.output.broadcastPlanned,
    broadcastEnabled: enabled.output.broadcastPlanned,
    readyForMasterReview: result.output.readyForMasterReview,
    promotionReady: result.output.promotionReady,
    liveMutation: result.output.liveMutation,
  };
}

async function main() {
  const result = await runLunaHybridPromotionReviewA2ASmoke();
  console.log(JSON.stringify(result, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: 'luna hybrid promotion review A2A smoke failed:',
  });
}
