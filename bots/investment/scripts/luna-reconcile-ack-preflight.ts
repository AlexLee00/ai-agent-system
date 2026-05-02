#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { fetchBinanceOrder } from '../shared/binance-client.ts';
import { publishAlert } from '../shared/alert-publisher.ts';
import {
  buildLunaReconcileBlockerReport,
} from './luna-reconcile-blocker-report.ts';
import {
  evaluateReconcileAckEligibility,
} from './luna-reconcile-ack.ts';
import {
  buildAckPreflightEvidence,
} from '../shared/luna-reconcile-evidence-pack.ts';

function hasFlag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function classifyLookupError(error = {}) {
  const code = String(error?.code || error?.message || error || '').toLowerCase();
  if (code.includes('not_found')) return 'order_absent_confirmed';
  if (code.includes('ambiguous')) return 'lookup_ambiguous_block_ack';
  return 'lookup_failed_block_ack';
}

function resolveEligibility(candidate = {}) {
  if (candidate?.resolutionClass) {
    const blockers = [];
    const recoveryText = String(candidate.identifiers?.recoveryErrorCode || candidate.identifiers?.recoveryError || '');
    const lookupOnly = candidate.resolutionClass === 'exchange_lookup_retry';
    if (candidate.resolutionClass !== 'manual_ack_required' && !lookupOnly) {
      blockers.push(`resolution_class_not_ackable:${candidate.resolutionClass || 'unknown'}`);
    }
    if (!lookupOnly && !recoveryText.includes('not_found')) blockers.push('recovery_not_not_found');
    if (!candidate.identifiers?.clientOrderId) blockers.push('client_order_id_missing');
    return {
      ok: blockers.length === 0,
      status: blockers.length === 0 ? 'reconcile_ack_eligible' : 'reconcile_ack_blocked',
      blockers,
      classified: candidate,
      lookupOnly,
      ackable: !lookupOnly,
    };
  }
  return evaluateReconcileAckEligibility(candidate);
}

export async function verifyAckCandidateAgainstExchange(candidate = {}, {
  fetchOrder = fetchBinanceOrder,
  liveLookup = true,
} = {}) {
  const eligibility = resolveEligibility(candidate);
  const checkedAt = new Date().toISOString();
  const clientOrderId = eligibility.classified?.identifiers?.clientOrderId || null;
  const orderId = eligibility.classified?.identifiers?.orderId || null;
  const symbol = candidate.symbol || eligibility.classified?.symbol || null;
  const side = String(candidate.action || '').toLowerCase() || null;

  const base = {
    signalId: candidate.id || null,
    symbol,
    action: candidate.action || null,
    clientOrderId,
    orderId,
    eligibility,
    liveLookup,
    checkedAt,
  };

  if (!eligibility.ok) {
    return {
      ...base,
      ok: false,
      status: 'ack_preflight_not_eligible',
      readyToAck: false,
      blockers: eligibility.blockers || ['ack_not_eligible'],
      evidence: buildAckPreflightEvidence({
        candidate,
        eligibility,
        lookup: { status: 'ack_preflight_not_eligible' },
        checkedAt,
      }),
    };
  }

  if (!liveLookup) {
    return {
      ...base,
      ok: true,
      status: 'ack_preflight_lookup_skipped',
      readyToAck: false,
      blockers: ['exchange_lookup_not_run'],
      evidence: buildAckPreflightEvidence({
        candidate,
        eligibility,
        lookup: { status: 'ack_preflight_lookup_skipped' },
        checkedAt,
      }),
    };
  }

  try {
    const order = await fetchOrder({
      symbol,
      orderId,
      clientOrderId,
      side,
      allowAllOrdersFallback: true,
    });
    return {
      ...base,
      ok: false,
      status: 'order_found_block_ack',
      readyToAck: false,
      blockers: ['exchange_order_exists'],
      evidence: buildAckPreflightEvidence({
        candidate,
        eligibility,
        lookup: { status: 'order_found_block_ack', orderFound: true },
        checkedAt,
      }),
      order: {
        id: order?.id || null,
        status: order?.status || null,
        filled: Number(order?.filled || 0) || 0,
        cost: Number(order?.cost || 0) || 0,
      },
    };
  } catch (error) {
    const status = classifyLookupError(error);
    const readyToAck = status === 'order_absent_confirmed' && eligibility.lookupOnly !== true;
    const finalStatus = status === 'order_absent_confirmed' && eligibility.lookupOnly === true
      ? 'exchange_lookup_absent_manual_decision_required'
      : status;
    const evidence = buildAckPreflightEvidence({
      candidate,
      eligibility,
      lookup: {
        status: finalStatus,
        lookupErrorCode: error?.code || null,
        orderFound: false,
      },
      checkedAt,
    });
    return {
      ...base,
      ok: readyToAck || finalStatus === 'exchange_lookup_absent_manual_decision_required',
      status: finalStatus,
      readyToAck,
      blockers: readyToAck ? [] : finalStatus === 'exchange_lookup_absent_manual_decision_required' ? ['operator_decision_required'] : [finalStatus],
      evidence,
      evidenceHash: evidence.evidenceHash,
      evidenceExpiresAt: evidence.expiresAt,
      lookupError: error?.message || String(error),
      lookupErrorCode: error?.code || null,
    };
  }
}

export async function buildLunaReconcileAckPreflight({
  exchange = 'binance',
  hours = 24,
  limit = 100,
  liveLookup = false,
  fetchOrder = fetchBinanceOrder,
  signalId = null,
} = {}) {
  const report = await buildLunaReconcileBlockerReport({ exchange, hours, limit });
  const candidates = (report.blockers || []).filter((row) => {
    if (signalId && String(row.id) !== String(signalId)) return false;
    if (row.resolutionClass === 'manual_ack_required') return true;
    return Boolean(signalId) && row.resolutionClass === 'exchange_lookup_retry';
  });
  const checks = [];
  for (const candidate of candidates) {
    checks.push(await verifyAckCandidateAgainstExchange(candidate, { fetchOrder, liveLookup }));
  }
  const unsafeCount = checks.filter((item) => item.status === 'order_found_block_ack' || item.status === 'lookup_ambiguous_block_ack').length;
  const lookupFailedCount = checks.filter((item) => item.status === 'lookup_failed_block_ack').length;
  const readyToAckCount = checks.filter((item) => item.readyToAck === true).length;
  const lookupOnlyCount = checks.filter((item) => item.eligibility?.lookupOnly === true).length;
  return {
    ok: unsafeCount === 0 && lookupFailedCount === 0,
    checkedAt: new Date().toISOString(),
    status: candidates.length === 0
      ? 'ack_preflight_no_candidates'
      : liveLookup
        ? (unsafeCount || lookupFailedCount ? 'ack_preflight_blocked' : 'ack_preflight_verified')
        : 'ack_preflight_requires_exchange_lookup',
    exchange,
    hours,
    liveLookup,
    summary: {
      candidates: candidates.length,
      readyToAck: readyToAckCount,
      unsafe: unsafeCount,
      lookupFailed: lookupFailedCount,
      lookupOnly: lookupOnlyCount,
    },
    evidence: checks
      .filter((item) => item.readyToAck)
      .map((item) => item.evidence),
    checks,
    nextCommands: checks
      .filter((item) => item.readyToAck)
      .map((item) => (
        `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-reconcile-ack -- --signal-id=${item.signalId} --apply --confirm=ack-luna-reconcile --reason=operator_verified_absent_order --evidence=binance_client_order_lookup_not_found --preflight-evidence-hash=${item.evidenceHash} --preflight-expires-at=${item.evidenceExpiresAt}`
      )),
  };
}

export function renderLunaReconcileAckPreflight(report = {}) {
  return [
    '🔎 Luna reconcile ACK preflight',
    `status: ${report.status || 'unknown'} / exchange=${report.exchange || 'n/a'} / liveLookup=${report.liveLookup === true}`,
    `candidates=${report.summary?.candidates ?? 0} / ready=${report.summary?.readyToAck ?? 0} / unsafe=${report.summary?.unsafe ?? 0} / lookupFailed=${report.summary?.lookupFailed ?? 0}`,
    `next: ${(report.nextCommands || []).length ? report.nextCommands[0] : (report.liveLookup ? 'no ACK command available' : 'rerun with --live-lookup before applying ACK')}`,
  ].join('\n');
}

export async function publishLunaReconcileAckPreflight(report = {}) {
  return publishAlert({
    from_bot: 'luna',
    event_type: 'report',
    alert_level: report.ok ? 1 : 2,
    message: renderLunaReconcileAckPreflight(report),
    payload: {
      checkedAt: report.checkedAt,
      status: report.status,
      summary: report.summary,
      checks: (report.checks || []).slice(0, 10),
    },
  });
}

export async function runLunaReconcileAckPreflightSmoke() {
  const absent = await verifyAckCandidateAgainstExchange({
    id: 'sig-1',
    symbol: 'ORCA/USDT',
    action: 'BUY',
    status: 'failed',
    block_code: 'manual_reconcile_required',
    block_meta: {
      clientOrderId: 'cid-1',
      recoveryErrorCode: 'binance_order_lookup_not_found',
    },
  }, {
    fetchOrder: async () => {
      const error = new Error('binance_order_lookup_not_found:ORCA/USDT:cid-1');
      error.code = 'binance_order_lookup_not_found';
      throw error;
    },
  });
  assert.equal(absent.readyToAck, true);
  assert.match(absent.evidenceHash, /^[a-f0-9]{64}$/);
  assert.ok(new Date(absent.evidenceExpiresAt).getTime() > new Date(absent.checkedAt).getTime());

  const found = await verifyAckCandidateAgainstExchange({
    id: 'sig-2',
    symbol: 'ORCA/USDT',
    action: 'BUY',
    status: 'failed',
    block_code: 'manual_reconcile_required',
    block_meta: {
      clientOrderId: 'cid-2',
      recoveryErrorCode: 'binance_order_lookup_not_found',
    },
  }, {
    fetchOrder: async () => ({ id: 'order-1', status: 'closed', filled: 1, cost: 10 }),
  });
  assert.equal(found.status, 'order_found_block_ack');

  const skipped = await verifyAckCandidateAgainstExchange({
    id: 'sig-3',
    symbol: 'ORCA/USDT',
    action: 'BUY',
    status: 'failed',
    block_code: 'manual_reconcile_required',
    block_meta: {
      clientOrderId: 'cid-3',
      recoveryErrorCode: 'binance_order_lookup_not_found',
    },
  }, { liveLookup: false });
  assert.equal(skipped.status, 'ack_preflight_lookup_skipped');
  const lookupOnlyAbsent = await verifyAckCandidateAgainstExchange({
    id: 'sig-4',
    symbol: 'MEGA/USDT',
    action: 'SELL',
    resolutionClass: 'exchange_lookup_retry',
    identifiers: { clientOrderId: 'cid-mega' },
  }, {
    fetchOrder: async () => {
      const error = new Error('binance_order_lookup_not_found:MEGA/USDT:cid-mega');
      error.code = 'binance_order_lookup_not_found';
      throw error;
    },
  });
  assert.equal(lookupOnlyAbsent.status, 'exchange_lookup_absent_manual_decision_required');
  assert.equal(lookupOnlyAbsent.readyToAck, false);
  assert.equal(lookupOnlyAbsent.eligibility.lookupOnly, true);
  return { ok: true, absent, found, skipped, lookupOnlyAbsent };
}

async function main() {
  const json = hasFlag('--json');
  const smoke = hasFlag('--smoke');
  const telegram = hasFlag('--telegram');
  const liveLookup = hasFlag('--live-lookup');
  const exchange = argValue('--exchange', 'binance');
  const hours = Number(argValue('--hours', 24));
  const limit = Number(argValue('--limit', 100));
  const signalId = argValue('--signal-id', null);
  const report = smoke
    ? await runLunaReconcileAckPreflightSmoke()
    : await buildLunaReconcileAckPreflight({ exchange, hours, limit, liveLookup, signalId });
  if (telegram && !smoke) await publishLunaReconcileAckPreflight(report);
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log(smoke ? 'luna reconcile ack preflight smoke ok' : renderLunaReconcileAckPreflight(report));
  if (!smoke && hasFlag('--fail-on-blocked') && report.ok === false) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna reconcile ACK preflight 실패:',
  });
}
