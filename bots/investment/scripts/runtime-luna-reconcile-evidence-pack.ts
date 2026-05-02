#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildLunaReconcileBlockerReport } from './luna-reconcile-blocker-report.ts';
import { buildLunaReconcileEvidencePackFromReport } from '../shared/luna-reconcile-evidence-pack.ts';

function hasFlag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

export async function buildLunaReconcileEvidencePack({
  exchange = 'binance',
  hours = 24,
  limit = 100,
} = {}) {
  const report = await buildLunaReconcileBlockerReport({ exchange, hours, limit });
  return buildLunaReconcileEvidencePackFromReport(report);
}

export async function runLunaReconcileEvidencePackSmoke() {
  const pack = buildLunaReconcileEvidencePackFromReport({
    checkedAt: '2026-01-01T00:00:00.000Z',
    exchange: 'binance',
    blockers: [
      {
        id: 'sig-1',
        symbol: 'LUNC/USDT',
        action: 'BUY',
        blockCode: 'manual_reconcile_required',
        resolutionClass: 'manual_reconcile_required',
        severity: 'hard_block',
        identifiers: {},
      },
      {
        id: 'sig-2',
        symbol: 'UTK/USDT',
        action: 'BUY',
        blockCode: 'manual_reconcile_required',
        resolutionClass: 'manual_ack_required',
        severity: 'hard_block',
        identifiers: { clientOrderId: 'cid-2', recoveryErrorCode: 'binance_order_lookup_not_found' },
      },
      {
        id: 'sig-3',
        symbol: 'MEGA/USDT',
        action: 'SELL',
        blockCode: 'broker_execution_error',
        resolutionClass: 'exchange_lookup_retry',
        severity: 'hard_block',
        identifiers: { clientOrderId: 'cid-mega' },
      },
      {
        id: 'sig-4',
        symbol: 'BTC/USDT',
        resolutionClass: 'acknowledged',
        severity: 'acknowledged',
        acked: true,
        reconcileAck: { status: 'acknowledged', ackedAt: '2026-01-01T00:00:00.000Z' },
      },
    ],
  });
  assert.equal(pack.ok, false);
  assert.equal(pack.summary.manualReconcileRequired, 1);
  assert.equal(pack.summary.manualAckRequired, 1);
  assert.equal(pack.summary.exchangeLookupRetry, 1);
  assert.equal(pack.summary.acknowledgedHistory, 1);
  assert.equal(pack.manualTasks[0].safeToAutomate, false);
  assert.ok(pack.ackTasks[0].requiredEvidence.includes('preflight_evidence_hash_or_operator_evidence_ref'));
  assert.ok(pack.lookupRetryTasks[0].requiredEvidence.includes('fresh_exchange_lookup_result_by_client_order_id'));
  assert.match(pack.lookupRetryTasks[0].evidenceHash, /^[a-f0-9]{64}$/);
  return { ok: true, pack };
}

async function main() {
  const smoke = hasFlag('--smoke');
  const json = hasFlag('--json');
  const result = smoke ? await runLunaReconcileEvidencePackSmoke() : await buildLunaReconcileEvidencePack({
    exchange: argValue('--exchange', 'binance'),
    hours: Number(argValue('--hours', 24)),
    limit: Number(argValue('--limit', 100)),
  });
  if (json) console.log(JSON.stringify(result, null, 2));
  else if (smoke) console.log('luna reconcile evidence pack smoke ok');
  else console.log(`${result.status} manual=${result.summary.manualReconcileRequired} ack=${result.summary.manualAckRequired}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna reconcile evidence pack 실패:',
  });
}
