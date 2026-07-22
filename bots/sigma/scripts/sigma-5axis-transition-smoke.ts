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
  fetchValidatedVaultRows,
} from '../vault/validation-transition.ts';
import {
  collectBlogTriggers,
  collectClaudeTriggers,
  collectSkaTriggers,
} from './runtime-sigma-5axis-transition.ts';
import { isSigmaToLunaFeedbackWriteEnabled } from '../a2a/skills/sigma-to-luna-feedback.ts';
import { sourceRefForLibraryRecord } from '../shared/source-ref.ts';

function row(id, title, sourceRef, validationState = 'unverified', metaPatch = {}) {
  return {
    id,
    title,
    meta: {
      ...metaPatch,
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
  assert.deepEqual(sourceRefForLibraryRecord({
    team: 'sigma',
    sourceKind: 'dpo_preference',
    sourceId: 9,
  }), { team: 'sigma', table: 'public.sigma_dpo_preference_pairs', id: '9' });
  assert.deepEqual(sourceRefForLibraryRecord({
    team: 'luna',
    sourceKind: 'luna_reflexion',
    sourceId: 10,
  }), { team: 'luna', table: 'investment.luna_failure_reflexions', id: '10' });
  assert.deepEqual(sourceRefForLibraryRecord({
    team: 'hub',
    sourceKind: 'hub_alarm',
    sourceId: 11,
  }), { team: 'hub', table: 'agent.hub_alarms', id: '11' });
  assert.deepEqual(sourceRefForLibraryRecord({
    team: 'luna',
    sourceKind: 'agent_message',
    sourceId: 12,
  }), { team: 'luna', table: 'investment.agent_messages', id: '12' });

  const vaultRows = [
    row('entry-positive', 'repeat lesson', { team: 'blog', table: 'blog.posts', id: '1' }),
    row('entry-negative', 'risk lesson', { team: 'blog', table: 'blog.posts', id: '2' }, 'validated', {
      promotion_candidate: true,
      promotion_candidate_reason: 'validated_repeat_threshold',
      promotion_candidate_count: 3,
    }),
    row('entry-neutral', 'neutral lesson', { team: 'blog', table: 'blog.posts', id: '3' }),
  ];
  const validatedHistoryRows = [
    row('existing-a', 'repeat lesson', { team: 'blog', table: 'blog.posts', id: 'a' }, 'validated'),
    row('existing-b', 'repeat lesson', { team: 'blog', table: 'blog.posts', id: 'b' }, 'validated'),
    row('risk-existing-a', 'risk lesson', { team: 'blog', table: 'blog.posts', id: 'risk-a' }, 'validated'),
    row('risk-existing-b', 'risk lesson', { team: 'blog', table: 'blog.posts', id: 'risk-b' }, 'validated'),
  ];
  const plan = buildTeamTransitionPlan({
    vaultRows,
    validatedHistoryRows,
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
  assert.equal(positive.metaPatch.validation_lesson_key, 'repeat lesson');
  assert.equal(positive.metaPatch.promotion_candidate, true);
  assert.equal(positive.metaPatch.promotion_candidate_count, 3);
  assert.equal(negative.nextCoords.validation_state, 'contradicted');
  assert.equal(negative.metaPatch.promotion_candidate, false);
  assert.equal(negative.metaPatch.promotion_candidate_reason, 'validation_contradicted');
  assert.equal(negative.metaPatch.promotion_candidate_count, 2);
  assert.equal(neutral.apply, false);
  assert.equal(missing.matched, false);

  const projectedPlan = buildTeamTransitionPlan({
    vaultRows: [
      row('projected-positive', 'projected lesson', { team: 'blog', table: 'blog.posts', id: '21' }),
      row('projected-negative', 'projected lesson', { team: 'blog', table: 'blog.posts', id: '22' }, 'validated'),
    ],
    validatedHistoryRows: [
      row('projected-history', 'projected lesson', { team: 'blog', table: 'blog.posts', id: '23' }, 'validated'),
    ],
    triggers: [
      trigger('21', 'positive', 'projected lesson'),
      trigger('22', 'negative', 'projected lesson'),
    ],
  });
  assert.equal(projectedPlan.find((item) => item.id === 'projected-positive').metaPatch.promotion_candidate ?? false, false);

  const historyQueries = [];
  await fetchValidatedVaultRows({
    lessonKeys: [' Repeat   Lesson '],
    limit: 25,
    queryReadonly: async (schema, sql, params) => {
      historyQueries.push({ schema, sql, params });
      if (/information_schema/.test(sql)) return [];
      return [];
    },
  });
  assert.equal(historyQueries.every((call) => call.schema === 'sigma'), true);
  assert.match(historyQueries.at(-1).sql, /= 'validated'/);
  assert.match(historyQueries.at(-1).sql, /COALESCE\(status, 'captured'\) <> 'archived'/);
  assert.match(historyQueries.at(-1).sql, /merged_into/);
  assert.deepEqual(historyQueries.at(-1).params, [['repeat lesson'], 25]);

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
  const transitionUpdate = calls.find((call) => /UPDATE sigma\.vault_entries/.test(call.sql));
  assert.match(transitionUpdate.sql, /\{libraryCoords\}/);
  assert.equal(transitionUpdate.params.some((param) => String(param).includes('validation_state')), true);
  assert.equal(isSigmaToLunaFeedbackWriteEnabled({}), false);
  assert.equal(isSigmaToLunaFeedbackWriteEnabled({ SIGMA_LUNA_FEEDBACK_WRITE_ENABLED: 'true' }), true);

  const noOpPlan = buildTeamTransitionPlan({
    vaultRows: [
      row('already-negative', 'already negative', { team: 'blog', table: 'blog.posts', id: '10' }, 'contradicted'),
      row('validated-a', 'two repeats', { team: 'blog', table: 'blog.posts', id: '11' }, 'validated'),
      row('validated-b', 'two repeats', { team: 'blog', table: 'blog.posts', id: '12' }, 'validated'),
      row('candidate-a', 'candidate lesson', { team: 'blog', table: 'blog.posts', id: '13' }, 'validated', {
        promotion_candidate: true,
        promotion_candidate_reason: 'validated_repeat_threshold',
        promotion_candidate_count: 3,
      }),
      row('candidate-b', 'candidate lesson', { team: 'blog', table: 'blog.posts', id: '14' }, 'validated'),
      row('candidate-c', 'candidate lesson', { team: 'blog', table: 'blog.posts', id: '15' }, 'validated'),
    ],
    triggers: [
      trigger('10', 'negative', 'already negative'),
      trigger('11', 'positive', 'two repeats'),
      trigger('13', 'positive', 'candidate lesson'),
    ],
  });
  const alreadyNegative = noOpPlan.find((item) => item.id === 'already-negative');
  const alreadyValidated = noOpPlan.find((item) => item.id === 'validated-a');
  const existingCandidate = noOpPlan.find((item) => item.id === 'candidate-a');
  assert.equal(alreadyNegative.apply, false);
  assert.equal(alreadyValidated.metaPatch.promotion_candidate ?? false, false);
  assert.equal(alreadyValidated.apply, false);
  assert.equal(existingCandidate.apply, false);

  const noOpCalls = [];
  const noOpResult = await applyTeamTransitionPlan(noOpPlan, {
    env: { SIGMA_TRANSITION_ENABLED: 'true' },
    pg: {
      queryReadonly: async () => coordColumns.map((column_name) => ({ column_name })),
      query: async (...args) => {
        noOpCalls.push(args);
        return [];
      },
    },
  });
  assert.equal(noOpResult.count, 0);
  assert.equal(noOpCalls.length, 0);

  const claudeTriggers = await collectClaudeTriggers({
    sinceHours: 24,
    limit: 10,
    queryReadonly: async () => [{
      id: 91,
      pr_number: 12,
      total: 95,
      verdict: 'pass',
      created_at: '2026-07-06T00:00:00.000Z',
      outcome_id: 497,
    }],
  });
  assert.deepEqual(claudeTriggers[0].source_ref, {
    team: 'claude',
    table: 'claude.auto_dev_outcomes',
    id: 'claude_auto_dev:497',
  });

  const blogQueries = [];
  await collectBlogTriggers({
    sinceHours: 24,
    limit: 10,
    queryReadonly: async (_schema, sql, params) => {
      blogQueries.push({ sql, params });
      return [];
    },
  });
  const crankQuery = blogQueries.find((call) => /blog\.crank_scores/.test(call.sql));
  assert.match(crankQuery.sql, /FROM \(\s*SELECT DISTINCT ON \(post_id\)/);
  assert.match(crankQuery.sql, /ORDER BY created_at DESC, id DESC\s*LIMIT \$2/);

  const skaHistory = path.join(os.tmpdir(), `sigma-ska-shadow-${process.pid}.jsonl`);
  fs.writeFileSync(skaHistory, `${JSON.stringify({
    recordedAt: '2026-07-08 16:26:45',
    today: '2026-07-08',
    ok: true,
    skipped: false,
    scannerOk: true,
    counts: { todayMissingInLegacy: 0, todayMissingInUnified: 0, futureUnifiedOnly: 8 },
  })}\n`, 'utf8');
  const skaTriggers = collectSkaTriggers({
    historyPath: skaHistory,
    now: new Date('2026-07-08T08:00:00.000Z'),
    sinceHours: 24,
  });
  assert.equal(skaTriggers[0].polarity, 'positive');
  assert.deepEqual(skaTriggers[0].source_ref, {
    team: 'ska',
    table: 'reservation.daily_summary',
    id: '2026-07-08',
  });

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
      dpoSourceRef: true,
      positive: true,
      negative: true,
      negativeNoPromotion: true,
      neutral: true,
      promotion: true,
      promotionHistoryRead: true,
      promotionNegativeProjection: true,
      envOffNoWrite: true,
      envOnSigmaOnlyWrite: true,
      idempotentTransition: true,
      validatedRepeatNotDoubleCounted: true,
      claudeTriggerMatchesIngestedSourceRef: true,
      blogCrankGlobalLatestLimit: true,
      skaShadowTrigger: true,
      coordColumnMetaMirror: true,
      lunaFeedbackWriteGate: true,
      telemetry: true,
    },
  };
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
  process.exitCode = 1;
});
