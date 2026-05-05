#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import * as db from '../shared/db.ts';
import { recordDiscoveryAttribution, buildDiscoveryReflectionSummary } from '../shared/discovery-reflection.ts';

const ACTIONS = { BUY: 'BUY' };
const SIGNAL_STATUS = { APPROVED: 'approved' };

export async function runLunaReflectionFeedbackSmoke() {
  await db.initSchema();
  const unique = `REFLECT_${Date.now()}`;
  let inserted = null;
  try {
    inserted = await db.insertSignalIfFresh({
      symbol: unique,
      action: ACTIONS.BUY,
      amountUsdt: 100,
      confidence: 0.67,
      reasoning: 'reflection smoke',
      status: SIGNAL_STATUS.APPROVED,
      exchange: 'binance',
      analystSignals: 'A:B|O:B|H:H|S:B',
    });
    assert.ok(inserted?.id);

    const attribution = await recordDiscoveryAttribution({
      signalId: inserted.id,
      source: 'smoke_discovery',
      setupType: 'breakout_confirmation',
      triggerType: 'mtf_alignment',
      discoveryScore: 0.73,
      predictiveScore: 0.69,
      note: 'smoke',
    });
    assert.equal(attribution?.source, 'smoke_discovery');

    const row = await db.get(`SELECT block_meta FROM signals WHERE id = $1`, [inserted.id]);
    assert.ok(row?.block_meta?.discoveryAttribution);

    const summary = await buildDiscoveryReflectionSummary({ days: 7, exchange: 'binance' });
    assert.ok(typeof summary?.generatedAt === 'string');
    assert.ok(Array.isArray(summary?.bySource));

    return {
      ok: true,
      signalId: inserted.id,
      attribution: row?.block_meta?.discoveryAttribution || null,
      reflectionRows: summary.totalRows,
    };
  } finally {
    if (inserted?.id) {
      await db.run(`DELETE FROM signals WHERE id = $1`, [inserted.id]).catch(() => {});
    }
  }
}

async function main() {
  const result = await runLunaReflectionFeedbackSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna reflection feedback smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna reflection feedback smoke 실패:',
  });
}
