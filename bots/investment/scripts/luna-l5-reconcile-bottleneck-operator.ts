#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildLunaReconcileResolutionPlan } from './luna-reconcile-resolution-plan.ts';
import { buildLunaManualReconcilePlaybook } from './luna-manual-reconcile-playbook.ts';
import { buildLunaManualReconcileAssistant } from './luna-manual-reconcile-assistant.ts';

const REPO_ROOT = '/Users/alexlee/projects/ai-agent-system';

function hasFlag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function safeSymbol(symbol = '') {
  return String(symbol || '').trim() || 'UNKNOWN';
}

function assistantCommand(task = {}) {
  return `npm --prefix ${REPO_ROOT}/bots/investment run -s runtime:luna-manual-reconcile-assistant -- --symbol=${safeSymbol(task.symbol)} --exchange=${task.exchange || 'binance'} --json`;
}

function ackPreflightCommand(task = {}) {
  return `npm --prefix ${REPO_ROOT}/bots/investment run -s runtime:luna-reconcile-ack-preflight -- --signal-id=${task.signalId || 'SIGNAL_ID'} --live-lookup --json`;
}

function buildTaskAction(task = {}) {
  if (task.resolutionClass === 'manual_ack_required') {
    return {
      action: 'verify_absent_order_before_ack',
      safeAutomation: false,
      nextCommand: ackPreflightCommand(task),
      caution: 'ACK는 거래소 주문 부재를 live lookup으로 확인한 뒤에만 별도 confirm 명령으로 수행한다.',
    };
  }
  return {
    action: 'manual_wallet_journal_position_reconcile',
    safeAutomation: false,
    nextCommand: assistantCommand(task),
    caution: 'positions/trades/journal/거래소 보유량 증빙을 맞춘 뒤 별도 migration 또는 수동 보정으로 처리한다.',
  };
}

export function buildLunaL5ReconcileBottleneckOperatorFromInputs({
  resolutionPlan = {},
  playbook = {},
  assistantReports = [],
  assistantLimit = 3,
} = {}) {
  const tasks = Array.isArray(playbook.tasks) ? playbook.tasks : [];
  const assistantBySymbol = new Map((assistantReports || []).map((report) => [safeSymbol(report.symbol), report]));
  const taskActions = tasks.map((task) => {
    const action = buildTaskAction(task);
    const assistant = assistantBySymbol.get(safeSymbol(task.symbol)) || null;
    const assistantBlocked = assistant?.ok === false;
    const assistantNextCommand = assistantCommand(task);
    const nextCommand = assistantBlocked ? assistantNextCommand : action.nextCommand;
    const followUpCommand = assistantBlocked && action.nextCommand !== assistantNextCommand
      ? action.nextCommand
      : null;
    return {
      ...task,
      ...action,
      action: assistantBlocked ? 'resolve_assistant_blockers_before_ack_or_reconcile' : action.action,
      nextCommand,
      followUpCommand,
      assistantStatus: assistant?.status || null,
      assistantBlockers: assistant?.blockers || [],
      parity: assistant?.parity || null,
    };
  });
  const unresolvedAssistantReports = (assistantReports || []).filter((report) => report?.ok === false);
  const blockers = [];
  if (resolutionPlan.ok === false) blockers.push(`resolution_plan_blocked:${resolutionPlan.summary?.liveFireBlocking ?? taskActions.length}`);
  if (playbook.ok === false || taskActions.length > 0) blockers.push(`manual_reconcile_tasks:${taskActions.length}`);
  for (const report of unresolvedAssistantReports) {
    blockers.push(`assistant_blocked:${safeSymbol(report.symbol)}:${(report.blockers || []).join(',') || 'unknown'}`);
  }

  const nextCommands = [...new Set(taskActions.slice(0, 5).map((item) => item.nextCommand).filter(Boolean))];
  return {
    ok: blockers.length === 0,
    checkedAt: new Date().toISOString(),
    status: blockers.length === 0
      ? 'luna_l5_reconcile_bottleneck_clear'
      : 'luna_l5_reconcile_bottleneck_required',
    blockers,
    summary: {
      resolutionStatus: resolutionPlan.status || null,
      playbookStatus: playbook.status || null,
      totalTasks: taskActions.length,
      manualAckRequired: taskActions.filter((item) => item.resolutionClass === 'manual_ack_required').length,
      manualReconcileRequired: taskActions.filter((item) => item.resolutionClass === 'manual_reconcile_required').length,
      assistantReports: assistantReports.length,
      assistantBlocked: unresolvedAssistantReports.length,
    },
    taskActions,
    assistantReports: (assistantReports || []).slice(0, Math.max(0, Number(assistantLimit || 3))),
    nextAction: blockers.length === 0
      ? 'continue_luna_l5_cutover_preflight'
      : 'resolve_manual_reconcile_bottleneck_before_phase_cutover',
    nextCommands,
  };
}

export async function buildLunaL5ReconcileBottleneckOperator({
  exchange = 'binance',
  hours = 24,
  limit = 100,
  assistantLimit = 3,
} = {}) {
  const [resolutionPlan, playbook] = await Promise.all([
    buildLunaReconcileResolutionPlan({ exchange, hours, limit }),
    buildLunaManualReconcilePlaybook({ exchange, hours, limit }),
  ]);
  const tasks = (playbook.tasks || []).slice(0, Math.max(0, Number(assistantLimit || 3)));
  const assistantReports = await Promise.all(tasks.map((task) => (
    buildLunaManualReconcileAssistant({
      symbol: task.symbol,
      exchange: task.exchange || exchange,
      hours,
      limit: Math.min(20, Math.max(5, Number(limit || 20))),
    }).catch((error) => ({
      ok: false,
      status: 'manual_reconcile_assistant_failed',
      symbol: task.symbol,
      exchange: task.exchange || exchange,
      blockers: [`assistant_failed:${error?.message || String(error)}`],
    }))
  )));
  return buildLunaL5ReconcileBottleneckOperatorFromInputs({
    resolutionPlan,
    playbook,
    assistantReports,
    assistantLimit,
  });
}

export function renderLunaL5ReconcileBottleneckOperator(result = {}) {
  const top = (result.taskActions || []).slice(0, 5).map((item) => (
    `${item.symbol || 'UNKNOWN'} ${item.resolutionClass || 'unknown'} -> ${item.action || 'review'}`
  ));
  return [
    '🧭 Luna L5 reconcile bottleneck operator',
    `status: ${result.status || 'unknown'} / next=${result.nextAction || 'unknown'}`,
    `tasks=${result.summary?.totalTasks ?? 0} / ack=${result.summary?.manualAckRequired ?? 0} / reconcile=${result.summary?.manualReconcileRequired ?? 0} / assistantBlocked=${result.summary?.assistantBlocked ?? 0}`,
    `blockers: ${(result.blockers || []).join(' / ') || 'none'}`,
    ...(top.length ? ['top:', ...top] : ['top: none']),
  ].join('\n');
}

export async function runLunaL5ReconcileBottleneckOperatorSmoke() {
  const clear = buildLunaL5ReconcileBottleneckOperatorFromInputs({
    resolutionPlan: { ok: true, status: 'reconcile_resolution_clear' },
    playbook: { ok: true, status: 'manual_reconcile_clear', tasks: [] },
    assistantReports: [],
  });
  assert.equal(clear.ok, true);
  const blocked = buildLunaL5ReconcileBottleneckOperatorFromInputs({
    resolutionPlan: { ok: false, status: 'reconcile_resolution_required', summary: { liveFireBlocking: 2 } },
    playbook: {
      ok: false,
      status: 'manual_reconcile_playbook_required',
      tasks: [
        { signalId: 'sig-1', symbol: 'UTK/USDT', exchange: 'binance', resolutionClass: 'manual_reconcile_required' },
        { signalId: 'sig-2', symbol: 'ORCA/USDT', exchange: 'binance', resolutionClass: 'manual_ack_required' },
      ],
    },
    assistantReports: [
      { ok: false, status: 'manual_reconcile_assistant_required', symbol: 'UTK/USDT', blockers: ['manual_reconcile_signal_present'] },
    ],
  });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.blockers.some((item) => item.startsWith('manual_reconcile_tasks:2')));
  assert.ok(blocked.nextCommands.some((item) => item.includes('luna-manual-reconcile-assistant')));
  assert.ok(blocked.nextCommands.some((item) => item.includes('luna-reconcile-ack-preflight')));
  return { ok: true, clear, blocked };
}

async function main() {
  const json = hasFlag('--json');
  const smoke = hasFlag('--smoke');
  const exchange = argValue('--exchange', 'binance');
  const hours = Number(argValue('--hours', 24));
  const limit = Number(argValue('--limit', 100));
  const assistantLimit = Number(argValue('--assistant-limit', 3));
  const result = smoke
    ? await runLunaL5ReconcileBottleneckOperatorSmoke()
    : await buildLunaL5ReconcileBottleneckOperator({ exchange, hours, limit, assistantLimit });
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(smoke ? 'luna l5 reconcile bottleneck operator smoke ok' : renderLunaL5ReconcileBottleneckOperator(result));
  if (!smoke && hasFlag('--fail-on-blocked') && result.ok === false) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna l5 reconcile bottleneck operator 실패:',
  });
}
