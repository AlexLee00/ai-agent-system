#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { isRecentEvidence } from '../shared/luna-reconcile-evidence-pack.ts';
import { verifyAckCandidateAgainstExchange } from './luna-reconcile-ack-preflight.ts';

export async function runLunaReconcileAckEvidenceSmoke() {
  const missing = isRecentEvidence({});
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'preflight_evidence_hash_invalid');

  const expired = isRecentEvidence({
    evidenceHash: 'a'.repeat(64),
    expiresAt: '2026-01-01T00:00:00.000Z',
    now: new Date('2026-01-01T00:01:00.000Z'),
  });
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, 'preflight_evidence_expired');

  const found = await verifyAckCandidateAgainstExchange({
    id: 'sig-found',
    symbol: 'UTK/USDT',
    action: 'BUY',
    resolutionClass: 'manual_ack_required',
    identifiers: { clientOrderId: 'cid-found', recoveryErrorCode: 'binance_order_lookup_not_found' },
  }, {
    fetchOrder: async () => ({ id: 'order-1', status: 'closed', filled: 1, cost: 10 }),
  });
  assert.equal(found.status, 'order_found_block_ack');
  assert.equal(found.readyToAck, false);

  const absent = await verifyAckCandidateAgainstExchange({
    id: 'sig-absent',
    symbol: 'UTK/USDT',
    action: 'BUY',
    resolutionClass: 'manual_ack_required',
    identifiers: { clientOrderId: 'cid-absent', recoveryErrorCode: 'binance_order_lookup_not_found' },
  }, {
    fetchOrder: async () => {
      const error = new Error('binance_order_lookup_not_found');
      error.code = 'binance_order_lookup_not_found';
      throw error;
    },
  });
  assert.equal(absent.status, 'order_absent_confirmed');
  assert.equal(absent.readyToAck, true);
  assert.match(absent.evidenceHash, /^[a-f0-9]{64}$/);
  assert.equal(isRecentEvidence({
    evidenceHash: absent.evidenceHash,
    expiresAt: absent.evidenceExpiresAt,
    now: new Date(absent.checkedAt),
  }).ok, true);

  return { ok: true, missing, expired, found, absent };
}

async function main() {
  const result = await runLunaReconcileAckEvidenceSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna reconcile ack evidence smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna reconcile ack evidence smoke 실패:',
  });
}
