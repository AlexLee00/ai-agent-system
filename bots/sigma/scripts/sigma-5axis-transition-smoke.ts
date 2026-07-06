#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  attachSourceRefToMeta,
  extractSourceRef,
  sourceRefKey,
  sourceRefMatches,
} from '../shared/source-ref.ts';
import { appendTransitionTelemetry } from '../shared/transition-telemetry.ts';
import {
  applyTeamTransitionPlan,
  buildTeamTransitionPlan,
} from '../vault/validation-transition.ts';

function row(id, title, sourceRef, validationState = 'unverified') {
  return {
    id,
    title,
    meta: {
      source_ref: sourceRef,
      libraryCoords: {
        abstraction_level: 'L0',
        time_stage: 'raw',
        validation_state: validationState,
        prediction_state: 'none',
      },
    },
  };
}

function trigger(id, polarity, title = 'repeat lesson') {
  return {
    team: 'blog',
    source_ref: { team: 'blog', table: 'blog.posts', id },
    polarity,
    reason: `fixture_${polarity}`,
    occurredAt: '2026-07-06T00:00:00.000Z',
    lessonKey: title,
    evidence: { fixture: true },
  };
}

async function main() {
  const meta = attachSourceRefToMeta(
    { team: 'blog', sourceTable: 'blog.posts', sourceId: 42 },
    null,
  );
  assert.deepEqual(meta.source_ref, { team: 'blog', table: 'blog.posts', id: '42' });
  assert.equal(sourceRefKey(extractSourceRef({ meta })), 'blog:blog.posts:42');
  assert.equal(sourceRefMatches(meta.source_ref, { team: 'blog', table: 'blog.posts', id: '42' }), true);

  const vaultRows = [
    row('entry-positive', 'repeat lesson', { team: 'blog', table: 'blog.posts', id: '1' }),
    row('entry-negative', 'risk lesson', { team: 'blog', table: 'blog.posts', id: '2' }, 'validated'),
    row('entry-neutral', 'neutral lesson', { team: 'blog', table: 'blog.posts', id: '3' }),
    row('existing-a', 'repeat lesson', { team: 'blog', table: 'blog.posts', id: 'a' }, 'validated'),
    row('existing-b', 'repeat lesson', { team: 'blog', table: 'blog.posts', id: 'b' }, 'validated'),
    row('risk-existing-a', 'risk lesson', { team: 'blog', table: 'blog.posts', id: 'risk-a' }, 'validated'),
    row('risk-existing-b', 'risk lesson', { team: 'blog', table: 'blog.posts', id: 'risk-b' }, 'validated'),
  ];
  const plan = buildTeamTransitionPlan({
    vaultRows,
    triggers: [
      trigger('1', 'positive'),
      trigger('2', 'negative', 'risk lesson'),
      trigger('3', 'neutral', 'neutral lesson'),
      trigger('404', 'positive', 'missing lesson'),
    ],
  });

  const positive = plan.find((item) => item.id === 'entry-positive');
  const negative = plan.find((item) => item.id === 'entry-negative');
  const neutral = plan.find((item) => item.id === 'entry-neutral');
  const missing = plan.find((item) => item.sourceRef?.id === '404');

  assert.equal(positive.nextCoords.validation_state, 'validated');
  assert.equal(positive.metaPatch.promotion_candidate, true);
  assert.equal(positive.metaPatch.promotion_candidate_count, 3);
  assert.equal(negative.nextCoords.validation_state, 'contradicted');
  assert.equal(negative.metaPatch.promotion_candidate ?? false, false);
  assert.equal(neutral.apply, false);
  assert.equal(missing.matched, false);

  const offResult = await applyTeamTransitionPlan(plan, {
    env: {},
    pg: {
      queryReadonly: async () => { throw new Error('should_not_query_when_off'); },
      query: async () => { throw new Error('should_not_write_when_off'); },
    },
  });
  assert.equal(offResult.count, 0);
  assert.equal(offResult.skipped, true);

  const calls = [];
  const coordColumns = ['abstraction_level', 'time_stage', 'validation_state', 'prediction_state', 'prediction_horizon'];
  const onResult = await applyTeamTransitionPlan(plan, {
    env: { SIGMA_TRANSITION_ENABLED: 'true' },
    pg: {
      queryReadonly: async () => coordColumns.map((column_name) => ({ column_name })),
      query: async (schema, sql, params) => {
        calls.push({ schema, sql, params });
        return [];
      },
    },
  });
  assert.equal(onResult.count, 2);
  assert.equal(calls.every((call) => call.schema === 'sigma'), true);
  assert.equal(calls.some((call) => /UPDATE sigma\.vault_entries/.test(call.sql)), true);
  assert.equal(calls.some((call) => /INSERT INTO sigma\.vault_audit/.test(call.sql)), true);

  const tmp = path.join(os.tmpdir(), `sigma-transition-${process.pid}.jsonl`);
  try { fs.unlinkSync(tmp); } catch {}
  const telemetry = appendTransitionTelemetry({ type: 'smoke', counts: { applied: onResult.count } }, { path: tmp });
  assert.equal(telemetry.ok, true);
  const line = fs.readFileSync(tmp, 'utf8').trim();
  assert.equal(JSON.parse(line).type, 'smoke');

  const result = {
    ok: true,
    assertions: {
      sourceRef: true,
      positive: true,
      negative: true,
      negativeNoPromotion: true,
      neutral: true,
      promotion: true,
      envOffNoWrite: true,
      envOnSigmaOnlyWrite: true,
      telemetry: true,
    },
  };
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
  process.exitCode = 1;
});
