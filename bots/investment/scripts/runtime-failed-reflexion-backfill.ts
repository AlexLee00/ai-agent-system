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

export async function runFailedReflexionBackfill({
  limit = Number(argValue('limit', 200)),
  dryRun = hasArg('apply') ? false : isFailedSignalBackfillDryRunDefault(),
  confirm = argValue('confirm', ''),
  signals = null,
} = {}) {
  const applyRequested = !dryRun;
  if (applyRequested && confirm !== FAILED_SIGNAL_REFLEXION_CONFIRM) {
    return {
      ok: false,
      status: 'confirm_required',
      dryRun,
      confirmRequired: FAILED_SIGNAL_REFLEXION_CONFIRM,
      processed: 0,
      persisted: 0,
    };
  }

  const loaded = signals || await loadFailedSignals({ limit });
  const plan = buildFailedSignalReflexionBackfillPlan({
    signals: loaded,
    limit,
    dryRun,
  });
  if (dryRun) {
    return {
      ok: true,
      status: 'dry_run',
      dryRun: true,
      totalFailedSignals: loaded.length,
      processed: plan.selected,
      persisted: 0,
      byKind: plan.byKind,
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
  for (const signal of loaded.slice(0, limit)) {
    try {
      const result = await onSignalFailed(signal, { force: true, dryRun: false });
      if (result.persisted) persisted++;
    } catch (error) {
      errors.push({ id: signal.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    ok: errors.length === 0,
    status: errors.length === 0 ? 'applied' : 'partial_failure',
    dryRun: false,
    totalFailedSignals: loaded.length,
    processed: Math.min(limit, loaded.length),
    persisted,
    errors,
  };
}

export async function runFailedReflexionBackfillSmoke() {
  const fixtures = [
    { id: 'sig-a', symbol: 'ORCA/USDT', action: 'buy', status: 'failed', reason: 'provider_cooldown' },
    { id: 'sig-b', symbol: 'UTK/USDT', action: 'buy', status: 'failed', reason: 'manual_reconcile_required' },
    { id: 'sig-c', symbol: 'BTC/USDT', action: 'buy', status: 'failed', reason: 'min_order' },
  ];
  const dry = await runFailedReflexionBackfill({ signals: fixtures, limit: 10, dryRun: true });
  if (!dry.ok || dry.persisted !== 0 || dry.processed !== 3) throw new Error('dry-run backfill contract failed');
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
