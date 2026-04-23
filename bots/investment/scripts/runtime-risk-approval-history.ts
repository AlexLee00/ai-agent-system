#!/usr/bin/env node
// @ts-nocheck

import fs from 'fs';
import { buildRuntimeRiskApprovalReport } from './runtime-risk-approval-report.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const DEFAULT_FILE = '/tmp/investment-runtime-risk-approval-history.jsonl';

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  const fileArg = argv.find((arg) => arg.startsWith('--file='));
  return {
    days: Math.max(1, Number(daysArg?.split('=')[1] || 30)),
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

function summarizeTopModel(row = null) {
  if (!row) return null;
  return {
    model: row.model || null,
    total: Number(row.total || 0),
    pass: Number(row.pass || 0),
    adjust: Number(row.adjust || 0),
    reject: Number(row.reject || 0),
    amountDelta: Number(row.amountDelta || 0),
    topReason: row.topReason || null,
  };
}

function buildSnapshot(report, days) {
  const summary = report?.summary || {};
  const amount = summary.amount || {};
  const application = summary.application || {};
  const outcome = summary.outcome?.total || {};
  return {
    recordedAt: new Date().toISOString(),
    days,
    status: report?.decision?.status || 'unknown',
    headline: report?.decision?.headline || '',
    total: Number(summary.total || 0),
    previewRejects: Number(summary.previewRejects || 0),
    legacyApprovedPreviewRejected: Number(summary.legacyApprovedPreviewRejected || 0),
    previewVsApprovedDelta: Number(amount.previewVsApprovedDelta || 0),
    previewFinal: Number(amount.previewFinal || 0),
    approved: Number(amount.approved || 0),
    applicationApplied: Number(application.applied || 0),
    applicationRejected: Number(application.rejected || 0),
    applicationAmountDelta: Number(application.amountDelta || 0),
    applicationByMode: application.byMode || [],
    outcomeClosed: Number(outcome.closed || 0),
    outcomePnlNet: Number(outcome.pnlNet || 0),
    outcomeAvgPnlPercent: outcome.avgPnlPercent != null ? Number(outcome.avgPnlPercent) : null,
    outcomeWinRate: outcome.winRate != null ? Number(outcome.winRate) : null,
    topModel: summarizeTopModel(summary.modelRows?.[0] || null),
  };
}

export function buildRuntimeRiskApprovalHistoryDelta(current, previous) {
  if (!previous) {
    return {
      total: 0,
      previewRejects: 0,
      legacyApprovedPreviewRejected: 0,
      previewVsApprovedDelta: 0,
      approved: 0,
      previewFinal: 0,
      applicationApplied: 0,
      applicationRejected: 0,
      applicationAmountDelta: 0,
      outcomeClosed: 0,
      outcomePnlNet: 0,
      outcomeAvgPnlPercent: 0,
    };
  }
  return {
    total: current.total - Number(previous.total || 0),
    previewRejects: current.previewRejects - Number(previous.previewRejects || 0),
    legacyApprovedPreviewRejected: current.legacyApprovedPreviewRejected - Number(previous.legacyApprovedPreviewRejected || 0),
    previewVsApprovedDelta: current.previewVsApprovedDelta - Number(previous.previewVsApprovedDelta || 0),
    approved: current.approved - Number(previous.approved || 0),
    previewFinal: current.previewFinal - Number(previous.previewFinal || 0),
    applicationApplied: current.applicationApplied - Number(previous.applicationApplied || 0),
    applicationRejected: current.applicationRejected - Number(previous.applicationRejected || 0),
    applicationAmountDelta: current.applicationAmountDelta - Number(previous.applicationAmountDelta || 0),
    outcomeClosed: current.outcomeClosed - Number(previous.outcomeClosed || 0),
    outcomePnlNet: current.outcomePnlNet - Number(previous.outcomePnlNet || 0),
    outcomeAvgPnlPercent: current.outcomeAvgPnlPercent == null || previous.outcomeAvgPnlPercent == null
      ? 0
      : Number((current.outcomeAvgPnlPercent - Number(previous.outcomeAvgPnlPercent || 0)).toFixed(4)),
  };
}

function renderText(payload) {
  return [
    '🛡️ Risk Approval Preview History',
    `file: ${payload.file}`,
    `snapshots: ${payload.historyCount}`,
    `current: ${payload.current.status}`,
    `previous: ${payload.previous?.status || 'none'}`,
    `preview delta: ${payload.delta.total >= 0 ? '+' : ''}${payload.delta.total}`,
    `reject delta: ${payload.delta.previewRejects >= 0 ? '+' : ''}${payload.delta.previewRejects}`,
    `divergence delta: ${payload.delta.legacyApprovedPreviewRejected >= 0 ? '+' : ''}${payload.delta.legacyApprovedPreviewRejected}`,
    `amount delta change: ${payload.delta.previewVsApprovedDelta >= 0 ? '+' : ''}${payload.delta.previewVsApprovedDelta.toFixed(4)}`,
    `application delta: applied ${payload.delta.applicationApplied >= 0 ? '+' : ''}${payload.delta.applicationApplied} / rejected ${payload.delta.applicationRejected >= 0 ? '+' : ''}${payload.delta.applicationRejected} / amount ${payload.delta.applicationAmountDelta >= 0 ? '+' : ''}${payload.delta.applicationAmountDelta.toFixed(4)}`,
    `outcome delta: closed ${payload.delta.outcomeClosed >= 0 ? '+' : ''}${payload.delta.outcomeClosed} / pnl ${payload.delta.outcomePnlNet >= 0 ? '+' : ''}${payload.delta.outcomePnlNet.toFixed(4)} / avg ${payload.delta.outcomeAvgPnlPercent >= 0 ? '+' : ''}${payload.delta.outcomeAvgPnlPercent.toFixed(4)}%`,
    payload.current.topModel
      ? `top model: ${payload.current.topModel.model || 'n/a'} adjust ${payload.current.topModel.adjust} / reject ${payload.current.topModel.reject} / pass ${payload.current.topModel.pass}`
      : 'top model: none',
    '',
    `headline: ${payload.current.headline}`,
  ].join('\n');
}

export async function buildRuntimeRiskApprovalHistory({ days = 30, file = DEFAULT_FILE, json = false, write = true } = {}) {
  const report = await buildRuntimeRiskApprovalReport({ days, json: true });
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
    delta: buildRuntimeRiskApprovalHistoryDelta(current, previous),
  };
  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeRiskApprovalHistory(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-risk-approval-history 오류:',
  });
}
