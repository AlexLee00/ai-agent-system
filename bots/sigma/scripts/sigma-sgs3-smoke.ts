#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRuntimeSigmaPredictionLedger } from './runtime-sigma-prediction-ledger.ts';
import {
  applyPredictionLedgerPlan,
  applyTeamTransitionPlan,
  buildPredictionAccuracy,
  buildPredictionLedgerTransitionPlan,
  buildTeamTransitionPlan,
} from '../vault/validation-transition.ts';

function vaultRow(id, coords = {}, extra = {}) {
  return {
    id,
    title: id,
    source: extra.source || 'smoke',
    created_at: extra.created_at || '2026-07-01T00:00:00.000Z',
    meta: {
      ...(extra.meta || {}),
      source_ref: extra.source_ref,
      libraryCoords: {
        abstraction_level: 'L0',
        time_stage: 'raw',
        validation_state: 'observed',
        prediction_state: 'none',
        ...coords,
      },
    },
  };
}

async function main() {
  const now = new Date('2026-07-07T00:00:00.000Z');
  const rows = [
    vaultRow('forward-past', { prediction_state: 'forward', prediction_horizon: '2026-07-06T00:00:00.000Z' }),
    vaultRow('forward-future', { prediction_state: 'forward', prediction_horizon: '2026-07-08T00:00:00.000Z' }),
    vaultRow('due-hit', { prediction_state: 'due', validation_state: 'validated', prediction_horizon: '2026-07-06T00:00:00.000Z' }),
    vaultRow('due-miss', { prediction_state: 'due', validation_state: 'contradicted', prediction_horizon: '2026-07-06T00:00:00.000Z' }),
    vaultRow('due-wait', { prediction_state: 'due', validation_state: 'observed', prediction_horizon: '2026-07-06T00:00:00.000Z' }),
    vaultRow('resolved-hit', { prediction_state: 'resolved', validation_state: 'validated', prediction_horizon: '2026-07-02T00:00:00.000Z' }, { source: 'luna' }),
    vaultRow('resolved-miss', { prediction_state: 'resolved', validation_state: 'contradicted', prediction_horizon: '2026-07-02T00:00:00.000Z' }, { source: 'blog' }),
  ];

  const plan = buildPredictionLedgerTransitionPlan({ rows, now });
  assert.equal(plan.filter((item) => item.reason === 'prediction_horizon_due' && item.apply).length, 1);
  assert.equal(plan.find((item) => item.id === 'forward-past').nextCoords.prediction_state, 'due');
  assert.equal(plan.some((item) => item.id === 'forward-future'), false);
  assert.equal(plan.find((item) => item.id === 'due-hit').metaPatch.prediction_outcome, 'hit');
  assert.equal(plan.find((item) => item.id === 'due-miss').metaPatch.prediction_outcome, 'miss');
  assert.equal(plan.find((item) => item.id === 'due-wait').apply, false);

  const accuracy = buildPredictionAccuracy({ rows });
  assert.equal(accuracy.overall.total, 2);
  assert.equal(accuracy.overall.hit, 1);
  assert.equal(accuracy.overall.miss, 1);
  assert.equal(accuracy.overall.accuracy, 0.5);
  assert.equal(accuracy.bySource.luna.hit, 1);
  assert.equal(accuracy.bySource.blog.miss, 1);

  const offApply = await applyPredictionLedgerPlan(plan, {
    env: {},
    pg: {
      queryReadonly: async () => { throw new Error('gate_off_should_not_query'); },
      query: async () => { throw new Error('gate_off_should_not_write'); },
    },
  });
  assert.equal(offApply.skipped, true);
  assert.equal(offApply.count, 0);

  const writes = [];
  const onApply = await applyPredictionLedgerPlan(plan, {
    env: { SIGMA_PREDICTION_ENABLED: 'true' },
    pg: {
      queryReadonly: async () => ['abstraction_level', 'time_stage', 'validation_state', 'prediction_state', 'prediction_horizon'].map((column_name) => ({ column_name })),
      query: async (schema, sql, params) => {
        writes.push({ schema, sql, params });
        return [];
      },
    },
  });
  assert.equal(onApply.count, 3);
  assert.equal(writes.length, 6);
  assert.equal(writes.every((call) => call.schema === 'sigma'), true);
  assert.equal(writes.some((call) => /UPDATE sigma\.vault_entries/.test(call.sql)), true);
  assert.equal(writes.some((call) => /INSERT INTO sigma\.vault_audit/.test(call.sql)), true);

  const sourceRef = { team: 'blog', table: 'blog.posts', id: '42' };
  const teamRows = [
    vaultRow('due-source-hit', { prediction_state: 'due', validation_state: 'observed' }, { source_ref: sourceRef }),
    vaultRow('due-source-miss', { prediction_state: 'due', validation_state: 'observed' }, { source_ref: { ...sourceRef, id: '43' } }),
  ];
  const triggers = [
    { team: 'blog', source_ref: sourceRef, polarity: 'positive', reason: 'validated_fixture', lessonKey: 'sgs3' },
    { team: 'blog', source_ref: { ...sourceRef, id: '43' }, polarity: 'negative', reason: 'contradicted_fixture', lessonKey: 'sgs3-risk' },
  ];
  const wOnly = buildTeamTransitionPlan({ vaultRows: teamRows, triggers, predictionEnabled: false, now });
  const pLinked = buildTeamTransitionPlan({ vaultRows: teamRows, triggers, predictionEnabled: true, now });
  assert.equal(wOnly.find((item) => item.id === 'due-source-hit').nextCoords.prediction_state, undefined);
  assert.equal(pLinked.find((item) => item.id === 'due-source-hit').nextCoords.prediction_state, 'resolved');
  assert.equal(pLinked.find((item) => item.id === 'due-source-hit').metaPatch.prediction_outcome, 'hit');
  assert.equal(pLinked.find((item) => item.id === 'due-source-miss').metaPatch.prediction_outcome, 'miss');

  const teamWrites = [];
  const pLinkedApplyWithPredictionOff = await applyTeamTransitionPlan(pLinked, {
    env: { SIGMA_TRANSITION_ENABLED: 'true' },
    pg: {
      queryReadonly: async () => ['abstraction_level', 'time_stage', 'validation_state', 'prediction_state', 'prediction_horizon'].map((column_name) => ({ column_name })),
      query: async (schema, sql, params) => {
        teamWrites.push({ schema, sql, params });
        return [];
      },
    },
  });
  assert.equal(pLinkedApplyWithPredictionOff.count, 2);
  assert.equal(JSON.stringify(teamWrites).includes('prediction_outcome'), false);
  assert.equal(JSON.stringify(teamWrites).includes('prediction_state ='), false);

  const tmp = path.join(os.tmpdir(), `sigma-sgs3-${process.pid}.jsonl`);
  try { fs.unlinkSync(tmp); } catch {}
  const runtime = await buildRuntimeSigmaPredictionLedger({
    rows,
    now,
    dryRun: true,
    apply: false,
    telemetryPath: tmp,
  });
  assert.equal(runtime.counts.forwardToDueCandidates, 1);
  assert.equal(runtime.counts.dueToResolvedCandidates, 2);
  assert.equal(runtime.liveMutation, false);
  assert.equal(JSON.parse(fs.readFileSync(tmp, 'utf8').trim()).type, 'sigma_prediction_ledger');

  console.log(JSON.stringify({
    ok: true,
    smoke: 'sigma-sgs3',
    checks: {
      forwardToDueDry: true,
      dueToResolved: true,
      accuracy: true,
      pEqualsWTrigger: true,
      pAxisApplyGate: true,
      teamWriteZero: true,
      regression5AxisDefaultUnchanged: true,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }, null, 2));
  process.exitCode = 1;
});
