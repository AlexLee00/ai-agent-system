#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildLunaL5OperatingReport } from './luna-l5-operating-report.ts';
import { buildLunaEntryTriggerOperatingReport } from './luna-entry-trigger-operating-report.ts';
import { buildLunaEntryTriggerWorkerReadiness } from './luna-entry-trigger-worker-readiness.ts';
import { buildLunaLiveFireReadinessGate } from './luna-live-fire-readiness-gate.ts';
import { buildLunaTradeReconciliationGate } from './luna-trade-reconciliation-gate.ts';

function hasFlag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function verifyBlockers({ operating, entryTrigger, worker, liveFireGate, tradeGate } = {}) {
  const blockers = [];
  if (operating?.status !== 'luna_l5_operating') blockers.push(`operating_not_ready:${operating?.status || 'unknown'}`);
  if (entryTrigger?.ok !== true) blockers.push(`entry_trigger_not_clean:${entryTrigger?.status || 'unknown'}`);
  if (worker?.ok !== true) blockers.push(`worker_not_ready:${worker?.status || 'unknown'}`);
  if (tradeGate?.ok !== true) blockers.push(`trade_reconciliation_not_clear:${tradeGate?.status || 'unknown'}`);
  if (liveFireGate?.status === 'live_fire_blocked') blockers.push('live_fire_gate_blocked');
  return blockers;
}

export async function buildLunaPostLiveFireVerification({ exchange = 'binance', hours = 6 } = {}) {
  const [operating, entryTrigger, worker, liveFireGate, tradeGate] = await Promise.all([
    buildLunaL5OperatingReport({ hours }),
    buildLunaEntryTriggerOperatingReport({ exchange, hours }),
    buildLunaEntryTriggerWorkerReadiness({ exchange, hours }),
    buildLunaLiveFireReadinessGate({ hours }),
    buildLunaTradeReconciliationGate({ exchange, hours }),
  ]);
  const blockers = verifyBlockers({ operating, entryTrigger, worker, liveFireGate, tradeGate });
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
  };
}

export function renderLunaPostLiveFireVerification(report = {}) {
  return [
    '🌙 Luna post-live-fire verification',
    `status: ${report.status || 'unknown'} / exchange=${report.exchange || 'n/a'} / ${report.hours || 6}h`,
    `blockers: ${(report.blockers || []).length ? report.blockers.join(' / ') : 'none'}`,
    `operating=${report.operating?.status || 'unknown'} / entry=${report.entryTrigger?.status || 'unknown'} / worker=${report.worker?.status || 'unknown'}`,
    `trade=${report.tradeGate?.status || 'unknown'} / live-fire=${report.liveFireGate?.status || 'unknown'}`,
  ].join('\n');
}

export async function runLunaPostLiveFireVerificationSmoke() {
  const blockers = verifyBlockers({
    operating: { status: 'luna_l5_operating' },
    entryTrigger: { ok: true, status: 'entry_trigger_operating' },
    worker: { ok: true, status: 'entry_trigger_worker_ready' },
    tradeGate: { ok: true, status: 'trade_reconciliation_clear' },
    liveFireGate: { status: 'live_fire_ready' },
  });
  assert.deepEqual(blockers, []);
  const blocked = verifyBlockers({
    operating: { status: 'luna_l5_attention' },
    entryTrigger: { ok: false, status: 'entry_trigger_attention' },
    worker: { ok: false, status: 'entry_trigger_worker_attention' },
    tradeGate: { ok: false, status: 'trade_reconciliation_attention' },
    liveFireGate: { status: 'live_fire_blocked' },
  });
  assert.ok(blocked.includes('live_fire_gate_blocked'));
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
