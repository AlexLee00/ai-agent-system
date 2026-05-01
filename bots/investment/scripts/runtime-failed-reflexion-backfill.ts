#!/usr/bin/env node
// @ts-nocheck
import {
  FAILED_SIGNAL_REFLEXION_CONFIRM,
  buildFailedSignalReflexionBackfillPlan,
  isFailedSignalBackfillDryRunDefault,
  onSignalFailed,
} from '../shared/failed-signal-reflexion-trigger.ts';
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasArg(name) {
  return process.argv.includes(`--${name}`);
}

export async function loadFailedSignals({ limit = 200 } = {}) {
  return db.query(
    `SELECT id, symbol, action, status, reasoning, block_reason, block_meta, exchange, created_at
       FROM investment.signals
      WHERE status = 'failed'
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit],
  ).catch(() => []);
}

function chunkRows(rows = [], size = 100) {
  const safeSize = Math.max(1, Math.round(Number(size || 100)));
  const chunks = [];
  for (let index = 0; index < rows.length; index += safeSize) {
    chunks.push(rows.slice(index, index + safeSize));
  }
  return chunks;
}

export async function runFailedReflexionBackfill({
  batchSize = Number(argValue('batch-size', 100)),
  maxBatches = Number(argValue('max-batches', 11)),
  limit = Number(argValue('limit', 0)) || (Number(argValue('batch-size', batchSize)) * Number(argValue('max-batches', maxBatches))),
  dryRun = hasArg('apply') ? false : isFailedSignalBackfillDryRunDefault(),
  confirm = argValue('confirm', ''),
  signals = null,
} = {}) {
  const safeBatchSize = Math.max(1, Math.round(Number(batchSize || 100)));
  const safeMaxBatches = Math.max(1, Math.round(Number(maxBatches || 11)));
  const safeLimit = Math.max(1, Math.round(Number(limit || safeBatchSize * safeMaxBatches)));
  const applyRequested = !dryRun;
  if (applyRequested && confirm !== FAILED_SIGNAL_REFLEXION_CONFIRM) {
    return {
      ok: false,
      status: 'confirm_required',
      dryRun,
      confirmRequired: FAILED_SIGNAL_REFLEXION_CONFIRM,
      batchSize: safeBatchSize,
      maxBatches: safeMaxBatches,
      processed: 0,
      persisted: 0,
    };
  }

  const loaded = signals || await loadFailedSignals({ limit: safeLimit });
  const plan = buildFailedSignalReflexionBackfillPlan({
    signals: loaded,
    limit: safeLimit,
    dryRun,
  });
  const batches = chunkRows(plan.events, safeBatchSize).slice(0, safeMaxBatches);
  if (dryRun) {
    return {
      ok: true,
      status: 'dry_run',
      dryRun: true,
      batchSize: safeBatchSize,
      maxBatches: safeMaxBatches,
      batchCount: batches.length,
      totalFailedSignals: loaded.length,
      processed: plan.selected,
      persisted: 0,
      targetReflexions: safeBatchSize * safeMaxBatches,
      byKind: plan.byKind,
      batches: batches.map((batch, index) => ({
        batch: index + 1,
        size: batch.length,
        firstSignalId: batch[0]?.signalId || null,
        lastSignalId: batch[batch.length - 1]?.signalId || null,
      })),
      sample: plan.events.slice(0, 5).map((event) => ({
        signalId: event.signalId,
        symbol: event.symbol,
        kind: event.classification?.kind,
        syntheticTradeId: event.syntheticTradeId,
      })),
    };
  }

  let persisted = 0;
  const errors = [];
  const selectedSignals = loaded.slice(0, safeLimit);
  const signalBatches = chunkRows(selectedSignals, safeBatchSize).slice(0, safeMaxBatches);
  for (let batchIndex = 0; batchIndex < signalBatches.length; batchIndex += 1) {
    const batch = signalBatches[batchIndex];
    for (const signal of batch) {
      try {
        const result = await onSignalFailed(signal, { force: true, dryRun: false });
        if (result.persisted) persisted++;
      } catch (error) {
        errors.push({
          batch: batchIndex + 1,
          id: signal.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return {
    ok: errors.length === 0,
    status: errors.length === 0 ? 'applied' : 'partial_failure',
    dryRun: false,
    batchSize: safeBatchSize,
    maxBatches: safeMaxBatches,
    batchCount: signalBatches.length,
    totalFailedSignals: loaded.length,
    processed: selectedSignals.length,
    persisted,
    errors,
  };
}

export async function runFailedReflexionBackfillSmoke() {
  const fixtures = [
    { id: 'sig-a', symbol: 'ORCA/USDT', action: 'buy', status: 'failed', reason: 'provider_cooldown' },
    { id: 'sig-b', symbol: 'UTK/USDT', action: 'buy', status: 'failed', reason: 'manual_reconcile_required' },
    { id: 'sig-c', symbol: 'BTC/USDT', action: 'buy', status: 'failed', reason: 'min_order' },
    { id: 'sig-d', symbol: 'ETH/USDT', action: 'buy', status: 'failed', reason: 'risk_gate' },
    { id: 'sig-e', symbol: 'SOL/USDT', action: 'buy', status: 'failed', reason: 'cooldown' },
  ];
  const dry = await runFailedReflexionBackfill({ signals: fixtures, batchSize: 2, maxBatches: 3, dryRun: true });
  if (!dry.ok || dry.persisted !== 0 || dry.processed !== 5 || dry.batchCount !== 3) {
    throw new Error('dry-run batch backfill contract failed');
  }
  const blocked = await runFailedReflexionBackfill({ signals: fixtures, limit: 1, dryRun: false, confirm: 'wrong' });
  if (blocked.ok || blocked.status !== 'confirm_required') throw new Error('confirm gate must block apply');
  return { ok: true, dry, blocked };
}

async function main() {
  const result = process.argv.includes('--smoke')
    ? await runFailedReflexionBackfillSmoke()
    : await runFailedReflexionBackfill();
  if (process.argv.includes('--json') || process.argv.includes('--smoke')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[failed-reflexion-backfill] ${result.status} processed=${result.processed || 0} persisted=${result.persisted || 0}`);
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ failed-reflexion-backfill 실패:' });
}
