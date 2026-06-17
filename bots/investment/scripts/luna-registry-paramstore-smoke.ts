#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import * as db from '../shared/db.ts';
import {
  getParameter,
  listParameterHistory,
  reloadParameters,
  setParameter,
} from '../shared/luna-parameter-store.ts';
import { LUNA_COMPONENT_REGISTRY_SEED, seedLunaComponentRegistry } from './luna-registry-seed.ts';
import {
  attachSampleCounts,
  evaluateRegistryRows,
  LUNA_REGISTRY_EVALUATOR_CONFIRM,
  runLunaRegistryEvaluator,
} from './runtime-luna-registry-evaluator.ts';
import { LUNA_ALPHA_FACTOR_CONFIRM } from './runtime-luna-alpha-factor.ts';
import { LUNA_TOSS_PAPER_MIRROR_CONFIRM } from '../shared/luna-toss-paper-mirror.ts';
import { evaluateLunaAutonomousCommand } from '../shared/luna-autonomous-command-policy.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const ROLLBACK_SENTINEL = 'luna_registry_paramstore_smoke_rollback';

async function withSmokeRollback(work: any) {
  let output;
  try {
    await db.withTransaction(async (tx: any) => {
      output = await work({
        queryFn: tx.query,
        runFn: tx.run,
      });
      throw new Error(ROLLBACK_SENTINEL);
    });
  } catch (error) {
    if (error?.message !== ROLLBACK_SENTINEL) throw error;
    return output;
  } finally {
    reloadParameters();
  }
  throw new Error('luna_registry_paramstore_smoke_expected_rollback');
}

async function main() {
  const stamp = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const envKey = `LUNA_PARAM_SMOKE_MISSING_${stamp.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
  process.env[envKey] = '{"fallback":true}';
  const missingKey = `smoke.missing.${stamp}`;
  reloadParameters();
  const envFallback = await getParameter(missingKey, 'global', {
    bypassCache: true,
    env: { [envKey]: process.env[envKey] },
    queryFn: async () => [],
  });
  assert.deepEqual(envFallback.value, { fallback: true });
  assert.equal(envFallback.source, 'env');

  const transactionalResult = await withSmokeRollback(async (storeDeps: any) => {
    const autoKey = `smoke.auto.${stamp}`;
    await setParameter({ key: autoKey, value: { pass: true }, evidence: 'smoke', changedBy: 'system' }, storeDeps);
    const autoValue = await getParameter(autoKey, 'global', { bypassCache: true, queryFn: storeDeps.queryFn });
    assert.deepEqual(autoValue.value, { pass: true });

    await assert.rejects(
      () => setParameter({ key: 'order_rules', value: { mutable: true }, changedBy: 'master' }, storeDeps),
      /luna_parameter_immutable:order_rules/
    );
    await assert.rejects(
      () => setParameter({ key: 'capital_management.max_daily_loss_pct', value: 0.04, changedBy: 'system' }, storeDeps),
      /luna_parameter_approval_required/
    );

    const historyKey = `smoke.history.${stamp}`;
    await setParameter({ key: historyKey, value: 1, evidence: 'smoke-1', changedBy: 'system' }, storeDeps);
    await setParameter({ key: historyKey, value: 2, evidence: 'smoke-2', changedBy: 'system' }, storeDeps);
    const history = await listParameterHistory(historyKey, 'global', { queryFn: storeDeps.queryFn });
    assert.equal(history.length, 2);
    assert.equal(history[0].value, 2);

    const futureKey = `smoke.future.${stamp}`;
    await setParameter({
      key: futureKey,
      value: 'future',
      evidence: 'smoke-future',
      changedBy: 'system',
      effectiveFrom: new Date(Date.now() + 86_400_000).toISOString(),
    }, storeDeps);
    const futureNow = await getParameter(futureKey, 'global', { bypassCache: true, queryFn: storeDeps.queryFn });
    assert.equal(futureNow, null);
    return { historyRows: history.length };
  });

  const rolledBackRows = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM luna_parameter_store
      WHERE key IN ($1, $2, $3)`,
    [`smoke.auto.${stamp}`, `smoke.history.${stamp}`, `smoke.future.${stamp}`]
  );
  assert.equal(Number(rolledBackRows?.[0]?.count || 0), 0);

  assert.ok(LUNA_COMPONENT_REGISTRY_SEED.length >= 31);
  const seedDryRun = await seedLunaComponentRegistry({ dryRun: true });
  assert.equal(seedDryRun.seeded, LUNA_COMPONENT_REGISTRY_SEED.length);
  const sampleAttached = await attachSampleCounts([
    { component: 'rl-policy-shadow', sample_count: 0 },
  ], {
    sampleCounts: { 'rl-policy-shadow': 31 },
  });
  assert.equal(sampleAttached[0].sample_count, 31);

  const oldDate = new Date(Date.now() - 35 * 86_400_000).toISOString();
  const evaluation = evaluateRegistryRows([
    {
      component: 'mapek',
      current_mode: 'env',
      target_mode: 'autonomous_loop_frame',
      promotion_criteria: { placeholder: true },
      sample_count: 0,
      status: 'active',
      registered_at: oldDate,
    },
    {
      component: 'rl-policy-shadow',
      current_mode: 'shadow',
      target_mode: 'supervised_l4',
      promotion_criteria: { minTrades: 30, readyForPromotion: true },
      sample_count: 31,
      status: 'active',
      registered_at: oldDate,
    },
    {
      component: 'shadow-unvalidated',
      current_mode: 'shadow',
      target_mode: 'supervised_l4',
      promotion_criteria: { minTrades: 30, shadow_unvalidated_passthrough: true },
      sample_count: 3,
      status: 'active',
      registered_at: new Date().toISOString(),
    },
  ], { proposalLimit: 1 });
  assert.equal(evaluation.proposals.length, 2);
  assert.equal(evaluation.notifyNow.length, 1);
  assert.equal(evaluation.deferred.length, 1);
  assert.ok(evaluation.proposals.some((item) => item.type === 'stalled_report'));
  assert.ok(evaluation.proposals.some((item) => item.type === 'promotion_proposal'));

  let calibrationCalled = 0;
  let alphaCalled = 0;
  const paperMirrorCalls = [];
  const evaluatorWithCalibration = await runLunaRegistryEvaluator({
    dryRun: true,
    rows: [],
  }, {
    runLunaRegimeCalibration: async (options: any) => {
      calibrationCalled += 1;
      assert.equal(options.dryRun, true);
      assert.equal(options.write, false);
      return { ok: true, dryRun: true, write: false, rows: [{ market: 'crypto' }], inserted: [] };
    },
    runLunaAlphaFactor: async (options: any) => {
      alphaCalled += 1;
      assert.equal(options.apply, false);
      assert.equal(options.dryRun, true);
      assert.equal(options.fixture, false);
      assert.equal(options.confirm, null);
      return { ok: true, canWrite: false, written: 0, summary: { evaluated: 2, promotionCandidates: 0 } };
    },
    runRuntimeLunaTossPaperMirror: async (options: any) => {
      paperMirrorCalls.push(options);
      assert.equal(options.apply, false);
      assert.equal(options.dryRun, true);
      assert.equal(options.confirm, null);
      assert.equal(options.stage, 's1_paper_mirror');
      return { ok: true, evaluated: options.market === 'domestic' ? 2 : 1, written: 0, placed: 0, rows: [{}, {}].slice(0, options.market === 'domestic' ? 2 : 1) };
    },
  });
  assert.equal(calibrationCalled, 1);
  assert.equal(alphaCalled, 1);
  assert.deepEqual(paperMirrorCalls.map((item) => item.market), ['domestic', 'overseas']);
  assert.equal(evaluatorWithCalibration.calibration.ok, true);
  assert.equal(evaluatorWithCalibration.calibration.rows, 1);
  assert.equal(evaluatorWithCalibration.alpha.ok, true);
  assert.equal(evaluatorWithCalibration.alpha.written, 0);
  assert.equal(evaluatorWithCalibration.paperMirror.ok, true);
  assert.equal(evaluatorWithCalibration.paperMirror.evaluated, 3);
  assert.equal(evaluatorWithCalibration.paperMirror.mirrored, 3);
  assert.equal(evaluatorWithCalibration.paperMirror.written, 0);
  assert.equal(evaluatorWithCalibration.paperMirror.placed, 0);

  const evaluatorSkipCalibration = await runLunaRegistryEvaluator({
    dryRun: true,
    rows: [],
    skipCalibration: true,
    skipAlpha: true,
    skipPaperMirror: true,
  }, {
    runLunaRegimeCalibration: async () => {
      throw new Error('should_not_run');
    },
  });
  assert.equal(evaluatorSkipCalibration.calibration.skipped, true);

  const evaluatorCalibrationFailure = await runLunaRegistryEvaluator({
    dryRun: true,
    rows: [{ component: 'fixture', sample_count: 0, status: 'active', registered_at: new Date().toISOString() }],
    skipAlpha: true,
    skipPaperMirror: true,
  }, {
    runLunaRegimeCalibration: async () => {
      throw new Error('fixture_calibration_down');
    },
  });
  assert.equal(evaluatorCalibrationFailure.calibration.ok, false);
  assert.equal(evaluatorCalibrationFailure.calibration.error, 'fixture_calibration_down');
  assert.equal(evaluatorCalibrationFailure.ok, true);

  let applyAlphaCalled = 0;
  const applyPaperMirrorCalls = [];
  const evaluatorApplyPiggyback = await runLunaRegistryEvaluator({
    apply: true,
    confirm: LUNA_REGISTRY_EVALUATOR_CONFIRM,
    rows: [],
    outputPath: `/tmp/luna-registry-paramstore-smoke-${stamp}.json`,
    skipCalibration: true,
    paperMirrorMarkets: 'domestic,overseas',
    paperMirrorLimit: 7,
  }, {
    runLunaAlphaFactor: async (options: any) => {
      applyAlphaCalled += 1;
      assert.equal(options.apply, true);
      assert.equal(options.dryRun, false);
      assert.equal(options.fixture, false);
      assert.equal(options.confirm, LUNA_ALPHA_FACTOR_CONFIRM);
      return { ok: true, canWrite: true, written: 1, summary: { evaluated: 2, promotionCandidates: 1 } };
    },
    runRuntimeLunaTossPaperMirror: async (options: any) => {
      applyPaperMirrorCalls.push(options);
      assert.equal(options.apply, true);
      assert.equal(options.dryRun, false);
      assert.equal(options.confirm, LUNA_TOSS_PAPER_MIRROR_CONFIRM);
      assert.equal(options.stage, 's1_paper_mirror');
      assert.equal(options.limit, 7);
      return { ok: true, evaluated: 1, written: 1, placed: 0, rows: [{}] };
    },
    runFn: async () => ({ rowCount: 0, rows: [] }),
    publishAlert: async () => ({ ok: true }),
  });
  assert.equal(applyAlphaCalled, 1);
  assert.deepEqual(applyPaperMirrorCalls.map((item) => item.market), ['domestic', 'overseas']);
  assert.equal(evaluatorApplyPiggyback.alpha.canWrite, true);
  assert.equal(evaluatorApplyPiggyback.alpha.written, 1);
  assert.equal(evaluatorApplyPiggyback.alpha.promotionCandidates, 1);
  assert.equal(evaluatorApplyPiggyback.paperMirror.written, 2);
  assert.equal(evaluatorApplyPiggyback.paperMirror.placed, 0);

  const evaluatorSkipPiggybacks = await runLunaRegistryEvaluator({
    dryRun: true,
    rows: [],
    skipCalibration: true,
    skipAlpha: true,
    skipPaperMirror: true,
  }, {
    runLunaAlphaFactor: async () => {
      throw new Error('alpha_should_not_run');
    },
    runRuntimeLunaTossPaperMirror: async () => {
      throw new Error('paper_should_not_run');
    },
  });
  assert.equal(evaluatorSkipPiggybacks.alpha.skipped, true);
  assert.equal(evaluatorSkipPiggybacks.paperMirror.skipped, true);

  const evaluatorPiggybackFailures = await runLunaRegistryEvaluator({
    dryRun: true,
    rows: [],
    skipCalibration: true,
  }, {
    runLunaAlphaFactor: async () => {
      throw new Error('fixture_alpha_down');
    },
    runRuntimeLunaTossPaperMirror: async () => {
      throw new Error('fixture_paper_down');
    },
  });
  assert.equal(evaluatorPiggybackFailures.ok, true);
  assert.equal(evaluatorPiggybackFailures.alpha.ok, false);
  assert.equal(evaluatorPiggybackFailures.alpha.error, 'fixture_alpha_down');
  assert.equal(evaluatorPiggybackFailures.paperMirror.ok, false);
  assert.match(evaluatorPiggybackFailures.paperMirror.error, /fixture_paper_down/);

  assert.equal(evaluateLunaAutonomousCommand('launchctl setenv TEST true').blocked, true);

  return {
    ok: true,
    smoke: 'luna-registry-paramstore',
    parameterStore: {
      envFallback: true,
      autoSetGet: true,
      immutableRejected: true,
      approveSystemRejected: true,
      historyRows: transactionalResult.historyRows,
      futureExcluded: true,
      rollbackVerified: true,
    },
    registry: {
      seedCount: seedDryRun.seeded,
      proposals: evaluation.proposals.length,
      notifyNow: evaluation.notifyNow.length,
      deferred: evaluation.deferred.length,
      calibrationPiggyback: true,
      calibrationSkip: true,
      calibrationFailOpen: true,
      alphaPiggyback: true,
      alphaSkip: true,
      alphaFailOpen: true,
      paperMirrorPiggyback: true,
      paperMirrorSkip: true,
      paperMirrorFailOpen: true,
    },
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: '❌ luna-registry-paramstore-smoke 실패:',
  });
}

export { main as runLunaRegistryParamstoreSmoke };
