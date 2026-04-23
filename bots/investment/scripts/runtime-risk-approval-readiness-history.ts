#!/usr/bin/env node
// @ts-nocheck

import fs from 'fs';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildRuntimeRiskApprovalReadiness } from './runtime-risk-approval-readiness.ts';

const DEFAULT_FILE = '/tmp/investment-runtime-risk-approval-readiness-history.jsonl';

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  const fileArg = argv.find((arg) => arg.startsWith('--file='));
  return {
    days: Math.max(1, Number(daysArg?.split('=').slice(1).join('=') || 30)),
    file: fileArg?.split('=').slice(1).join('=') || DEFAULT_FILE,
    json: argv.includes('--json'),
    write: !argv.includes('--no-write'),
  };
}

function readHistory(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function appendHistory(file, snapshot) {
  fs.appendFileSync(file, `${JSON.stringify(snapshot)}\n`, 'utf8');
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function buildSnapshot(report = {}, days = 30) {
  const decision = report.decision || {};
  const metrics = decision.metrics || {};
  const dryRun = report.modeDryRun || {};
  return {
    recordedAt: new Date().toISOString(),
    days: Number(days),
    status: decision.status || 'unknown',
    headline: decision.headline || '',
    currentMode: decision.currentMode || report.modeConfig?.mode || null,
    targetMode: decision.targetMode || null,
    blockerCount: Array.isArray(decision.blockers) ? decision.blockers.length : 0,
    blockers: decision.blockers || [],
    previewTotal: safeNumber(metrics.total),
    previewRejects: safeNumber(metrics.previewRejects),
    divergence: safeNumber(metrics.divergence),
    executionStale: safeNumber(metrics.executionStale),
    executionBypass: safeNumber(metrics.executionBypass),
    amountReductionCandidates: safeNumber(metrics.amountReductionCandidates),
    assistApplied: safeNumber(dryRun.assist?.applied),
    assistAmountDelta: safeNumber(dryRun.assist?.amountDelta),
    enforceRejected: safeNumber(dryRun.enforce?.rejected),
    enforceAmountDelta: safeNumber(dryRun.enforce?.amountDelta),
    actionItems: decision.actionItems || [],
  };
}

function buildDelta(current, previous) {
  if (!previous) {
    return {
      blockerCount: 0,
      previewTotal: 0,
      previewRejects: 0,
      divergence: 0,
      executionStale: 0,
      executionBypass: 0,
      amountReductionCandidates: 0,
      assistApplied: 0,
      assistAmountDelta: 0,
      enforceRejected: 0,
      enforceAmountDelta: 0,
    };
  }
  return {
    blockerCount: current.blockerCount - safeNumber(previous.blockerCount),
    previewTotal: current.previewTotal - safeNumber(previous.previewTotal),
    previewRejects: current.previewRejects - safeNumber(previous.previewRejects),
    divergence: current.divergence - safeNumber(previous.divergence),
    executionStale: current.executionStale - safeNumber(previous.executionStale),
    executionBypass: current.executionBypass - safeNumber(previous.executionBypass),
    amountReductionCandidates: current.amountReductionCandidates - safeNumber(previous.amountReductionCandidates),
    assistApplied: current.assistApplied - safeNumber(previous.assistApplied),
    assistAmountDelta: current.assistAmountDelta - safeNumber(previous.assistAmountDelta),
    enforceRejected: current.enforceRejected - safeNumber(previous.enforceRejected),
    enforceAmountDelta: current.enforceAmountDelta - safeNumber(previous.enforceAmountDelta),
  };
}

function signed(value) {
  const n = safeNumber(value);
  return `${n >= 0 ? '+' : ''}${n}`;
}

function renderText(payload) {
  return [
    '📚 Risk Approval Readiness History',
    `file: ${payload.file}`,
    `snapshots: ${payload.historyCount}`,
    `current: ${payload.current.status}`,
    `previous: ${payload.previous?.status || 'none'}`,
    `mode: ${payload.current.currentMode || 'n/a'} -> ${payload.current.targetMode || 'n/a'}`,
    `blocker delta: ${signed(payload.delta.blockerCount)}`,
    `preview delta: ${signed(payload.delta.previewTotal)}`,
    `reject delta: ${signed(payload.delta.previewRejects)}`,
    `divergence delta: ${signed(payload.delta.divergence)}`,
    `execution stale/bypass delta: ${signed(payload.delta.executionStale)} / ${signed(payload.delta.executionBypass)}`,
    '',
    `headline: ${payload.current.headline}`,
    '',
    '권장 조치:',
    ...payload.current.actionItems.map((item) => `- ${item}`),
  ].join('\n');
}

export async function buildRuntimeRiskApprovalReadinessHistory({ days = 30, file = DEFAULT_FILE, json = false, write = true } = {}) {
  const report = await buildRuntimeRiskApprovalReadiness({ days, json: true });
  const current = buildSnapshot(report, days);
  const history = readHistory(file);
  const previous = history[history.length - 1] || null;
  if (write) appendHistory(file, current);
  const payload = {
    ok: true,
    file,
    write,
    historyCount: history.length + (write ? 1 : 0),
    current,
    previous,
    delta: buildDelta(current, previous),
  };
  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeRiskApprovalReadinessHistory(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-risk-approval-readiness-history 오류:',
  });
}
