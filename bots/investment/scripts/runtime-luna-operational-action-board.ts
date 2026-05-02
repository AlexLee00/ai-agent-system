#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildLunaOperationalBlockerPack } from './runtime-luna-operational-blocker-pack.ts';

function hasFlag(name) {
  return process.argv.includes(name);
}

function summarizeManualTask(task = {}) {
  return {
    id: task.id || null,
    symbol: task.symbol || null,
    action: task.action || null,
    resolutionClass: task.resolutionClass || null,
    safeToAutomate: false,
    requiredEvidence: task.requiredEvidence || [],
    identifiers: task.identifiers || {},
    nextCommand: task.nextCommand || null,
  };
}

function summarizeLookupRetryTask(task = {}) {
  return {
    id: task.id || null,
    symbol: task.symbol || null,
    action: task.action || null,
    resolutionClass: task.resolutionClass || 'exchange_lookup_retry',
    safeToAutomate: false,
    evidenceHash: task.evidenceHash || null,
    nextCommand: task.nextCommand || null,
    manualFallbackCommand: task.manualFallbackCommand || null,
  };
}

function manualTasksFromHardBlockers(pack = {}) {
  const existingSymbols = new Set((pack.manualTasks || []).map((task) => String(task.symbol || '')));
  return (pack.hardBlockers || [])
    .map((item) => String(item || ''))
    .filter((item) => item.startsWith('reconcile:'))
    .map((item) => {
      const [, symbol, reason] = item.split(':');
      return {
        id: null,
        symbol: symbol || null,
        action: null,
        resolutionClass: reason || 'manual_review_required',
        safeToAutomate: false,
        requiredEvidence: [
          'exchange_wallet_snapshot',
          'local_position_row',
          'trade_journal_row',
          'operator_resolution_note',
        ],
        identifiers: {},
        nextCommand: symbol
          ? `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-manual-reconcile-playbook -- --symbol=${symbol} --json`
          : null,
      };
    })
    .filter((task) => !existingSymbols.has(String(task.symbol || '')));
}

export function buildLunaOperationalActionBoardFromPack(pack = {}) {
  const bus = pack.evidence?.busHygiene?.classification || {};
  const lookupRetryTasks = (pack.evidence?.reconcileEvidence?.lookupRetryTasks || []).map(summarizeLookupRetryTask);
  const manualTasks = [
    ...(pack.manualTasks || []).map(summarizeManualTask),
    ...manualTasksFromHardBlockers(pack).filter((task) =>
      !lookupRetryTasks.some((lookup) => lookup.symbol === task.symbol && lookup.resolutionClass === task.resolutionClass)),
  ];
  const busPolicy = {
    status: Number(bus.safeExpire || 0) > 0
      ? 'safe_expire_available_with_confirm'
      : Number(bus.reviewRequired || 0) > 0
        ? 'operator_review_required'
        : Number(bus.blocked || 0) > 0
          ? 'blocked'
          : 'clear',
    safeExpire: Number(bus.safeExpire || 0),
    reviewRequired: Number(bus.reviewRequired || 0),
    blocked: Number(bus.blocked || 0),
    applyAllowedNow: Number(bus.safeExpire || 0) > 0 && Number(bus.reviewRequired || 0) === 0 && Number(bus.blocked || 0) === 0,
    reviewPolicy: 'all broadcast and hermes query messages require operator review before expiry',
  };
  return {
    ok: pack.status === 'operational_clear',
    generatedAt: new Date().toISOString(),
    sourceStatus: pack.status || null,
    hardBlockers: pack.hardBlockers || [],
    manualReconcile: {
      count: manualTasks.length,
      safeToAutomate: false,
      tasks: manualTasks,
    },
    exchangeLookupRetry: {
      count: lookupRetryTasks.length,
      safeToAutomate: false,
      tasks: lookupRetryTasks,
    },
    ackQueue: {
      count: (pack.safeAckCandidates || []).length,
      tasks: pack.safeAckCandidates || [],
    },
    agentBusHygiene: busPolicy,
    curriculum: {
      tasks: pack.curriculumTasks || [],
      status: pack.evidence?.curriculum?.status || null,
      toCreate: Number(pack.evidence?.curriculum?.toCreate || 0),
    },
    pendingObservation: pack.pendingObservation || [],
    sevenDayObservation: {
      status: pack.evidence?.sevenDay?.status || null,
      criteria: pack.evidence?.sevenDay?.criteria || {},
      pendingReasons: pack.evidence?.sevenDay?.pendingReasons || [],
      nextCommand: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-7day-report -- --json --no-write',
    },
    nextActions: pack.nextActions || [],
    commands: {
      blockerPack: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-operational-blocker-pack -- --json',
      evidencePack: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-reconcile-evidence-pack -- --json',
      busHygieneDryRun: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:agent-message-bus-hygiene -- --dry-run --json',
      busHygieneApply: busPolicy.applyAllowedNow
        ? 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:agent-message-bus-hygiene -- --apply --confirm=luna-agent-bus-hygiene --json'
        : null,
    },
  };
}

export async function runLunaOperationalActionBoard(options = {}) {
  const pack = options.pack || await buildLunaOperationalBlockerPack({
    exchange: options.exchange || 'binance',
    hours: Number(options.hours || 24),
    days: Number(options.days || 7),
  });
  return buildLunaOperationalActionBoardFromPack(pack);
}

export async function runLunaOperationalActionBoardSmoke() {
  const board = await runLunaOperationalActionBoard({
    pack: {
      status: 'operational_blocked',
      hardBlockers: ['reconcile:MEGA/USDT:exchange_lookup_retry'],
      manualTasks: [{
        id: 'sig-mega',
        symbol: 'MEGA/USDT',
        action: 'SELL',
        resolutionClass: 'manual_reconcile_required',
        requiredEvidence: ['exchange_wallet_snapshot'],
        identifiers: { clientOrderId: 'cid-mega' },
        nextCommand: 'manual-playbook',
      }],
      safeAckCandidates: [],
      curriculumTasks: [],
      pendingObservation: ['7day:fired 0/5'],
      nextActions: ['complete manual wallet/journal/position reconcile evidence'],
      evidence: {
        busHygiene: {
          classification: {
            safeExpire: 0,
            reviewRequired: 186,
            blocked: 0,
          },
        },
        reconcileEvidence: {
          lookupRetryTasks: [{
            id: 'sig-mega',
            symbol: 'MEGA/USDT',
            action: 'SELL',
            resolutionClass: 'exchange_lookup_retry',
            evidenceHash: 'a'.repeat(64),
            nextCommand: 'ack-preflight',
          }],
        },
        sevenDay: {
          status: 'pending_observation',
          criteria: { fired5: false },
          pendingReasons: ['fired 0/5'],
        },
        curriculum: { status: 'curriculum_bootstrap_already_seeded', toCreate: 0 },
      },
    },
  });
  assert.equal(board.ok, false);
  assert.equal(board.manualReconcile.count, 1);
  assert.equal(board.exchangeLookupRetry.count, 1);
  assert.equal(board.manualReconcile.safeToAutomate, false);
  assert.equal(board.agentBusHygiene.status, 'operator_review_required');
  assert.equal(board.agentBusHygiene.applyAllowedNow, false);
  assert.equal(board.sevenDayObservation.status, 'pending_observation');
  assert.equal(board.commands.busHygieneApply, null);
  return { ok: true, board };
}

async function main() {
  const json = hasFlag('--json');
  const smoke = hasFlag('--smoke');
  const result = smoke
    ? await runLunaOperationalActionBoardSmoke()
    : await runLunaOperationalActionBoard();
  if (json) console.log(JSON.stringify(result, null, 2));
  else if (smoke) console.log('luna operational action board smoke ok');
  else {
    console.log(`${result.sourceStatus} manual=${result.manualReconcile.count} bus=${result.agentBusHygiene.status}`);
    console.log(`next=${result.nextActions[0] || 'none'}`);
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna operational action board 실패:',
  });
}
