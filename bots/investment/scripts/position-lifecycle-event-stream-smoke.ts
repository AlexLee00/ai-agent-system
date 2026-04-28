#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import * as db from '../shared/db.ts';
import {
  deriveLifecycleStageId,
  POSITION_STAGE_LABELS,
  recordLifecyclePhaseSnapshot,
  recordPositionLifecycleStageEvent,
} from '../shared/lifecycle-contract.ts';
import { assertSmokePass } from '../shared/smoke-assert.ts';

export async function runPositionLifecycleEventStreamSmoke({ json = false, strict = true } = {}) {
  await db.initSchema();
  const symbol = `SMOKE_STAGE_${Date.now()}`;
  const stage2Key = `smoke:stage2:${symbol}`;
  const stage8Key = `smoke:stage8:${symbol}`;

  await recordLifecyclePhaseSnapshot({
    symbol,
    exchange: 'binance',
    tradeMode: 'normal',
    phase: 'phase2_analyze',
    ownerAgent: 'smoke',
    eventType: 'completed',
    outputSnapshot: { ok: true },
    idempotencyKey: stage2Key,
  });
  await recordPositionLifecycleStageEvent({
    symbol,
    exchange: 'binance',
    tradeMode: 'normal',
    stageId: 'stage_8',
    ownerAgent: 'smoke',
    eventType: 'feedback_applied',
    outputSnapshot: { ok: true },
    idempotencyKey: stage8Key,
  });

  const inserted = await db.query(
    `SELECT idempotency_key, stage_id
       FROM position_lifecycle_events
      WHERE idempotency_key IN ($1, $2)
      ORDER BY created_at ASC`,
    [stage2Key, stage8Key],
  );
  const stageByKey = Object.fromEntries((inserted || []).map((row) => [row.idempotency_key, row.stage_id]));
  const cases = [
    { name: 'phase2_maps_stage2', pass: stageByKey[stage2Key] === 'stage_2' },
    { name: 'explicit_stage8_kept', pass: stageByKey[stage8Key] === 'stage_8' },
    { name: 'derive_review_stage7', pass: deriveLifecycleStageId('phase6_closeout', 'review_completed') === 'stage_7' },
    { name: 'derive_strategy_mutation_stage4', pass: deriveLifecycleStageId('phase5_monitor', 'strategy_mutated') === 'stage_4' },
    { name: 'stage_labels_cover_stage8', pass: POSITION_STAGE_LABELS.stage_8 === 'feedback_learning' },
  ];
  const passed = cases.filter((c) => c.pass).length;
  const total = cases.length;
  const summary = { pass: passed === total, passed, total, results: cases, inserted };
  if (strict) assertSmokePass(summary, '[position-lifecycle-event-stream-smoke]');
  if (json) return summary;
  return {
    ...summary,
    text: [
      `[position-lifecycle-event-stream-smoke] ${passed}/${total} 통과`,
      ...cases.map((item) => `${item.pass ? '✓' : '✗'} ${item.name}`),
    ].join('\n'),
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => {
      const json = process.argv.includes('--json');
      return runPositionLifecycleEventStreamSmoke({ json, strict: true });
    },
    onSuccess: async (result) => {
      if (result?.text) console.log(result.text);
      else console.log(JSON.stringify(result, null, 2));
    },
    errorPrefix: '[position-lifecycle-event-stream-smoke]',
  });
}
