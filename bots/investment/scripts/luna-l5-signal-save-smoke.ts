#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import * as db from '../shared/db.ts';
import l30SignalSave from '../nodes/l30-signal-save.ts';
import { listHanulExecutableSignals } from '../team/hanul.ts';
import {
  buildLunaRiskEvaluationSignal,
  buildLunaSignalPersistencePlan,
} from '../team/luna.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function uniqueSymbol(prefix) {
  return `${prefix}${Date.now().toString(36).toUpperCase()}/USDT`;
}

async function cleanup(symbols = []) {
  if (!Array.isArray(symbols) || symbols.length === 0) return;
  await db.run(
    `DELETE FROM signals WHERE symbol = ANY($1::text[])`,
    [symbols],
  ).catch(() => {});
  await db.run(
    `DELETE FROM position_strategy_profiles WHERE symbol = ANY($1::text[])`,
    [symbols],
  ).catch(() => {});
}

async function runApprovedInitialStatusSmoke() {
  const symbol = uniqueSymbol('L5APPROVE');
  try {
    const result = await l30SignalSave.run({
      sessionId: `luna-l5-approve-${Date.now()}`,
      market: 'binance',
      symbol,
      decision: {
        symbol,
        action: 'BUY',
        amount_usdt: 42,
        confidence: 0.82,
        reasoning: 'L5 smoke approved signal should be inserted as approved',
      },
      risk: {
        approved: true,
        adjustedAmount: 37,
        nemesis_verdict: 'modified',
        approved_at: '2026-04-25T00:00:00.000Z',
      },
    });

    assert.equal(result.status, 'approved');
    assert.ok(result.signalId);

    const row = await db.getSignalById(result.signalId);
    assert.equal(row.status, 'approved');
    assert.equal(row.nemesis_verdict, 'modified');
    assert.equal(new Date(row.approved_at).toISOString(), '2026-04-25T00:00:00.000Z');
    assert.equal(Number(row.amount_usdt), 37);

    return { signalId: result.signalId, status: row.status, amount: Number(row.amount_usdt) };
  } finally {
    await cleanup([symbol]);
  }
}

async function runRejectedInitialStatusSmoke() {
  const symbol = uniqueSymbol('L5REJECT');
  try {
    const result = await l30SignalSave.run({
      sessionId: `luna-l5-reject-${Date.now()}`,
      market: 'binance',
      symbol,
      decision: {
        symbol,
        action: 'BUY',
        amount_usdt: 42,
        confidence: 0.32,
        reasoning: 'L5 smoke rejected signal should not be executable pending',
      },
      risk: {
        approved: false,
        reason: 'smoke_risk_rejected',
        adjustedAmount: null,
      },
    });

    assert.equal(result.status, 'rejected');
    assert.ok(result.signalId);

    const row = await db.getSignalById(result.signalId);
    assert.equal(row.status, 'rejected');
    assert.equal(row.block_code, 'risk_rejected');
    assert.match(row.block_reason || '', /smoke_risk_rejected/);

    return { signalId: result.signalId, status: row.status, blockCode: row.block_code };
  } finally {
    await cleanup([symbol]);
  }
}

async function runHanulApprovedRecoverySmoke() {
  const pendingSymbol = uniqueSymbol('L5HANULPENDING').replace('/USDT', '');
  const approvedSymbol = uniqueSymbol('L5HANULAPPROVED').replace('/USDT', '');
  try {
    const pendingId = await db.insertSignal({
      symbol: pendingSymbol,
      action: 'BUY',
      amountUsdt: 500000,
      confidence: 0.51,
      reasoning: 'L5 smoke pending stock signal',
      status: 'pending',
      exchange: 'kis',
      tradeMode: 'normal',
    });
    const approvedId = await db.insertSignal({
      symbol: approvedSymbol,
      action: 'BUY',
      amountUsdt: 500000,
      confidence: 0.71,
      reasoning: 'L5 smoke approved stock signal should be recoverable by Hanul',
      status: 'approved',
      exchange: 'kis',
      tradeMode: 'normal',
      nemesisVerdict: 'approved',
      approvedAt: '2026-04-25T00:00:00.000Z',
    });

    const result = await listHanulExecutableSignals('kis', 'normal');
    const ids = new Set(result.signals.map((signal) => signal.id));
    assert.equal(result.pendingCount >= 1, true);
    assert.equal(result.approvedCount >= 1, true);
    assert.equal(ids.has(pendingId), true);
    assert.equal(ids.has(approvedId), true);

    return {
      pendingId,
      approvedId,
      pendingCount: result.pendingCount,
      approvedCount: result.approvedCount,
    };
  } finally {
    await cleanup([pendingSymbol, approvedSymbol]);
  }
}

function runDirectPathPersistencePlanSmoke() {
  const signalData = {
    symbol: 'L5DIRECT/USDT',
    action: 'BUY',
    amountUsdt: 123,
    confidence: 0.77,
    reasoning: 'direct path L5 persistence smoke',
    exchange: 'binance',
    tradeMode: 'normal',
  };

  const riskInput = buildLunaRiskEvaluationSignal(signalData);
  assert.equal(riskInput.amount_usdt, 123);
  assert.equal(riskInput.trade_mode, 'normal');

  const approved = buildLunaSignalPersistencePlan(signalData, {
    approved: true,
    adjustedAmount: 88,
    nemesis_verdict: 'modified',
    approved_at: '2026-04-25T00:00:00.000Z',
  }, null, {
    exchange: 'binance',
    symbol: signalData.symbol,
    action: signalData.action,
    decision: { amount_usdt: 123, confidence: 0.77 },
  });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.signalData.amountUsdt, 88);
  assert.equal(approved.signalData.nemesisVerdict, 'modified');
  assert.equal(approved.signalData.approvedAt, '2026-04-25T00:00:00.000Z');

  const rejected = buildLunaSignalPersistencePlan(signalData, {
    approved: false,
    reason: 'direct_path_rejected',
    adjustedAmount: null,
  }, null, {
    exchange: 'binance',
    symbol: signalData.symbol,
    action: signalData.action,
    decision: { amount_usdt: 123, confidence: 0.77 },
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.blockUpdate.code, 'risk_rejected');
  assert.match(rejected.blockUpdate.reason, /direct_path_rejected/);

  const failed = buildLunaSignalPersistencePlan(signalData, null, new Error('risk service unavailable'), {
    exchange: 'binance',
    symbol: signalData.symbol,
    action: signalData.action,
    decision: { amount_usdt: 123, confidence: 0.77 },
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.blockUpdate.code, 'nemesis_error');
  assert.match(failed.blockUpdate.reason, /risk service unavailable/);

  return {
    riskInputAmount: riskInput.amount_usdt,
    approvedStatus: approved.status,
    rejectedStatus: rejected.status,
    failedStatus: failed.status,
  };
}

export async function runLunaL5SignalSaveSmoke() {
  await db.initSchema();
  const approved = await runApprovedInitialStatusSmoke();
  const rejected = await runRejectedInitialStatusSmoke();
  const hanulRecovery = await runHanulApprovedRecoverySmoke();
  const directPath = runDirectPathPersistencePlanSmoke();
  return { ok: true, approved, rejected, hanulRecovery, directPath };
}

async function main() {
  const result = await runLunaL5SignalSaveSmoke();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log('luna L5 signal save smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna L5 signal save smoke 실패:',
  });
}
