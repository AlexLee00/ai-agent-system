#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildTradeDataAnalysisReport } from '../shared/trade-data-analysis-report.ts';
import { close } from '../shared/db/core.ts';

function normalizeSeverity(value = '') {
  return String(value || '').trim().toUpperCase();
}

function findingRef(finding = {}) {
  return `trade_data_hygiene:${finding.id || finding.reason || 'finding'}`;
}

function isBlockingTradeDataHygieneFinding(finding = {}) {
  return normalizeSeverity(finding.severity) === 'P0';
}

export function isTradeDataHygieneStatusClear(status = '') {
  const normalized = String(status || '').trim().toLowerCase();
  return normalized === 'ready' || normalized === 'ready_with_warnings';
}

export function isTradeDataHygieneGateClear(report = {}) {
  const status = report?.status || report?.hygiene?.status || 'unknown';
  return report?.ok === true
    && isTradeDataHygieneStatusClear(status)
    && (report.blockers || []).length === 0;
}

function parseArgs(args = []) {
  const limitArg = args.find((arg) => arg.startsWith('--limit='))?.split('=')[1];
  return {
    json: args.includes('--json'),
    limit: Number.isFinite(Number(limitArg)) ? Number(limitArg) : 5000,
  };
}

export async function buildRuntimeTradeDataHygiene(options = {}) {
  const report = await buildTradeDataAnalysisReport({ limit: options.limit || 5000 });
  const rawStatus = report.hygiene?.status || 'unknown';
  const findings = Array.isArray(report.hygiene?.findings) ? report.hygiene.findings : [];
  const blockingFindings = findings.filter(isBlockingTradeDataHygieneFinding);
  const advisoryFindings = findings.filter((finding) => !isBlockingTradeDataHygieneFinding(finding));
  const gateClear = report.ok === true && blockingFindings.length === 0;
  const status = gateClear
    ? (rawStatus === 'ready' ? 'ready' : 'ready_with_warnings')
    : rawStatus;
  return {
    ok: gateClear,
    status,
    rawStatus,
    severity: report.hygiene?.severity || 'unknown',
    generatedAt: report.generatedAt,
    hygiene: report.hygiene,
    blockers: blockingFindings.length === 0
      ? []
      : blockingFindings.map(findingRef),
    advisoryFindings: advisoryFindings.map((finding) => ({
      id: finding.id || finding.reason || 'finding',
      severity: finding.severity || 'unknown',
      count: finding.count ?? null,
      reason: finding.reason || null,
      command: finding.command || null,
    })),
    coverage: {
      realizedPnl: report.trades?.realizedPnlCoverage || null,
      posttrade: report.posttrade?.qualityCoverage || null,
    },
    signalFailureRate: report.signals?.failureRate ?? null,
    warnings: [
      ...(report.warnings || []),
      ...advisoryFindings.map((finding) => `${findingRef(finding)}:${finding.severity || 'unknown'}`),
    ],
    nextActions: report.hygiene?.nextActions || [],
    analysisNextActions: report.nextActions || [],
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  try {
    const result = await buildRuntimeTradeDataHygiene(options);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`trade-data-hygiene status=${result.status} severity=${result.severity}`);
      console.log(`findings=${result.hygiene?.findings?.length || 0} warnings=${result.warnings.length}`);
    }
    if (result.ok !== true) process.exitCode = 2;
  } finally {
    await Promise.resolve(close()).catch(() => {});
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'runtime-luna-trade-data-hygiene failed:' });
}
