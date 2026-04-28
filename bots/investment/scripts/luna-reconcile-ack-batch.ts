#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { publishAlert } from '../shared/alert-publisher.ts';
import { buildLunaReconcileAckPreflight } from './luna-reconcile-ack-preflight.ts';
import { runLunaReconcileAck } from './luna-reconcile-ack.ts';

const CONFIRM = 'ack-luna-reconcile-batch';

function hasFlag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function parseCsv(value = '') {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function filterChecks(checks = [], signalIds = []) {
  if (!signalIds.length) return checks;
  const wanted = new Set(signalIds);
  return checks.filter((item) => wanted.has(String(item.signalId || '')));
}

function summarizeChecks(checks = []) {
  return {
    candidates: checks.length,
    readyToAck: checks.filter((item) => item.readyToAck === true).length,
    unsafe: checks.filter((item) => ['order_found_block_ack', 'lookup_ambiguous_block_ack'].includes(item.status)).length,
    lookupFailed: checks.filter((item) => item.status === 'lookup_failed_block_ack').length,
    notEligible: checks.filter((item) => item.status === 'ack_preflight_not_eligible').length,
  };
}

export async function buildLunaReconcileAckBatch({
  exchange = 'binance',
  hours = 24,
  limit = 100,
  signalIds = [],
  apply = false,
  confirm = '',
  ackedBy = null,
  reason = 'operator_verified_absent_order',
  evidence = 'binance_client_order_lookup_not_found',
} = {}) {
  const preflight = await buildLunaReconcileAckPreflight({ exchange, hours, limit, liveLookup: true });
  const checks = filterChecks(preflight.checks || [], signalIds);
  const summary = summarizeChecks(checks);
  const blockers = [];
  if (summary.candidates === 0) blockers.push('ack_candidates_missing');
  if (summary.readyToAck !== summary.candidates) blockers.push(`not_all_candidates_ready:${summary.readyToAck}/${summary.candidates}`);
  if (summary.unsafe > 0) blockers.push(`unsafe_ack_candidates:${summary.unsafe}`);
  if (summary.lookupFailed > 0) blockers.push(`lookup_failed:${summary.lookupFailed}`);
  if (summary.notEligible > 0) blockers.push(`not_eligible:${summary.notEligible}`);
  const ready = blockers.length === 0;
  const base = {
    ok: ready,
    checkedAt: new Date().toISOString(),
    status: ready ? 'ack_batch_ready' : 'ack_batch_blocked',
    exchange,
    hours,
    dryRun: !apply,
    applied: false,
    confirmRequired: CONFIRM,
    blockers,
    summary,
    checks,
    commands: checks.filter((item) => item.readyToAck).map((item) => (
      `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-reconcile-ack -- --signal-id=${item.signalId} --apply --confirm=ack-luna-reconcile --reason=${reason} --evidence=${evidence}`
    )),
  };
  if (!apply) return base;
  if (!ready) return { ...base, ok: false, applyBlockedReason: 'ack_batch_not_ready' };
  if (confirm !== CONFIRM) return { ...base, ok: false, applyBlockedReason: 'confirm_required' };
  const applied = [];
  for (const check of checks) {
    applied.push(await runLunaReconcileAck({
      signalId: check.signalId,
      exchange,
      apply: true,
      confirm: 'ack-luna-reconcile',
      ackedBy,
      reason,
      evidence,
    }));
  }
  const failed = applied.filter((item) => item.ok !== true || item.applied !== true);
  return {
    ...base,
    ok: failed.length === 0,
    status: failed.length === 0 ? 'ack_batch_applied' : 'ack_batch_partial_failure',
    applied: failed.length === 0,
    appliedResults: applied,
    failedCount: failed.length,
  };
}

export function renderLunaReconcileAckBatch(result = {}) {
  return [
    '✅ Luna reconcile ACK batch',
    `status: ${result.status || 'unknown'} / dryRun=${result.dryRun === true}`,
    `candidates=${result.summary?.candidates ?? 0} / ready=${result.summary?.readyToAck ?? 0} / unsafe=${result.summary?.unsafe ?? 0} / failedLookup=${result.summary?.lookupFailed ?? 0}`,
    `blockers: ${(result.blockers || []).length ? result.blockers.join(' / ') : 'none'}`,
    `next: ${(result.commands || []).length ? result.commands[0] : 'none'}`,
  ].join('\n');
}

export async function publishLunaReconcileAckBatch(result = {}) {
  return publishAlert({
    from_bot: 'luna',
    event_type: 'report',
    alert_level: result.ok ? 1 : 2,
    message: renderLunaReconcileAckBatch(result),
    payload: {
      checkedAt: result.checkedAt,
      status: result.status,
      summary: result.summary,
      blockers: result.blockers || [],
      checks: (result.checks || []).slice(0, 10),
    },
  });
}

export function runLunaReconcileAckBatchSmoke() {
  const summary = summarizeChecks([
    { signalId: 'a', readyToAck: true, status: 'order_absent_confirmed' },
    { signalId: 'b', readyToAck: false, status: 'order_found_block_ack' },
  ]);
  assert.equal(summary.candidates, 2);
  assert.equal(summary.readyToAck, 1);
  assert.equal(summary.unsafe, 1);
  const filtered = filterChecks([{ signalId: 'a' }, { signalId: 'b' }], ['b']);
  assert.deepEqual(filtered.map((item) => item.signalId), ['b']);
  return { ok: true, summary, filtered };
}

async function main() {
  const json = hasFlag('--json');
  const smoke = hasFlag('--smoke');
  const telegram = hasFlag('--telegram');
  const apply = hasFlag('--apply');
  const exchange = argValue('--exchange', 'binance');
  const hours = Number(argValue('--hours', 24));
  const limit = Number(argValue('--limit', 100));
  const signalIds = parseCsv(argValue('--signal-ids', ''));
  const confirm = argValue('--confirm', '');
  const ackedBy = argValue('--acked-by', process.env.USER || 'unknown');
  const reason = argValue('--reason', 'operator_verified_absent_order');
  const evidence = argValue('--evidence', 'binance_client_order_lookup_not_found');
  const result = smoke
    ? runLunaReconcileAckBatchSmoke()
    : await buildLunaReconcileAckBatch({ exchange, hours, limit, signalIds, apply, confirm, ackedBy, reason, evidence });
  if (telegram && !smoke) await publishLunaReconcileAckBatch(result);
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(smoke ? 'luna reconcile ack batch smoke ok' : renderLunaReconcileAckBatch(result));
  if (!smoke && apply && result.ok === false) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna reconcile ACK batch 실패:',
  });
}
