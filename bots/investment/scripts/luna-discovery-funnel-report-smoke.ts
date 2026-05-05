#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../shared/db.ts';
import { ensureCandidateUniverseTable } from '../team/discovery/discovery-store.ts';
import { ensureLunaDiscoveryEntryTables } from '../shared/luna-discovery-entry-store.ts';
import { buildLunaDiscoveryFunnelReport } from './runtime-luna-discovery-funnel-report.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function seedFixture(symbol, historyFile) {
  await db.run(
    `INSERT INTO candidate_universe
       (symbol, market, source, source_tier, score, confidence, reason, reason_code, ttl_hours, raw_data, expires_at)
     VALUES
       ($1, 'crypto', 'smoke_funnel', 1, 0.84, 0.80, 'smoke candidate', 'smoke_ready', 2, '{}'::jsonb, now() + interval '2 hours')
     ON CONFLICT (symbol, market, source) DO UPDATE SET
       score = excluded.score,
       confidence = excluded.confidence,
       discovered_at = now(),
       expires_at = now() + interval '2 hours'`,
    [symbol],
  );
  await db.run(
    `INSERT INTO discovery_source_metrics
       (id, source, market, quality_status, signal_count, reliability, freshness_score, confidence_score, notes, raw_meta)
     VALUES
       ($1, 'smoke_funnel', 'crypto', 'ready', 1, 0.9, 1, 0.85, 'smoke', '{}'::jsonb)`,
    [`smoke-funnel-metric-${symbol}`],
  );
  await db.run(
    `INSERT INTO signals
       (symbol, action, amount_usdt, confidence, reasoning, status, exchange, trade_mode)
     VALUES
       ($1, 'BUY', 25, 0.82, 'smoke funnel signal', 'approved', 'binance', 'normal')`,
    [symbol],
  );
  await db.run(
    `INSERT INTO signals
       (symbol, action, amount_usdt, confidence, reasoning, status, exchange, trade_mode, block_code, block_reason, quality_flag, exclude_from_learning)
     VALUES
       ($1, 'BUY', 25, 0.10, 'reflection smoke', 'failed', 'binance', 'normal', 'synthetic_reflection_signal', 'reflection smoke signal excluded from execution queue', 'exclude_from_learning', true)`,
    [`REFLECT_${Date.now()}`],
  );
  await db.run(
    `INSERT INTO entry_triggers
       (id, symbol, exchange, trigger_type, trigger_state, confidence, predictive_score, expires_at, trigger_context, trigger_meta, updated_at)
     VALUES
       ($1, $2, 'binance', 'smoke_funnel', 'armed', 0.82, 0.78, now() + interval '2 hours', '{}'::jsonb, '{}'::jsonb, now())`,
    [`smoke-funnel-trigger-${symbol}`, symbol],
  );
  fs.writeFileSync(historyFile, `${JSON.stringify({
    recordedAt: new Date().toISOString(),
    status: 'position_runtime_autopilot_executed',
    dispatchCandidateCount: 1,
    dispatchExecutedCount: 0,
    dispatchQueuedCount: 0,
    dispatchRetryingCount: 0,
    dispatchSkippedCount: 0,
    dispatchFailureCount: 0,
    dispatchMarketQueue: { total: 0, waitingMarketOpen: 0 },
  })}\n`);
}

async function cleanupFixture(symbol) {
  await db.run(`DELETE FROM entry_triggers WHERE symbol = $1`, [symbol]).catch(() => null);
  await db.run(`DELETE FROM signals WHERE symbol = $1 AND reasoning = 'smoke funnel signal'`, [symbol]).catch(() => null);
  await db.run(`DELETE FROM signals WHERE symbol LIKE 'REFLECT_%' AND block_code = 'synthetic_reflection_signal' AND reasoning = 'reflection smoke'`).catch(() => null);
  await db.run(`DELETE FROM discovery_source_metrics WHERE id = $1`, [`smoke-funnel-metric-${symbol}`]).catch(() => null);
  await db.run(`DELETE FROM candidate_universe WHERE symbol = $1 AND source = 'smoke_funnel'`, [symbol]).catch(() => null);
}

export async function runLunaDiscoveryFunnelReportSmoke() {
  await db.initSchema();
  await ensureCandidateUniverseTable();
  await ensureLunaDiscoveryEntryTables();
  const symbol = `FUNNEL${Date.now()}/USDT`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-funnel-'));
  const historyFile = path.join(dir, 'history.jsonl');
  try {
    await seedFixture(symbol, historyFile);
    const report = await buildLunaDiscoveryFunnelReport({
      hours: 1,
      market: 'crypto',
      historyFile,
    });
    const crypto = report.markets.find((item) => item.market === 'crypto');
    assert.equal(report.ok, true);
    assert.ok(crypto, 'crypto market report should exist');
    assert.ok(crypto.candidateUniverse.activeCount >= 1, 'candidate universe should include smoke candidate');
    assert.ok(crypto.signalPersistence.buyCount >= 1, 'signal persistence should include smoke BUY');
    assert.ok(crypto.signalPersistence.ignoredCount >= 1, 'synthetic reflection signal should be tracked as ignored');
    assert.ok(crypto.entryTriggers.activeCount >= 1, 'entry trigger should include smoke armed trigger');
    assert.equal(report.autopilot.totals.candidateCount, 1, 'autopilot dispatch candidate count should come from fixture history');
    assert.equal(report.nextAction, 'continue_observation', 'complete fixture funnel should not request repair action');
    return {
      ok: true,
      smoke: 'luna-discovery-funnel-report',
      status: report.status,
      market: crypto.market,
      candidateCount: crypto.candidateUniverse.activeCount,
      buyCount: crypto.signalPersistence.buyCount,
      activeTriggers: crypto.entryTriggers.activeCount,
    };
  } finally {
    await cleanupFixture(symbol);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const result = await runLunaDiscoveryFunnelReportSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna-discovery-funnel-report-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna-discovery-funnel-report-smoke 실패:',
  });
}
