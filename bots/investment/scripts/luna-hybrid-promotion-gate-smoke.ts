#!/usr/bin/env node

import assert from 'node:assert/strict';
import { buildLunaHybridPromotionGateReport } from '../shared/luna-hybrid-promotion-gate.ts';
import { runLunaHybridPromotionGate } from './runtime-luna-hybrid-promotion-gate.ts';
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

export async function runLunaHybridPromotionGateSmoke() {
  const report = await buildLunaHybridPromotionGateReport({ queryFn: fakeQuery, hours: 168 });
  assert.equal(report.ok, true, JSON.stringify(report.blockers, null, 2));
  assert.equal(report.shadowMode, true);
  assert.equal(report.liveMutation, false);
  assert.equal(report.protectedPidMutation, false);
  assert.equal(report.contractReady, true);
  assert.equal(report.dataReady, true);
  assert.equal(report.manualPromotionReviewCandidate, true);
  assert.equal(report.promotionReady, false);
  assert.equal(report.status, 'luna_hybrid_promotion_gate_ready_for_master_review');
  assert.equal(report.summary.contractFailures, 0);
  assert.equal(report.summary.securityFailures, 0);
  assert.equal(report.blockers.length, 0);
  assert.ok(report.contractChecks.some((item) => item.phase === 10 && item.ok));

  const noDb = await runLunaHybridPromotionGate({ json: true, strict: true, noDb: true, hours: 168 });
  assert.equal(noDb.ok, true);
  assert.equal(noDb.contractReady, true);
  assert.equal(noDb.dataChecked, false);
  assert.equal(noDb.dataRequired, false);
  assert.equal(noDb.dataReady, false);
  assert.equal(noDb.status, 'luna_hybrid_promotion_gate_contract_only');
  assert.equal(noDb.warnings.length, 0);

  const applyBlocked = await runLunaHybridPromotionGate({ apply: true, json: true, noDb: true, hours: 168 });
  assert.equal(applyBlocked.ok, false);
  assert.equal(applyBlocked.status, 'luna_hybrid_promotion_gate_apply_blocked');
  assert.equal(applyBlocked.liveMutation, false);

  return {
    ok: true,
    smoke: 'luna-hybrid-promotion-gate-phase10',
    status: report.status,
    noDbStatus: noDb.status,
    phases: report.summary.phases,
    promotionReady: report.promotionReady,
    manualPromotionReviewCandidate: report.manualPromotionReviewCandidate,
    liveMutation: report.liveMutation,
  };
}

async function main() {
  const result = await runLunaHybridPromotionGateSmoke();
  console.log(JSON.stringify(result, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: 'luna hybrid promotion gate smoke failed:',
  });
}
