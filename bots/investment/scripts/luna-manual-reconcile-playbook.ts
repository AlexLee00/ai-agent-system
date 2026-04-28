#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { publishAlert } from '../shared/alert-publisher.ts';
import { buildLunaReconcileResolutionPlan } from './luna-reconcile-resolution-plan.ts';

function hasFlag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function buildSteps(item = {}) {
  if (item.resolutionClass === 'manual_ack_required') {
    return [
      `Binance clientOrderId 조회: ${item.identifiers?.clientOrderId || 'missing'}`,
      '거래소 주문이 없음을 재확인한 뒤 ACK preflight를 --live-lookup으로 통과시킨다.',
      'ACK 적용은 reason/evidence/confirm을 포함해 luna-reconcile-ack로만 수행한다.',
    ];
  }
  return [
    '실제 지갑/거래소 잔고와 investment.positions 수량을 비교한다.',
    `보조 리포트: npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-manual-reconcile-assistant -- --symbol=${item.symbol || 'SYMBOL'} --json`,
    'trades/journal에 누락 체결 또는 잘못 기록된 수량/금액이 있는지 확인한다.',
    '정산 증빙을 남긴 뒤 별도 수동 보정 스크립트 또는 DB migration으로 처리한다.',
  ];
}

export function buildManualReconcilePlaybookFromPlan(plan = {}) {
  const manualItems = (plan.liveFireBlockingItems || []).filter((item) => item.automated !== true);
  const tasks = manualItems.map((item) => ({
    signalId: item.id || null,
    symbol: item.symbol || null,
    signalAction: item.signalAction || null,
    blockCode: item.blockCode || null,
    resolutionClass: item.resolutionClass || null,
    recommendedAction: item.recommendedAction || null,
    blocksLiveFire: item.blocksLiveFire === true,
    identifiers: item.identifiers || {},
    steps: buildSteps(item),
  }));
  return {
    ok: tasks.length === 0,
    checkedAt: new Date().toISOString(),
    status: tasks.length === 0 ? 'manual_reconcile_clear' : 'manual_reconcile_playbook_required',
    sourceStatus: plan.status,
    summary: {
      tasks: tasks.length,
      manualAckRequired: tasks.filter((item) => item.resolutionClass === 'manual_ack_required').length,
      manualReconcileRequired: tasks.filter((item) => item.resolutionClass === 'manual_reconcile_required').length,
    },
    tasks,
    nextAction: tasks.length === 0
      ? 'continue_cutover_preflight'
      : 'complete_manual_reconcile_or_ack_before_live_fire',
  };
}

export async function buildLunaManualReconcilePlaybook({
  exchange = 'binance',
  hours = 24,
  limit = 100,
} = {}) {
  const plan = await buildLunaReconcileResolutionPlan({ exchange, hours, limit });
  return {
    ...buildManualReconcilePlaybookFromPlan(plan),
    exchange,
    hours,
  };
}

export function renderLunaManualReconcilePlaybook(playbook = {}) {
  const top = (playbook.tasks || []).slice(0, 5).map((item) => (
    `${item.symbol} ${item.signalAction || 'n/a'} -> ${item.resolutionClass} (${item.signalId || 'n/a'})`
  ));
  return [
    '📋 Luna manual reconcile playbook',
    `status: ${playbook.status || 'unknown'} / next=${playbook.nextAction || 'unknown'}`,
    `tasks=${playbook.summary?.tasks ?? 0} / ack=${playbook.summary?.manualAckRequired ?? 0} / reconcile=${playbook.summary?.manualReconcileRequired ?? 0}`,
    ...(top.length ? ['top:', ...top] : ['top: none']),
  ].join('\n');
}

export async function publishLunaManualReconcilePlaybook(playbook = {}) {
  return publishAlert({
    from_bot: 'luna',
    event_type: 'report',
    alert_level: playbook.ok ? 1 : 2,
    message: renderLunaManualReconcilePlaybook(playbook),
    payload: {
      checkedAt: playbook.checkedAt,
      status: playbook.status,
      summary: playbook.summary,
      tasks: (playbook.tasks || []).slice(0, 10),
    },
  });
}

export async function runLunaManualReconcilePlaybookSmoke() {
  const clear = buildManualReconcilePlaybookFromPlan({ liveFireBlockingItems: [] });
  assert.equal(clear.ok, true);
  const blocked = buildManualReconcilePlaybookFromPlan({
    status: 'reconcile_resolution_required',
    liveFireBlockingItems: [
      {
        id: 'sig-1',
        symbol: 'LUNC/USDT',
        signalAction: 'BUY',
        resolutionClass: 'manual_reconcile_required',
        blocksLiveFire: true,
        automated: false,
        identifiers: {},
      },
      {
        id: 'sig-2',
        symbol: 'ORCA/USDT',
        signalAction: 'BUY',
        resolutionClass: 'manual_ack_required',
        blocksLiveFire: true,
        automated: false,
        identifiers: { clientOrderId: 'cid-2' },
      },
    ],
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.summary.manualReconcileRequired, 1);
  assert.equal(blocked.summary.manualAckRequired, 1);
  return { ok: true, clear, blocked };
}

async function main() {
  const json = hasFlag('--json');
  const smoke = hasFlag('--smoke');
  const telegram = hasFlag('--telegram');
  const exchange = argValue('--exchange', 'binance');
  const hours = Number(argValue('--hours', 24));
  const limit = Number(argValue('--limit', 100));
  const playbook = smoke ? await runLunaManualReconcilePlaybookSmoke() : await buildLunaManualReconcilePlaybook({ exchange, hours, limit });
  if (telegram && !smoke) await publishLunaManualReconcilePlaybook(playbook);
  if (json) console.log(JSON.stringify(playbook, null, 2));
  else console.log(smoke ? 'luna manual reconcile playbook smoke ok' : renderLunaManualReconcilePlaybook(playbook));
  if (!smoke && hasFlag('--fail-on-blocked') && playbook.ok === false) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna manual reconcile playbook 실패:',
  });
}
