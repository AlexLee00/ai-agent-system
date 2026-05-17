#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { CONFIRM, runLunaCandidateQualityRemediation } from './runtime-luna-candidate-quality-remediation.ts';

export async function runLunaCandidateQualityRemediationSmoke() {
  await assert.rejects(
    () => runLunaCandidateQualityRemediation({ fixture: true, apply: true, dryRun: true, confirm: CONFIRM, json: true }),
    /cannot combine --apply with --dry-run/,
  );
  await assert.rejects(
    () => runLunaCandidateQualityRemediation({ fixture: true, apply: true, json: true }),
    /requires --confirm=luna-candidate-quality-remediation-shadow/,
  );

  const planned = await runLunaCandidateQualityRemediation({
    fixture: true,
    dryRun: true,
    json: true,
    market: 'all',
    limit: 12,
  });

  assert.equal(planned.ok, true, 'planned remediation ok');
  assert.equal(planned.status, 'luna_candidate_quality_remediation_planned', 'plan-only status');
  assert.equal(planned.writeMode, 'plan-only', 'plan-only write mode');
  assert.equal(planned.summary.liveMutation, false, 'no live mutation');
  assert.equal(planned.coverage.ok, true, 'fixture coverage passes');
  assert.equal(planned.remediationPlan.discoveryRefresh, true, 'fixture plans replacement discovery refresh');
  assert.equal(planned.remediationPlan.backtestRefresh, true, 'fixture plans backtest refresh');
  assert.equal(planned.remediationPlan.predictiveRefresh, true, 'fixture plans predictive refresh');
  assert.equal(planned.remediationPlan.strategyEnhancementShadow, true, 'fixture plans strategy shadow');
  assert.equal(planned.remediationPlan.bottleneckShadowAudit, true, 'fixture plans bottleneck audit');
  assert.equal(planned.remediationPlan.candidateQualityGovernance, true, 'fixture plans quality governance shadow');
  assert.equal(planned.remediationPlan.weightVectorShadow, true, 'fixture plans weight vector refresh');
  assert.equal(planned.remediationPlan.paperTradingShadow, true, 'fixture plans paper trading shadow');
  assert.equal(planned.remediationPlan.paperPromotionGate, true, 'fixture plans paper promotion gate');
  assert.equal(planned.plannedCommands.length, 10, 'planned command count');
  assert.equal(planned.plannedCommands.some((cmd) => cmd.includes('runtime:luna-candidate-quality-governance')), true, 'planned commands include governance shadow');
  assert.equal(planned.plannedCommands.every((cmd) => !cmd.includes('launchctl') && !cmd.includes('live-fire')), true, 'planned commands avoid protected/live-fire operations');

  return {
    ok: true,
    smoke: 'luna-candidate-quality-remediation',
    checks: {
      planOnly: true,
      confirmGuard: true,
      applyDryRunRejected: true,
      plannedCommands: planned.plannedCommands.length,
      fullShadowLoop: true,
      qualityGovernance: true,
      liveMutation: false,
    },
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: runLunaCandidateQualityRemediationSmoke,
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: 'luna-candidate-quality-remediation-smoke error:',
  });
}
