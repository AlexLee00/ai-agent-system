#!/usr/bin/env node
// @ts-nocheck
// Canonical smoke: operations DB contact is forbidden; persistence uses an in-memory sink.

import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ensureStrategySignalsSchema } from '../shared/luna-strategy-families.ts';
import {
  LUNA_SIGNAL_OUTCOME_CONFIRM,
  buildSignalOutcomeSummary,
  evaluateSignalOutcome,
  upsertSignalOutcome,
} from '../shared/luna-signal-outcome.ts';
import { runLunaSignalOutcomeEval } from './runtime-luna-signal-outcome-eval.ts';
import { LUNA_COMPONENT_REGISTRY_SEED } from './luna-registry-seed.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const INVESTMENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION_PATH = path.join(INVESTMENT_ROOT, 'migrations', '20260619000004_luna_strategy_signal_outcomes.sql');

function signal(overrides: any = {}) {
  return {
    id: overrides.id ?? 101,
    family: overrides.family || 'testah_pullback',
    market: overrides.market || 'domestic',
    symbol: overrides.symbol || '005930',
    candle_ts: overrides.candle_ts || '2026-06-01T00:00:00.000Z',
    price: overrides.price ?? 100,
    target: overrides.target ?? 120,
    stop: overrides.stop ?? 90,
    rr: overrides.rr ?? 2,
    regime: overrides.regime || { dominant: 'sideways' },
  };
}

function bar(day: number, extra: any = {}) {
  return {
    timestamp: new Date(Date.parse('2026-06-01T00:00:00.000Z') + day * 86_400_000).toISOString(),
    open: extra.open ?? 100,
    high: extra.high ?? 105,
    low: extra.low ?? 95,
    close: extra.close ?? 100,
    volume: extra.volume ?? 1000,
  };
}

async function main() {
  const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf8');

  const win = evaluateSignalOutcome(signal(), [
    bar(0, { high: 999, low: 1, close: 100 }),
    bar(1, { high: 121, low: 99, close: 120 }),
  ], { maxBars: 20 });
  assert.equal(win.outcome, 'win');
  assert.equal(win.exitReason, 'target_hit');
  assert.equal(win.realizedR, 2);
  assert.equal(win.barsEvaluated, 1);

  const loss = evaluateSignalOutcome(signal(), [
    bar(1, { high: 110, low: 89, close: 90 }),
  ], { maxBars: 20 });
  assert.equal(loss.outcome, 'loss');
  assert.equal(loss.exitReason, 'stop_hit');
  assert.equal(loss.realizedR, -1);

  const stopFirst = evaluateSignalOutcome(signal(), [
    bar(1, { high: 121, low: 89, close: 110 }),
  ], { maxBars: 20 });
  assert.equal(stopFirst.outcome, 'loss');
  assert.equal(stopFirst.exitReason, 'stop_hit');

  const expired = evaluateSignalOutcome(signal(), [
    bar(1, { high: 110, low: 95, close: 105 }),
    bar(2, { high: 111, low: 96, close: 106 }),
  ], { maxBars: 2 });
  assert.equal(expired.outcome, 'expired');
  assert.equal(expired.exitReason, 'time_expired');
  assert.equal(expired.realizedR, 0.6);
  assert.equal(expired.realizedPnlPct, 6);

  const open = evaluateSignalOutcome(signal(), [
    bar(1, { high: 110, low: 95, close: 104 }),
  ], { maxBars: 2 });
  assert.equal(open.outcome, 'open');
  assert.equal(open.exitReason, 'still_open');
  assert.equal(open.realizedR, 0.4);

  const sameDayExcluded = evaluateSignalOutcome(signal(), [
    bar(0, { high: 121, low: 99, close: 120 }),
    bar(1, { high: 110, low: 95, close: 105 }),
  ], { maxBars: 2 });
  assert.equal(sameDayExcluded.outcome, 'open');
  assert.equal(sameDayExcluded.barsEvaluated, 1);

  const smallSummary = buildSignalOutcomeSummary([win, loss, expired, open]);
  assert.equal(smallSummary.groups[0].insufficientSample, '4/30');
  assert.equal(smallSummary.groups[0].winRate, null);
  assert.equal(smallSummary.groups[0].avgRealizedR, null);
  assert.equal(smallSummary.groups[0].provisionalWinRate, 0.25);

  const outcomeRows = new Map();
  const runFn = async (sql: string, params: any[] = []) => {
    if (/INSERT INTO luna_strategy_signals/i.test(sql)) {
      return { rowCount: 1, rows: [{ id: 101 }] };
    }
    if (/INSERT INTO luna_strategy_signal_outcomes/i.test(sql)) {
      const signalId = String(params[0]);
      const existing = outcomeRows.get(signalId);
      outcomeRows.set(signalId, { id: existing?.id || outcomeRows.size + 1, outcome: params[10], params });
      return { rowCount: 1, rows: [{ id: outcomeRows.get(signalId).id }] };
    }
    return { rowCount: 0, rows: [] };
  };
  await ensureStrategySignalsSchema(runFn);
  await runFn(migrationSql);
  const insert = await runFn(
    `INSERT INTO luna_strategy_signals
       (market, symbol, family, signal_type, candle_ts, price, stop, target, rr, regime, matched, rule_version, details)
     VALUES ('domestic', $1, 'testah_pullback', 'entry', $2, 100, 90, 120, 2, '{"dominant":"sideways"}'::jsonb, false, 'v1', '{}'::jsonb)
     RETURNING id`,
    [`SMOKE${Date.now()}`, '2026-06-01T00:00:00.000Z'],
  );
  const signalId = insert.rows?.[0]?.id;
  const openOutcome = evaluateSignalOutcome(signal({ id: signalId }), [
    bar(1, { high: 110, low: 95, close: 104 }),
  ], { maxBars: 2, requireSignalId: true });
  await upsertSignalOutcome(openOutcome, runFn);
  const winOutcome = evaluateSignalOutcome(signal({ id: signalId }), [
    bar(1, { high: 121, low: 95, close: 120 }),
  ], { maxBars: 2, requireSignalId: true });
  await upsertSignalOutcome(winOutcome, runFn);
  assert.equal(outcomeRows.size, 1);
  assert.equal(outcomeRows.get(String(signalId))?.outcome, 'win');
  const transactional = { upsertOutcome: outcomeRows.get(String(signalId))?.outcome };

  const runtimeDry = await runLunaSignalOutcomeEval({
    dryRun: true,
    signals: [signal({ id: 7001, symbol: 'AAPL', market: 'overseas' })],
    barsBySignalId: {
      7001: [bar(1, { high: 121, low: 99, close: 120 })],
    },
  });
  assert.equal(runtimeDry.evaluated, 1);
  assert.equal(runtimeDry.written, 0);
  assert.equal(runtimeDry.counts.win, 1);

  const upsertCalls = [];
  const runtimeApply = await runLunaSignalOutcomeEval({
    apply: true,
    confirm: LUNA_SIGNAL_OUTCOME_CONFIRM,
    signals: [signal({ id: 7002 })],
    barsBySignalId: {
      7002: [bar(1, { high: 121, low: 99, close: 120 })],
    },
  }, {
    upsertSignalOutcome: async (row: any) => {
      upsertCalls.push(row);
      return { rows: [{ id: 1 }] };
    },
  });
  assert.equal(runtimeApply.written, 1);
  assert.equal(upsertCalls.length, 1);

  const liveSample = evaluateSignalOutcome(signal({ id: 35, symbol: '005930', price: 322500, target: 370000, stop: 287500, rr: 1.357143 }), [
    { timestamp: '2026-06-02T00:00:00.000Z', open: 322500, high: 370000, low: 320000, close: 370000, volume: 1 },
  ], { maxBars: 20 });
  assert.equal(String(liveSample.signalId), '35');
  assert(['win', 'loss', 'expired', 'open'].includes(liveSample.outcome));

  const components = LUNA_COMPONENT_REGISTRY_SEED.map((row: any) => row.component);
  assert(components.includes('signal-outcome-feedback'));
  assert(components.includes('signal-outcome-eval-runner'));

  return {
    ok: true,
    smoke: 'luna-signal-outcome',
    scenarios: {
      win: win.exitReason,
      loss: loss.exitReason,
      sameBarStopFirst: stopFirst.outcome,
      expired: expired.realizedR,
      open: open.realizedR,
      sameDayExcluded: true,
      insufficientSample: smallSummary.groups[0].insufficientSample,
      upsertOutcome: transactional.upsertOutcome,
      runtimeDryRun: runtimeDry.counts,
      runtimeApplyWritten: runtimeApply.written,
      sample005930: liveSample.outcome,
      registrySeedCount: LUNA_COMPONENT_REGISTRY_SEED.length,
    },
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: '❌ luna-signal-outcome-smoke 실패:',
  });
}

export { main as runLunaSignalOutcomeSmoke };
