#!/usr/bin/env node

import assert from 'node:assert/strict';
import { buildLunaHybridPromotionReviewReport } from '../shared/luna-hybrid-promotion-review.ts';
import { runLunaHybridPromotionReview } from './runtime-luna-hybrid-promotion-review.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const FIXTURE_TIME = '2026-05-12T00:00:00.000Z';

type PromotionReviewSmokeReport = {
  ok: boolean;
  dataChecked?: boolean;
  dataRequired?: boolean;
  readyForMasterReview?: boolean;
  promotionReady?: boolean;
  status?: string;
  blockers: unknown[];
  liveMutation?: boolean;
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
    return [{ count: 3, latest_at: FIXTURE_TIME }];
  }
  return [];
}

function fakeQueryWithBridgeFailure(sql: string) {
  if (sql.includes('luna_promotion_entry_trigger_bridge_shadow')) {
    throw new Error('bridge table missing');
  }
  return fakeQuery(sql);
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
  assert.equal(report.promotionEntryTriggerBridge.status, 'promotion_entry_trigger_bridge_clear');
  assert.equal(report.promotionEntryTriggerBridge.pendingApproval, 0);
  assert.ok(report.runbook.prePromotionReviewCommands.some((cmd) => cmd.includes('runtime:luna-promotion-entry-trigger-coverage') && cmd.includes('--market=all') && cmd.includes('--exchange=all')));
  assert.ok(report.runbook.prePromotionReviewCommands.some((cmd) => cmd.includes('runtime:luna-promotion-entry-trigger-bridge') && cmd.includes('--market=all') && cmd.includes('--exchange=all')));
  assert.ok(report.runbook.prePromotionReviewCommands.some((cmd) => cmd.includes('runtime:luna-promotion-entry-trigger-materialize') && cmd.includes('--market=all') && cmd.includes('--exchange=all')));
  assert.ok(report.runbook.prohibitedWithoutApproval.includes('live trade'));
  assert.ok(report.runbook.prohibitedWithoutApproval.includes('protected PID restart/kill/unload'));

  const bridgeFailure = await buildLunaHybridPromotionReviewReport({ queryFn: fakeQueryWithBridgeFailure, hours: 168 });
  assert.equal(bridgeFailure.ok, false);
  assert.equal(bridgeFailure.readyForMasterReview, false);
  assert.equal(bridgeFailure.status, 'luna_hybrid_promotion_review_shadow_data_pending');
  assert.equal(bridgeFailure.promotionEntryTriggerBridge.status, 'promotion_entry_trigger_bridge_query_failed');
  assert.equal(bridgeFailure.promotionEntryTriggerBridge.checked, false);
  assert.equal(
    bridgeFailure.checklist.find((item) => item.name === 'promotion_entry_trigger_bridge_reviewed')?.ok,
    false,
  );
  assert.equal(
    bridgeFailure.blockers.some((blocker) => blocker.name === 'promotion_entry_trigger_bridge_reviewed'),
    true,
  );
  assert.equal(
    bridgeFailure.warnings.some((warning) => String(warning).includes('promotion_entry_trigger_bridge_check:bridge table missing')),
    true,
  );

  const noDb = await runLunaHybridPromotionReview({ json: true, strict: true, noDb: true, hours: 168 } as any) as PromotionReviewSmokeReport;
  assert.equal(noDb.ok, true);
  assert.equal(noDb.dataChecked, false);
  assert.equal(noDb.dataRequired, false);
  assert.equal(noDb.readyForMasterReview, false);
  assert.equal(noDb.promotionReady, false);
  assert.equal(noDb.status, 'luna_hybrid_promotion_review_contract_only');
  assert.equal(noDb.blockers.length, 0);

  const applyBlocked = await runLunaHybridPromotionReview({ apply: true, json: true, noDb: true, hours: 168 } as any) as PromotionReviewSmokeReport;
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
  await (runCliMain as any)({
    run: main,
    errorPrefix: 'luna hybrid promotion review smoke failed:',
  });
}
