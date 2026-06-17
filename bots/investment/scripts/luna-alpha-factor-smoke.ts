#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert';
import { evaluateCandidateBacktestStatus } from '../shared/candidate-backtest-gate.ts';
import {
  evaluateAlphaExpression,
  parseAlphaExpression,
} from '../shared/luna-alpha-factor-expression.ts';
import {
  buildCandidateBacktestRowFromAlpha,
  buildPointInTimeFactorSamples,
  evaluateAlphaFactorIc,
} from '../shared/luna-alpha-factor-ic.ts';
import { fixtureAlphaCandidates } from '../shared/luna-alpha-factor-generator.ts';
import {
  buildSyntheticAlphaRows,
  LUNA_ALPHA_FACTOR_CONFIRM,
  runLunaAlphaFactor,
} from './runtime-luna-alpha-factor.ts';
import { LUNA_COMPONENT_REGISTRY_SEED } from './luna-registry-seed.ts';

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

async function runSmoke() {
  const scenarios = [];

  const expression = '(return_20d * 0.5) + (roe * 0.3) + log(volume)';
  const parsed = parseAlphaExpression(expression);
  assert(parsed.complexity <= 12);
  const row = { return_20d: 0.1, roe: 0.2, volume: 1_000_000 };
  const value1 = evaluateAlphaExpression(parsed, row);
  const value2 = evaluateAlphaExpression(parsed, row);
  assert(Number.isFinite(value1));
  assert.strictEqual(value1, value2);
  assert.throws(() => parseAlphaExpression('eval(close)'), /forbidden/i);
  assert.throws(() => parseAlphaExpression('close; process.exit()'), /forbidden/i);
  scenarios.push('expression_safe_deterministic');

  const candidates = fixtureAlphaCandidates({ maxComplexity: 12 });
  const rows = buildSyntheticAlphaRows({ days: 90 });
  const samples = buildPointInTimeFactorSamples(candidates[0], rows, { horizonDays: 5 });
  assert(samples.length > 0);
  assert(samples.every((sample) => sample.universeAsOf <= sample.asOfDate));
  const metrics = evaluateAlphaFactorIc(candidates[0], rows, {
    horizonDays: 5,
    permutationIterations: 16,
  });
  assert(metrics.sampleCount > 0);
  assert(metrics.dateCount > 0);
  assert(Number.isFinite(metrics.ic));
  assert(Number.isFinite(metrics.rankIc));
  assert(metrics.permutationP == null || Number.isFinite(metrics.permutationP));
  scenarios.push('pit_ic_rankic_permutation');

  const futureRows = rows.slice(0, 20).map((item) => ({ ...item, futureReturn: 0.1 }));
  assert.throws(
    () => buildPointInTimeFactorSamples(candidates[0], futureRows, { horizonDays: 1 }),
    /lookahead_field/i
  );
  scenarios.push('lookahead_feature_rejected');

  const badGateRow = buildCandidateBacktestRowFromAlpha({
    candidate: { name: 'bad_alpha' },
    sampleCount: 2,
    rankIr: 0,
    permutationP: 1,
    ic: 0,
  }, { market: 'domestic', minSampleDays: 60 });
  const badGate = evaluateCandidateBacktestStatus(badGateRow, {});
  assert.strictEqual(badGate.wouldBlock, true);
  scenarios.push('candidate_gate_evidence');

  const noWriteRun = await runLunaAlphaFactor({
    candidates: [candidates[0]],
    fixture: true,
    apply: false,
    horizonDays: 5,
    permutationIterations: 8,
  }, {
    runFn: async () => { throw new Error('unexpected_write'); },
  });
  assert.strictEqual(noWriteRun.written, 0);
  assert.strictEqual(noWriteRun.canWrite, false);
  scenarios.push('dry_run_zero_writes');

  let wrongConfirmWrites = 0;
  const wrongConfirmRun = await runLunaAlphaFactor({
    candidates: [candidates[0]],
    fixture: true,
    apply: true,
    confirm: 'wrong',
    horizonDays: 5,
    permutationIterations: 8,
  }, {
    runFn: async () => { wrongConfirmWrites += 1; },
  });
  assert.strictEqual(wrongConfirmRun.written, 0);
  assert.strictEqual(wrongConfirmRun.confirmRequired, true);
  assert.strictEqual(wrongConfirmWrites, 0);
  scenarios.push('confirm_mismatch_zero_writes');

  const writes = [];
  const applyRun = await runLunaAlphaFactor({
    candidates: [candidates[0]],
    fixture: true,
    apply: true,
    confirm: LUNA_ALPHA_FACTOR_CONFIRM,
    horizonDays: 5,
    permutationIterations: 8,
  }, {
    ensureSchema: async () => writes.push({ type: 'schema' }),
    runFn: async (sql, params) => {
      writes.push({ type: 'run', sql, params });
      if (String(sql).includes('INSERT INTO luna_alpha_factors')) return { rows: [{ id: 1001 }] };
      return { rows: [] };
    },
  });
  assert.strictEqual(applyRun.written, 1);
  assert(writes.some((item) => item.type === 'schema'));
  assert(writes.filter((item) => item.type === 'run').length >= 2);
  scenarios.push('apply_confirm_inserts_factor_and_evaluation');

  const components = LUNA_COMPONENT_REGISTRY_SEED.map((row) => row.component);
  assert(components.length >= 38);
  assert(components.includes('alpha-factor-discovery'));
  scenarios.push('registry_seed_contains_alpha_factor');

  assert.strictEqual(applyRun.liveMutation, false);
  assert.strictEqual(applyRun.summary.autoPromotion, false);
  assert(applyRun.results.every((result) => result.evidence.autoPromotion === false));
  scenarios.push('no_auto_signal_or_skill_promotion');

  return { ok: true, scenarios };
}

const result = await runSmoke();
if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
else console.log(`luna-alpha-factor-smoke ok (${result.scenarios.length} scenarios)`);
