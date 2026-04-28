#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { publishAlert } from '../shared/alert-publisher.ts';
import {
  buildLunaReconcileBlockerReport,
  renderLunaReconcileBlockerReport,
} from './luna-reconcile-blocker-report.ts';

function hasFlag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function actionForBlocker(blocker = {}) {
  switch (blocker.resolutionClass) {
    case 'acknowledged':
      return {
        resolutionAction: 'audit_only_already_acknowledged',
        automated: true,
        blocksLiveFire: false,
      };
    case 'queue_retry_expected':
      return {
        resolutionAction: 'wait_for_pending_reconcile_worker',
        automated: true,
        blocksLiveFire: false,
      };
    case 'exchange_lookup_retry':
      return {
        resolutionAction: 'retry_exchange_lookup_and_requeue_if_transient',
        automated: true,
        blocksLiveFire: true,
      };
    case 'manual_ack_required':
      return {
        resolutionAction: 'manual_verify_order_absent_then_ack_or_reconcile',
        automated: false,
        blocksLiveFire: true,
      };
    case 'pending_without_lookup_key':
    case 'manual_reconcile_required':
      return {
        resolutionAction: 'manual_wallet_journal_position_reconcile',
        automated: false,
        blocksLiveFire: true,
      };
    default:
      return {
        resolutionAction: 'manual_review',
        automated: false,
        blocksLiveFire: true,
      };
  }
}

export function buildResolutionPlanFromReport(report = {}) {
  const items = (report.blockers || []).map((blocker) => ({
    ...blocker,
    signalAction: blocker.action || null,
    ...actionForBlocker(blocker),
  }));
  const liveFireBlockingItems = items.filter((item) => item.blocksLiveFire);
  const automatedItems = items.filter((item) => item.automated);
  const manualItems = items.filter((item) => !item.automated);
  return {
    ok: liveFireBlockingItems.length === 0,
    checkedAt: new Date().toISOString(),
    status: liveFireBlockingItems.length === 0 ? 'reconcile_resolution_clear' : 'reconcile_resolution_required',
    reportStatus: report.status,
    exchange: report.exchange,
    hours: report.hours,
    summary: {
      total: items.length,
      liveFireBlocking: liveFireBlockingItems.length,
      automated: automatedItems.length,
      manual: manualItems.length,
      byResolutionClass: report.summary?.byResolutionClass || {},
    },
    items,
    liveFireBlockingItems,
    automatedItems,
    manualItems,
    nextAction: liveFireBlockingItems.length === 0
      ? 'continue_cutover_preflight'
      : 'resolve_reconcile_blockers_before_live_fire',
  };
}

export async function buildLunaReconcileResolutionPlan({
  exchange = 'binance',
  hours = 24,
  limit = 100,
} = {}) {
  const report = await buildLunaReconcileBlockerReport({ exchange, hours, limit });
  return {
    ...buildResolutionPlanFromReport(report),
    sourceReport: report,
  };
}

export function renderLunaReconcileResolutionPlan(plan = {}) {
  const top = (plan.liveFireBlockingItems || []).slice(0, 5).map((item) => (
    `${item.symbol} ${item.signalAction || 'n/a'} ${item.blockCode} -> ${item.resolutionAction}`
  ));
  return [
    '🛠️ Luna reconcile resolution plan',
    `status: ${plan.status || 'unknown'} / next=${plan.nextAction || 'unknown'}`,
    `items=${plan.summary?.total ?? 0} / blocking=${plan.summary?.liveFireBlocking ?? 0} / automated=${plan.summary?.automated ?? 0} / manual=${plan.summary?.manual ?? 0}`,
    ...(top.length ? ['blocking:', ...top] : ['blocking: none']),
  ].join('\n');
}

export async function publishLunaReconcileResolutionPlan(plan = {}) {
  return publishAlert({
    from_bot: 'luna',
    event_type: 'report',
    alert_level: plan.ok ? 1 : 2,
    message: `${renderLunaReconcileResolutionPlan(plan)}\n\n${renderLunaReconcileBlockerReport(plan.sourceReport || {})}`,
    payload: {
      checkedAt: plan.checkedAt,
      status: plan.status,
      summary: plan.summary,
      liveFireBlockingItems: (plan.liveFireBlockingItems || []).slice(0, 10),
    },
  });
}

export async function runLunaReconcileResolutionPlanSmoke() {
  const plan = buildResolutionPlanFromReport({
    status: 'reconcile_blockers_present',
    exchange: 'binance',
    hours: 24,
    summary: { byResolutionClass: { manual_ack_required: 1, queue_retry_expected: 1 } },
    blockers: [
      { symbol: 'ORCA/USDT', blockCode: 'manual_reconcile_required', resolutionClass: 'manual_ack_required' },
      { symbol: 'BTC/USDT', blockCode: 'order_pending_reconcile', resolutionClass: 'queue_retry_expected' },
    ],
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.summary.liveFireBlocking, 1);
  assert.equal(plan.summary.automated, 1);
  assert.equal(plan.nextAction, 'resolve_reconcile_blockers_before_live_fire');
  return { ok: true, plan };
}

async function main() {
  const json = hasFlag('--json');
  const smoke = hasFlag('--smoke');
  const telegram = hasFlag('--telegram');
  const exchange = argValue('--exchange', 'binance');
  const hours = Number(argValue('--hours', 24));
  const limit = Number(argValue('--limit', 100));
  const plan = smoke ? await runLunaReconcileResolutionPlanSmoke() : await buildLunaReconcileResolutionPlan({ exchange, hours, limit });
  if (telegram && !smoke) await publishLunaReconcileResolutionPlan(plan);
  if (json) console.log(JSON.stringify(plan, null, 2));
  else console.log(smoke ? 'luna reconcile resolution plan smoke ok' : renderLunaReconcileResolutionPlan(plan));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna reconcile resolution plan 실패:',
  });
}
