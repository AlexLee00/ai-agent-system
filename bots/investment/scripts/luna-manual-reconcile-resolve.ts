#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import * as db from '../shared/db.ts';
import {
  classifyReconcileBlocker,
  parseReconcileBlockMeta,
  isReconcileAcked,
} from './luna-reconcile-blocker-report.ts';
import { buildLunaManualReconcileAssistant } from './luna-manual-reconcile-assistant.ts';

const CONFIRM = 'resolve-luna-manual-reconcile';
const DEFAULT_MAX_DUST_USDT = 10;

function hasFlag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function loadSignalTarget({ signalId = null, exchange = 'binance' } = {}) {
  await db.initSchema().catch(() => {});
  if (!signalId) return null;
  return db.getSignalById(signalId);
}

function isDustOnlyAssistantClearEnough(report = {}, maxDustUsdt = DEFAULT_MAX_DUST_USDT) {
  const blockers = new Set(report.blockers || []);
  const allowedBlockers = new Set(['manual_reconcile_signal_present', 'dust_reconcile_required']);
  const unsupported = [...blockers].filter((item) => !allowedBlockers.has(item));
  const parity = report.parity || {};
  return unsupported.length === 0
    && Number(parity.positionQty || 0) === 0
    && Number(parity.openJournalQty || 0) === 0
    && Number(parity.walletValueUsdt || 0) >= 0
    && Number(parity.walletValueUsdt || 0) < Number(maxDustUsdt || DEFAULT_MAX_DUST_USDT);
}

export function evaluateManualReconcileResolution({
  row = null,
  assistant = null,
  maxDustUsdt = DEFAULT_MAX_DUST_USDT,
} = {}) {
  if (!row?.id) {
    return {
      ok: false,
      status: 'manual_reconcile_target_missing',
      blockers: ['signal_target_missing'],
    };
  }
  const meta = parseReconcileBlockMeta(row.block_meta);
  const classified = classifyReconcileBlocker(row);
  if (isReconcileAcked(meta)) {
    return {
      ok: true,
      status: 'manual_reconcile_already_resolved',
      blockers: [],
      classified,
      existingAck: meta.reconcileAck,
    };
  }

  const blockers = [];
  if (classified.resolutionClass !== 'manual_reconcile_required') {
    blockers.push(`resolution_class_not_manual_reconcile:${classified.resolutionClass || 'unknown'}`);
  }
  if (!assistant) {
    blockers.push('assistant_report_missing');
  } else if (assistant.ok !== true && !isDustOnlyAssistantClearEnough(assistant, maxDustUsdt)) {
    blockers.push(`assistant_not_clear:${(assistant.blockers || []).join(',') || assistant.status || 'unknown'}`);
  }

  return {
    ok: blockers.length === 0,
    status: blockers.length === 0 ? 'manual_reconcile_resolution_eligible' : 'manual_reconcile_resolution_blocked',
    blockers,
    classified,
    assistantStatus: assistant?.status || null,
    assistantParity: assistant?.parity || null,
  };
}

function buildResolutionMeta({ row, eligibility, resolvedBy, reason, evidence } = {}) {
  return {
    reconcileAck: {
      status: 'acknowledged',
      ackedAt: new Date().toISOString(),
      ackedBy: resolvedBy || process.env.USER || 'unknown',
      reason,
      evidence,
      previousBlockCode: row.block_code || null,
      previousStatus: row.status || null,
      resolutionClass: eligibility.classified?.resolutionClass || null,
      resolutionType: 'manual_reconcile_resolved',
      assistantStatus: eligibility.assistantStatus || null,
      assistantParity: eligibility.assistantParity || null,
    },
    manualReconcileResolution: {
      status: 'resolved',
      resolvedAt: new Date().toISOString(),
      resolvedBy: resolvedBy || process.env.USER || 'unknown',
      reason,
      evidence,
      assistantStatus: eligibility.assistantStatus || null,
      assistantParity: eligibility.assistantParity || null,
    },
  };
}

export async function runLunaManualReconcileResolve({
  signalId = null,
  exchange = 'binance',
  apply = false,
  confirm = '',
  resolvedBy = null,
  reason = null,
  evidence = null,
  maxDustUsdt = DEFAULT_MAX_DUST_USDT,
} = {}) {
  const row = await loadSignalTarget({ signalId, exchange });
  const assistant = row?.symbol
    ? await buildLunaManualReconcileAssistant({ symbol: row.symbol, exchange, hours: 72, limit: 20 }).catch((error) => ({
      ok: false,
      status: 'manual_reconcile_assistant_failed',
      blockers: [`assistant_failed:${error?.message || String(error)}`],
    }))
    : null;
  const eligibility = evaluateManualReconcileResolution({ row, assistant, maxDustUsdt });
  const result = {
    ok: eligibility.ok,
    checkedAt: new Date().toISOString(),
    status: eligibility.status,
    dryRun: !apply,
    applied: false,
    confirmRequired: CONFIRM,
    target: row ? {
      id: row.id,
      symbol: row.symbol,
      action: row.action,
      status: row.status,
      blockCode: row.block_code,
      createdAt: row.created_at,
    } : null,
    eligibility,
    assistant,
  };
  if (!apply) return result;
  if (!eligibility.ok) return { ...result, ok: false, applyBlockedReason: 'manual_reconcile_not_eligible' };
  if (eligibility.status === 'manual_reconcile_already_resolved') {
    return { ...result, applied: false, applyBlockedReason: 'already_resolved' };
  }
  if (confirm !== CONFIRM) return { ...result, ok: false, applyBlockedReason: 'confirm_required' };
  if (!reason || !evidence) return { ...result, ok: false, applyBlockedReason: 'reason_and_evidence_required' };

  const resolutionMeta = buildResolutionMeta({ row, eligibility, resolvedBy, reason, evidence });
  await db.mergeSignalBlockMeta(row.id, resolutionMeta);
  return {
    ...result,
    ok: true,
    status: 'manual_reconcile_resolution_applied',
    applied: true,
    resolutionMeta,
  };
}

export function renderLunaManualReconcileResolve(result = {}) {
  return [
    '✅ Luna manual reconcile resolve',
    `status: ${result.status || 'unknown'} / dryRun=${result.dryRun === true}`,
    `target: ${result.target?.symbol || 'n/a'} ${result.target?.action || 'n/a'} ${result.target?.id || 'n/a'}`,
    `blockers: ${(result.eligibility?.blockers || []).join(' / ') || 'none'}`,
    `assistant: ${result.assistant?.status || 'n/a'} / ${result.assistant?.parity?.class || 'n/a'}`,
    `applied: ${result.applied === true}`,
  ].join('\n');
}

export async function runLunaManualReconcileResolveSmoke() {
  const eligible = evaluateManualReconcileResolution({
    row: {
      id: 'sig-1',
      symbol: 'APE/USDT',
      action: 'BUY',
      status: 'executed',
      block_code: 'manual_reconcile_required',
      block_meta: {},
    },
    assistant: {
      ok: false,
      status: 'manual_reconcile_assistant_required',
      blockers: ['manual_reconcile_signal_present', 'dust_reconcile_required'],
      parity: { positionQty: 0, openJournalQty: 0, walletValueUsdt: 0.0005 },
    },
  });
  assert.equal(eligible.ok, true);

  const blocked = evaluateManualReconcileResolution({
    row: {
      id: 'sig-2',
      symbol: 'APE/USDT',
      action: 'BUY',
      status: 'executed',
      block_code: 'manual_reconcile_required',
      block_meta: {},
    },
    assistant: {
      ok: false,
      status: 'manual_reconcile_assistant_required',
      blockers: ['manual_reconcile_signal_present', 'position_mismatch'],
      parity: { positionQty: 10, openJournalQty: 0, walletValueUsdt: 25 },
    },
  });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.blockers.some((item) => item.startsWith('assistant_not_clear')));
  return { ok: true, eligible, blocked };
}

async function main() {
  const json = hasFlag('--json');
  const smoke = hasFlag('--smoke');
  const apply = hasFlag('--apply');
  const signalId = argValue('--signal-id', null);
  const exchange = argValue('--exchange', 'binance');
  const confirm = argValue('--confirm', '');
  const resolvedBy = argValue('--resolved-by', process.env.USER || 'unknown');
  const reason = argValue('--reason', null);
  const evidence = argValue('--evidence', null);
  const maxDustUsdt = Number(argValue('--max-dust-usdt', DEFAULT_MAX_DUST_USDT));
  const result = smoke
    ? await runLunaManualReconcileResolveSmoke()
    : await runLunaManualReconcileResolve({
      signalId,
      exchange,
      apply,
      confirm,
      resolvedBy,
      reason,
      evidence,
      maxDustUsdt,
    });
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(smoke ? 'luna manual reconcile resolve smoke ok' : renderLunaManualReconcileResolve(result));
  if (!smoke && apply && result.ok === false) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna manual reconcile resolve 실패:',
  });
}
