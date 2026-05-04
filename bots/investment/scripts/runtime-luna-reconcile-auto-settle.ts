#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildLunaReconcileBlockerReport } from './luna-reconcile-blocker-report.ts';
import { buildLunaReconcileAckPreflight } from './luna-reconcile-ack-preflight.ts';
import { runLunaReconcileAck } from './luna-reconcile-ack.ts';

const CONFIRM = 'luna-reconcile-auto-settle';

function hasFlag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

export function isAutoSettleCandidate(blocker = {}) {
  return blocker.resolutionClass === 'exchange_lookup_retry'
    && blocker.acked !== true
    && Boolean(blocker.identifiers?.clientOrderId)
    && blocker.identifiers?.orderAttempted === false
    && !blocker.identifiers?.submittedAtMs;
}

export function summarizeAutoSettle({ candidates = [], checks = [], appliedResults = [] } = {}) {
  return {
    candidates: candidates.length,
    ready: checks.filter((item) => item.readyToAck === true).length,
    unsafe: checks.filter((item) => ['order_found_block_ack', 'lookup_ambiguous_block_ack'].includes(item.status)).length,
    lookupFailed: checks.filter((item) => item.status === 'lookup_failed_block_ack').length,
    notReady: checks.filter((item) => item.readyToAck !== true).length,
    applied: appliedResults.filter((item) => item.applied === true).length,
    applyFailed: appliedResults.filter((item) => item.ok !== true || item.applied !== true).length,
  };
}

export async function buildLunaReconcileAutoSettle({
  exchange = 'binance',
  hours = 6,
  limit = 50,
  apply = false,
  confirm = '',
  ackedBy = null,
  reason = 'auto_verified_unsubmitted_order_absent',
  evidence = 'binance_client_order_lookup_not_found',
  reportBuilder = buildLunaReconcileBlockerReport,
  preflightBuilder = buildLunaReconcileAckPreflight,
  ackRunner = runLunaReconcileAck,
} = {}) {
  const report = await reportBuilder({ exchange, hours, limit });
  if (report?.status === 'reconcile_blocker_query_failed') {
    return {
      ok: false,
      checkedAt: new Date().toISOString(),
      status: 'auto_settle_report_failed',
      dryRun: !apply,
      applied: false,
      confirmRequired: CONFIRM,
      exchange,
      hours,
      limit,
      summary: summarizeAutoSettle(),
      candidates: [],
      checks: [],
      blockers: ['reconcile_blocker_query_failed'],
      error: report.error || null,
    };
  }
  const candidates = (report.blockers || []).filter(isAutoSettleCandidate);
  const checks = [];

  for (const candidate of candidates) {
    const preflight = await preflightBuilder({
      exchange,
      hours,
      limit,
      liveLookup: true,
      signalId: candidate.id,
    });
    const check = (preflight.checks || []).find((item) => String(item.signalId) === String(candidate.id));
    checks.push(check || {
      signalId: candidate.id,
      symbol: candidate.symbol,
      action: candidate.action,
      ok: false,
      readyToAck: false,
      status: 'preflight_check_missing',
      blockers: ['preflight_check_missing'],
    });
  }

  const readyChecks = checks.filter((item) => item.readyToAck === true);
  const appliedResults = [];
  const baseSummary = summarizeAutoSettle({ candidates, checks, appliedResults });
  const base = {
    ok: baseSummary.unsafe === 0 && baseSummary.lookupFailed === 0,
    checkedAt: new Date().toISOString(),
    status: candidates.length === 0
      ? 'auto_settle_no_candidates'
      : apply
        ? 'auto_settle_ready_to_apply'
        : 'auto_settle_planned',
    dryRun: !apply,
    applied: false,
    confirmRequired: CONFIRM,
    exchange,
    hours,
    limit,
    summary: baseSummary,
    candidates: candidates.map((item) => ({
      signalId: item.id,
      symbol: item.symbol,
      action: item.action,
      clientOrderId: item.identifiers?.clientOrderId || null,
      createdAt: item.createdAt || null,
    })),
    checks,
    blockers: checks.flatMap((item) => item.readyToAck ? [] : (item.blockers || [item.status || 'not_ready'])),
  };

  if (!apply || candidates.length === 0) return base;
  if (confirm !== CONFIRM) {
    return { ...base, ok: false, status: 'auto_settle_apply_blocked', applyBlockedReason: 'confirm_required' };
  }

  for (const check of readyChecks) {
    appliedResults.push(await ackRunner({
      signalId: check.signalId,
      exchange,
      apply: true,
      confirm: 'ack-luna-reconcile',
      ackedBy,
      reason,
      evidence,
      preflightEvidenceHash: check.evidenceHash,
      preflightExpiresAt: check.evidenceExpiresAt,
    }));
  }

  const summary = summarizeAutoSettle({ candidates, checks, appliedResults });
  const failed = appliedResults.filter((item) => item.ok !== true || item.applied !== true);
  return {
    ...base,
    ok: base.ok && failed.length === 0,
    status: failed.length === 0 ? 'auto_settle_applied' : 'auto_settle_partial_failure',
    applied: failed.length === 0,
    summary,
    appliedResults,
    failedCount: failed.length,
  };
}

export function renderLunaReconcileAutoSettle(result = {}) {
  return [
    'Luna reconcile auto-settle',
    `status: ${result.status || 'unknown'} / dryRun=${result.dryRun === true}`,
    `candidates=${result.summary?.candidates ?? 0} / ready=${result.summary?.ready ?? 0} / applied=${result.summary?.applied ?? 0}`,
    `unsafe=${result.summary?.unsafe ?? 0} / lookupFailed=${result.summary?.lookupFailed ?? 0}`,
  ].join('\n');
}

export async function runLunaReconcileAutoSettleSmoke() {
  const candidates = [
    {
      id: 'sig-safe',
      symbol: 'UTK/USDT',
      action: 'BUY',
      resolutionClass: 'exchange_lookup_retry',
      identifiers: { clientOrderId: 'cid-safe', orderAttempted: false, submittedAtMs: null },
      acked: false,
      createdAt: '2026-05-04T00:00:00Z',
    },
    {
      id: 'sig-submitted',
      symbol: 'UTK/USDT',
      action: 'BUY',
      resolutionClass: 'exchange_lookup_retry',
      identifiers: { clientOrderId: 'cid-submitted', orderAttempted: true, submittedAtMs: 1777817066755 },
      acked: false,
      createdAt: '2026-05-04T00:00:00Z',
    },
  ];
  assert.deepEqual(candidates.filter(isAutoSettleCandidate).map((item) => item.id), ['sig-safe']);

  const dryRun = await buildLunaReconcileAutoSettle({
    reportBuilder: async () => ({ blockers: candidates }),
    preflightBuilder: async ({ signalId }) => ({
      checks: [{
        signalId,
        symbol: 'UTK/USDT',
        action: 'BUY',
        readyToAck: true,
        status: 'order_absent_confirmed',
        evidenceHash: 'a'.repeat(64),
        evidenceExpiresAt: '2026-05-04T00:30:00Z',
      }],
    }),
  });
  assert.equal(dryRun.summary.candidates, 1);
  assert.equal(dryRun.summary.ready, 1);
  assert.equal(dryRun.applied, false);

  const applied = await buildLunaReconcileAutoSettle({
    apply: true,
    confirm: CONFIRM,
    reportBuilder: async () => ({ blockers: candidates }),
    preflightBuilder: async ({ signalId }) => ({
      checks: [{
        signalId,
        readyToAck: true,
        status: 'order_absent_confirmed',
        evidenceHash: 'b'.repeat(64),
        evidenceExpiresAt: '2026-05-04T00:30:00Z',
      }],
    }),
    ackRunner: async ({ signalId }) => ({ ok: true, applied: true, signalId }),
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.summary.applied, 1);

  const failedReport = await buildLunaReconcileAutoSettle({
    reportBuilder: async () => ({ ok: false, status: 'reconcile_blocker_query_failed', error: 'db down' }),
  });
  assert.equal(failedReport.ok, false);
  assert.equal(failedReport.status, 'auto_settle_report_failed');
  return { ok: true, dryRun: dryRun.summary, applied: applied.summary, failedReport: failedReport.status };
}

async function main() {
  const json = hasFlag('--json');
  const smoke = hasFlag('--smoke');
  const result = smoke
    ? await runLunaReconcileAutoSettleSmoke()
    : await buildLunaReconcileAutoSettle({
      exchange: argValue('--exchange', 'binance'),
      hours: Number(argValue('--hours', 6)),
      limit: Number(argValue('--limit', 50)),
      apply: hasFlag('--apply'),
      confirm: argValue('--confirm', ''),
      ackedBy: argValue('--acked-by', process.env.USER || 'unknown'),
      reason: argValue('--reason', 'auto_verified_unsubmitted_order_absent'),
      evidence: argValue('--evidence', 'binance_client_order_lookup_not_found'),
    });
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(smoke ? 'luna reconcile auto-settle smoke ok' : renderLunaReconcileAutoSettle(result));
  if (!smoke && result.ok === false) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: 'Luna reconcile auto-settle failed:',
  });
}
