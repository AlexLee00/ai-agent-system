#!/usr/bin/env node
// @ts-nocheck

import fs from 'fs';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildRuntimeRiskApprovalModeAudit } from './runtime-risk-approval-mode-audit.ts';

const DEFAULT_FILE = '/tmp/investment-runtime-risk-approval-mode-audit-history.jsonl';

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
  return {
    recordedAt: new Date().toISOString(),
    days: Number(days),
    status: decision.status || 'unknown',
    headline: decision.headline || '',
    currentMode: metrics.currentMode || report.readiness?.currentMode || null,
    readinessStatus: metrics.readinessStatus || report.readiness?.status || null,
    blockerCount: safeNumber(metrics.blockerCount),
    applied: safeNumber(metrics.applied),
    rejected: safeNumber(metrics.rejected),
    nonShadowApplications: safeNumber(metrics.nonShadowApplications),
    unavailablePreviewCount: safeNumber(metrics.unavailablePreviewCount),
    actionItems: decision.actionItems || [],
  };
}

function buildDelta(current, previous) {
  if (!previous) {
    return {
      blockerCount: 0,
      applied: 0,
      rejected: 0,
      nonShadowApplications: 0,
      unavailablePreviewCount: 0,
    };
  }
  return {
    blockerCount: current.blockerCount - safeNumber(previous.blockerCount),
    applied: current.applied - safeNumber(previous.applied),
    rejected: current.rejected - safeNumber(previous.rejected),
    nonShadowApplications: current.nonShadowApplications - safeNumber(previous.nonShadowApplications),
    unavailablePreviewCount: current.unavailablePreviewCount - safeNumber(previous.unavailablePreviewCount),
  };
}

function signed(value) {
  const n = safeNumber(value);
  return `${n >= 0 ? '+' : ''}${n}`;
}

function renderText(payload) {
  return [
    '📚 Risk Approval Mode Audit History',
    `file: ${payload.file}`,
    `snapshots: ${payload.historyCount}`,
    `current: ${payload.current.status}`,
    `previous: ${payload.previous?.status || 'none'}`,
    `mode: ${payload.current.currentMode || 'n/a'}`,
    `blocker delta: ${signed(payload.delta.blockerCount)}`,
    `non-shadow delta: ${signed(payload.delta.nonShadowApplications)}`,
    `unavailable delta: ${signed(payload.delta.unavailablePreviewCount)}`,
    '',
    `headline: ${payload.current.headline}`,
    '',
    '권장 조치:',
    ...payload.current.actionItems.map((item) => `- ${item}`),
  ].join('\n');
}

export async function buildRuntimeRiskApprovalModeAuditHistory({ days = 30, file = DEFAULT_FILE, json = false, write = true } = {}) {
  const report = await buildRuntimeRiskApprovalModeAudit({ days, json: true });
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
  const result = await buildRuntimeRiskApprovalModeAuditHistory(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-risk-approval-mode-audit-history 오류:',
  });
}
