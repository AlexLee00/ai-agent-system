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
  const lateStageKeys = {
    stage_4: `smoke:stage4:${symbol}`,
    stage_5: `smoke:stage5:${symbol}`,
    stage_6: `smoke:stage6:${symbol}`,
    stage_7: `smoke:stage7:${symbol}`,
    stage_8: `smoke:stage8:${symbol}`,
  };

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
  for (const [stageId, idempotencyKey] of Object.entries(lateStageKeys)) {
    await recordPositionLifecycleStageEvent({
      symbol,
      exchange: 'binance',
      tradeMode: 'normal',
      stageId,
      ownerAgent: 'smoke',
      eventType: stageId === 'stage_7'
        ? 'review_completed'
        : stageId === 'stage_8'
          ? 'feedback_applied'
          : 'completed',
      outputSnapshot: { ok: true, stageId },
      idempotencyKey,
    });
  }

  const inserted = await db.query(
    `SELECT idempotency_key, stage_id
       FROM position_lifecycle_events
      WHERE idempotency_key = ANY($1)
      ORDER BY created_at ASC`,
    [[stage2Key, ...Object.values(lateStageKeys)]],
  );
  const stageByKey = Object.fromEntries((inserted || []).map((row) => [row.idempotency_key, row.stage_id]));
  const cases = [
    { name: 'phase2_maps_stage2', pass: stageByKey[stage2Key] === 'stage_2' },
    { name: 'explicit_stage4_kept', pass: stageByKey[lateStageKeys.stage_4] === 'stage_4' },
    { name: 'explicit_stage5_kept', pass: stageByKey[lateStageKeys.stage_5] === 'stage_5' },
    { name: 'explicit_stage6_kept', pass: stageByKey[lateStageKeys.stage_6] === 'stage_6' },
    { name: 'explicit_stage7_kept', pass: stageByKey[lateStageKeys.stage_7] === 'stage_7' },
    { name: 'explicit_stage8_kept', pass: stageByKey[lateStageKeys.stage_8] === 'stage_8' },
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
