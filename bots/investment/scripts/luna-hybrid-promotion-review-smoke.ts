#!/usr/bin/env node

import assert from 'node:assert/strict';
import { buildLunaHybridPromotionReviewReport } from '../shared/luna-hybrid-promotion-review.ts';
import { runLunaHybridPromotionReview } from './runtime-luna-hybrid-promotion-review.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const FIXTURE_TIME = '2026-05-12T00:00:00.000Z';

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
    return [{ count: 3, latest_at: FIXTURE_TIME }];
  }
  return [];
}

export async function runLunaHybridPromotionReviewSmoke() {
  const report = await buildLunaHybridPromotionReviewReport({ queryFn: fakeQuery, hours: 168 });
  assert.equal(report.ok, true, JSON.stringify(report.blockers, null, 2));
  assert.equal(report.shadowMode, true);
  assert.equal(report.liveMutation, false);
  assert.equal(report.protectedPidMutation, false);
  assert.equal(report.readyForMasterReview, true);
  assert.equal(report.masterApprovalRequired, true);
  assert.equal(report.promotionReady, false);
  assert.equal(report.status, 'luna_hybrid_promotion_review_ready');
  assert.ok(report.checklist.every((item) => item.ok), JSON.stringify(report.checklist, null, 2));
  assert.ok(report.runbook.reviewOnly);
  assert.equal(report.runbook.liveMutationAllowed, false);
  assert.equal(report.runbook.protectedPidMutationAllowed, false);
  assert.ok(report.runbook.prohibitedWithoutApproval.includes('live trade'));
  assert.ok(report.runbook.prohibitedWithoutApproval.includes('protected PID restart/kill/unload'));

  const noDb = await runLunaHybridPromotionReview({ json: true, strict: true, noDb: true, hours: 168 });
  assert.equal(noDb.ok, true);
  assert.equal(noDb.dataChecked, false);
  assert.equal(noDb.dataRequired, false);
  assert.equal(noDb.readyForMasterReview, false);
  assert.equal(noDb.promotionReady, false);
  assert.equal(noDb.status, 'luna_hybrid_promotion_review_contract_only');
  assert.equal(noDb.blockers.length, 0);

  const applyBlocked = await runLunaHybridPromotionReview({ apply: true, json: true, noDb: true, hours: 168 });
  assert.equal(applyBlocked.ok, false);
  assert.equal(applyBlocked.status, 'luna_hybrid_promotion_review_apply_blocked');
  assert.equal(applyBlocked.liveMutation, false);
  assert.equal(applyBlocked.promotionReady, false);

  return {
    ok: true,
    smoke: 'luna-hybrid-promotion-review-phase11',
    status: report.status,
    noDbStatus: noDb.status,
    readyForMasterReview: report.readyForMasterReview,
    promotionReady: report.promotionReady,
    masterApprovalRequired: report.masterApprovalRequired,
    liveMutation: report.liveMutation,
  };
}

async function main() {
  const result = await runLunaHybridPromotionReviewSmoke();
  console.log(JSON.stringify(result, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: 'luna hybrid promotion review smoke failed:',
  });
}
