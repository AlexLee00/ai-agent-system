#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildLunaL5OperatingReport } from './luna-l5-operating-report.ts';
import { buildLunaEntryTriggerOperatingReport } from './luna-entry-trigger-operating-report.ts';
import { buildLunaEntryTriggerWorkerReadiness } from './luna-entry-trigger-worker-readiness.ts';
import { buildLunaLiveFireReadinessGate } from './luna-live-fire-readiness-gate.ts';
import { buildLunaTradeReconciliationGate } from './luna-trade-reconciliation-gate.ts';
import { buildRuntimeTradeDataHygiene } from './runtime-luna-trade-data-hygiene.ts';

function hasFlag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function tradeDataHygieneStatus(tradeDataHygiene = {}) {
  return tradeDataHygiene?.status || tradeDataHygiene?.hygiene?.status || 'unknown';
}

function tradeDataHygieneReady(tradeDataHygiene = {}) {
  return tradeDataHygiene?.ok === true && tradeDataHygieneStatus(tradeDataHygiene) === 'ready';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function verifyBlockers({ operating, entryTrigger, worker, liveFireGate, tradeGate, tradeDataHygiene } = {}) {
  const blockers = [];
  if (operating?.status !== 'luna_l5_operating') blockers.push(`operating_not_ready:${operating?.status || 'unknown'}`);
  if (entryTrigger?.ok !== true) blockers.push(`entry_trigger_not_clean:${entryTrigger?.status || 'unknown'}`);
  if (worker?.ok !== true) blockers.push(`worker_not_ready:${worker?.status || 'unknown'}`);
  if (tradeGate?.ok !== true) blockers.push(`trade_reconciliation_not_clear:${tradeGate?.status || 'unknown'}`);
  if (!tradeDataHygieneReady(tradeDataHygiene)) {
    blockers.push(`trade_data_hygiene_not_ready:${tradeDataHygieneStatus(tradeDataHygiene)}`);
  }
  if (liveFireGate?.status === 'live_fire_blocked') blockers.push('live_fire_gate_blocked');
  return blockers;
}

export function isSettleablePostLiveFireVerification(report = {}) {
  if (report?.ok !== false) return false;
  const blockers = (report.blockers || []).map((item) => String(item || ''));
  if (!blockers.length) return false;
  const telemetryOnly = blockers.every((item) =>
    item === 'live_fire_gate_blocked'
    || item === 'operating_not_ready:luna_l5_attention');
  if (!telemetryOnly) return false;
  return report?.entryTrigger?.ok === true
    && report?.worker?.ok === true
    && report?.tradeGate?.ok === true
    && tradeDataHygieneReady(report?.tradeDataHygiene)
    && (report?.operating?.blockers || []).every((item) => String(item || '') === 'luna_l5_final_gate_attention');
}

async function buildLunaPostLiveFireVerificationSnapshot({ exchange = 'binance', hours = 6 } = {}) {
  const [operating, entryTrigger, worker, liveFireGate, tradeGate, tradeDataHygiene] = await Promise.all([
    buildLunaL5OperatingReport({ hours }),
    buildLunaEntryTriggerOperatingReport({ exchange, hours }),
    buildLunaEntryTriggerWorkerReadiness({ exchange, hours }),
    buildLunaLiveFireReadinessGate({ hours }),
    buildLunaTradeReconciliationGate({ exchange, hours }),
    buildRuntimeTradeDataHygiene(),
  ]);
  const blockers = verifyBlockers({ operating, entryTrigger, worker, liveFireGate, tradeGate, tradeDataHygiene });
  return {
    ok: blockers.length === 0,
    checkedAt: new Date().toISOString(),
    status: blockers.length === 0 ? 'post_live_fire_verified' : 'post_live_fire_attention',
    exchange,
    hours,
    blockers,
    operating: {
      status: operating.status,
      nextAction: operating.nextAction,
      blockers: operating.blockers || [],
      liveFireGate: operating.liveFireGate || null,
      tradeReconciliation: operating.tradeReconciliation || null,
    },
    entryTrigger: {
      status: entryTrigger.status,
      ok: entryTrigger.ok,
      warnings: entryTrigger.warnings || [],
      summary: entryTrigger.summary || {},
    },
    worker: {
      status: worker.status,
      ok: worker.ok,
      warnings: worker.warnings || [],
      heartbeat: worker.heartbeat || {},
    },
    liveFireGate,
    tradeGate,
    tradeDataHygiene: {
      ok: tradeDataHygiene.ok,
      status: tradeDataHygiene.status,
      severity: tradeDataHygiene.severity,
      blockers: tradeDataHygiene.blockers || [],
      openJournal: tradeDataHygiene.hygiene?.openJournal || null,
      coverage: tradeDataHygiene.coverage || {},
      signalFailureRate: tradeDataHygiene.signalFailureRate ?? null,
      nextActions: tradeDataHygiene.nextActions || [],
    },
  };
}

export async function buildLunaPostLiveFireVerification({
  exchange = 'binance',
  hours = 6,
  settleTelemetry = true,
  settleDelayMs = 1500,
  settleAttempts = 2,
} = {}) {
  let report = await buildLunaPostLiveFireVerificationSnapshot({ exchange, hours });
  if (!settleTelemetry || !isSettleablePostLiveFireVerification(report)) return report;

  const first = {
    status: report.status || null,
    blockers: report.blockers || [],
    checkedAt: report.checkedAt || null,
  };
  const attempts = [];
  for (let attempt = 1; attempt <= settleAttempts; attempt += 1) {
    if (settleDelayMs > 0) await sleep(settleDelayMs * attempt);
    const retry = await buildLunaPostLiveFireVerificationSnapshot({ exchange, hours });
    attempts.push({
      attempt,
      status: retry.status || null,
      blockers: retry.blockers || [],
      checkedAt: retry.checkedAt || null,
      recovered: retry.ok === true,
    });
    report = {
      ...retry,
      stabilizationRetry: {
        attempted: true,
        first,
        attempts,
        recovered: retry.ok === true,
      },
    };
    if (retry.ok === true || !isSettleablePostLiveFireVerification(retry)) break;
  }
  return report;
}

export function renderLunaPostLiveFireVerification(report = {}) {
  return [
    '🌙 Luna post-live-fire verification',
    `status: ${report.status || 'unknown'} / exchange=${report.exchange || 'n/a'} / ${report.hours || 6}h`,
    `blockers: ${(report.blockers || []).length ? report.blockers.join(' / ') : 'none'}`,
    `operating=${report.operating?.status || 'unknown'} / entry=${report.entryTrigger?.status || 'unknown'} / worker=${report.worker?.status || 'unknown'}`,
    `trade=${report.tradeGate?.status || 'unknown'} / live-fire=${report.liveFireGate?.status || 'unknown'}`,
    `trade-data-hygiene=${report.tradeDataHygiene?.status || 'unknown'} / severity=${report.tradeDataHygiene?.severity || 'unknown'}`,
  ].join('\n');
}

export async function runLunaPostLiveFireVerificationSmoke() {
  assert.equal(isSettleablePostLiveFireVerification({
    ok: false,
    blockers: ['operating_not_ready:luna_l5_attention', 'live_fire_gate_blocked'],
    operating: { blockers: ['luna_l5_final_gate_attention'] },
    entryTrigger: { ok: true },
    worker: { ok: true },
    tradeGate: { ok: true },
    tradeDataHygiene: { ok: true, status: 'ready' },
  }), true);
  assert.equal(isSettleablePostLiveFireVerification({
    ok: false,
    blockers: ['trade_reconciliation_not_clear:trade_reconciliation_attention'],
    operating: { blockers: ['luna_l5_final_gate_attention'] },
    entryTrigger: { ok: true },
    worker: { ok: true },
    tradeGate: { ok: false },
    tradeDataHygiene: { ok: true, status: 'ready' },
  }), false);
  const blockers = verifyBlockers({
    operating: { status: 'luna_l5_operating' },
    entryTrigger: { ok: true, status: 'entry_trigger_operating' },
    worker: { ok: true, status: 'entry_trigger_worker_ready' },
    tradeGate: { ok: true, status: 'trade_reconciliation_clear' },
    tradeDataHygiene: { ok: true, status: 'ready', hygiene: { status: 'ready' } },
    liveFireGate: { status: 'live_fire_ready' },
  });
  assert.deepEqual(blockers, []);
  const blocked = verifyBlockers({
    operating: { status: 'luna_l5_attention' },
    entryTrigger: { ok: false, status: 'entry_trigger_attention' },
    worker: { ok: false, status: 'entry_trigger_worker_attention' },
    tradeGate: { ok: false, status: 'trade_reconciliation_attention' },
    tradeDataHygiene: { ok: false, status: 'needs_attention' },
    liveFireGate: { status: 'live_fire_blocked' },
  });
  assert.ok(blocked.includes('live_fire_gate_blocked'));
  assert.ok(blocked.includes('trade_data_hygiene_not_ready:needs_attention'));
  return { ok: true, blockers, blocked };
}

async function main() {
  const json = hasFlag('--json');
  const smoke = hasFlag('--smoke');
  const exchange = argValue('--exchange', 'binance');
  const hours = Number(argValue('--hours', 6));
  const report = smoke ? await runLunaPostLiveFireVerificationSmoke() : await buildLunaPostLiveFireVerification({ exchange, hours });
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log(smoke ? 'luna post-live-fire verification smoke ok' : renderLunaPostLiveFireVerification(report));
  if (!smoke && report.ok === false) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna post-live-fire verification 실패:',
  });
}
