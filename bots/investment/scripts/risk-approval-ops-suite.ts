#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runRiskApprovalChainSmoke } from './risk-approval-chain-smoke.ts';
import { runRiskApprovalReportSmoke } from './risk-approval-report-smoke.ts';
import { runRiskApprovalHistorySmoke } from './risk-approval-history-smoke.ts';
import { runRiskApprovalExecutionGuardSmoke } from './risk-approval-execution-guard-smoke.ts';
import { runRiskApprovalExecutionGuardReportSmoke } from './risk-approval-execution-guard-report-smoke.ts';
import { runRiskApprovalModeSmoke } from './risk-approval-mode-smoke.ts';
import { runRiskApprovalReadinessSmoke } from './risk-approval-readiness-smoke.ts';
import { runRiskApprovalModeAuditSmoke } from './risk-approval-mode-audit-smoke.ts';
import { runRiskApprovalLearningLoopSmoke } from './risk-approval-learning-loop-smoke.ts';
import { buildRuntimeRiskApprovalReport } from './runtime-risk-approval-report.ts';
import { buildRuntimeRiskApprovalHistory } from './runtime-risk-approval-history.ts';
import { buildRuntimeRiskApprovalReadiness } from './runtime-risk-approval-readiness.ts';
import { buildRuntimeRiskApprovalReadinessHistory } from './runtime-risk-approval-readiness-history.ts';
import { buildRuntimeRiskApprovalModeAudit } from './runtime-risk-approval-mode-audit.ts';
import { buildRuntimeRiskApprovalModeAuditHistory } from './runtime-risk-approval-mode-audit-history.ts';
import { buildRuntimeExecutionRiskGuardReport } from './runtime-execution-risk-guard-report.ts';
import { buildRuntimeExecutionRiskGuardHistory } from './runtime-execution-risk-guard-history.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  return {
    days: Math.max(1, Number(daysArg?.split('=').slice(1).join('=') || 30)),
    json: argv.includes('--json'),
    smokeOnly: argv.includes('--smoke-only'),
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function statusOf(payload = {}) {
  return payload.decision?.status || payload.current?.status || 'unknown';
}

async function runReports(days) {
  const [
    riskApproval,
    riskApprovalHistory,
    readiness,
    readinessHistory,
    modeAudit,
    modeAuditHistory,
    executionGuard,
    executionGuardHistory,
  ] = await Promise.all([
    buildRuntimeRiskApprovalReport({ days, json: true }),
    buildRuntimeRiskApprovalHistory({ days, json: true, write: false }),
    buildRuntimeRiskApprovalReadiness({ days, json: true }),
    buildRuntimeRiskApprovalReadinessHistory({ days, json: true, write: false }),
    buildRuntimeRiskApprovalModeAudit({ days, json: true }),
    buildRuntimeRiskApprovalModeAuditHistory({ days, json: true, write: false }),
    buildRuntimeExecutionRiskGuardReport({ days, json: true }),
    buildRuntimeExecutionRiskGuardHistory({ days, json: true, write: false }),
  ]);

  assert(riskApproval.ok === true, 'runtime risk approval report failed');
  assert(readiness.ok === true, 'runtime risk approval readiness failed');
  assert(modeAudit.ok === true, 'runtime risk approval mode audit failed');
  assert(executionGuard.ok === true, 'runtime execution risk guard failed');
  assert(riskApprovalHistory.write === false, 'risk approval history should run no-write in ops suite');
  assert(readinessHistory.write === false, 'readiness history should run no-write in ops suite');
  assert(modeAuditHistory.write === false, 'mode audit history should run no-write in ops suite');
  assert(executionGuardHistory.write === false, 'execution guard history should run no-write in ops suite');

  return {
    riskApproval: statusOf(riskApproval),
    riskApprovalHistory: statusOf(riskApprovalHistory),
    readiness: statusOf(readiness),
    readinessHistory: statusOf(readinessHistory),
    modeAudit: statusOf(modeAudit),
    modeAuditHistory: statusOf(modeAuditHistory),
    executionGuard: statusOf(executionGuard),
    executionGuardHistory: statusOf(executionGuardHistory),
    metrics: {
      previewTotal: Number(riskApproval.summary?.total || 0),
      outcomeClosed: Number(riskApproval.summary?.outcome?.total?.closed || 0),
      outcomePnlNet: Number(riskApproval.summary?.outcome?.total?.pnlNet || 0),
      outcomeAvgPnlPercent: riskApproval.summary?.outcome?.total?.avgPnlPercent ?? null,
      outcomeWorstSample: riskApproval.summary?.outcome?.samples?.worst?.[0] || null,
      readinessBlockers: Number(readiness.decision?.blockers?.length || 0),
      nonShadowApplications: Number(modeAudit.decision?.metrics?.nonShadowApplications || 0),
      executionGuardTotal: Number(executionGuard.summary?.total || 0),
    },
  };
}

export async function runRiskApprovalOpsSuite({ days = 30, smokeOnly = false } = {}) {
  const smokes = {
    chain: runRiskApprovalChainSmoke(),
    report: runRiskApprovalReportSmoke(),
    history: runRiskApprovalHistorySmoke(),
    executionGuard: runRiskApprovalExecutionGuardSmoke(),
    executionGuardReport: runRiskApprovalExecutionGuardReportSmoke(),
    mode: runRiskApprovalModeSmoke(),
    readiness: runRiskApprovalReadinessSmoke(),
    modeAudit: runRiskApprovalModeAuditSmoke(),
    learningLoop: runRiskApprovalLearningLoopSmoke(),
  };
  const reports = smokeOnly ? null : await runReports(days);
  return {
    ok: true,
    days: Number(days),
    smokeOnly: Boolean(smokeOnly),
    smokes: {
      chain: Boolean(smokes.chain.ok),
      report: Boolean(smokes.report.ok),
      history: Boolean(smokes.history.ok),
      executionGuard: Boolean(smokes.executionGuard.ok),
      executionGuardReport: Boolean(smokes.executionGuardReport.ok),
      mode: Boolean(smokes.mode.ok),
      readiness: Boolean(smokes.readiness.ok),
      modeAudit: Boolean(smokes.modeAudit.ok),
      learningLoop: Boolean(smokes.learningLoop.ok),
    },
    reports,
  };
}

function renderText(payload) {
  const lines = [
    '🧪 Risk Approval Ops Suite',
    `smokeOnly: ${payload.smokeOnly}`,
    `days: ${payload.days}`,
    `smokes: chain=${payload.smokes.chain} report=${payload.smokes.report} history=${payload.smokes.history} executionGuard=${payload.smokes.executionGuard} executionGuardReport=${payload.smokes.executionGuardReport} mode=${payload.smokes.mode}`,
    `decision smokes: readiness=${payload.smokes.readiness} modeAudit=${payload.smokes.modeAudit} learningLoop=${payload.smokes.learningLoop}`,
  ];
  if (payload.reports) {
    lines.push(`reports: risk=${payload.reports.riskApproval} readiness=${payload.reports.readiness} modeAudit=${payload.reports.modeAudit} executionGuard=${payload.reports.executionGuard}`);
    lines.push(`metrics: preview=${payload.reports.metrics.previewTotal} readinessBlockers=${payload.reports.metrics.readinessBlockers} nonShadow=${payload.reports.metrics.nonShadowApplications} executionGuard=${payload.reports.metrics.executionGuardTotal}`);
    lines.push(`outcome: closed=${payload.reports.metrics.outcomeClosed} pnl=${payload.reports.metrics.outcomePnlNet} avg=${payload.reports.metrics.outcomeAvgPnlPercent ?? 'n/a'}%`);
    if (payload.reports.metrics.outcomeWorstSample) {
      const sample = payload.reports.metrics.outcomeWorstSample;
      lines.push(`worst sample: ${sample.exchange || 'n/a'}/${sample.symbol || 'n/a'} ${sample.mode || 'n/a'} pnl=${sample.pnlNet ?? 'n/a'} (${sample.pnlPercent ?? 'n/a'}%)`);
    }
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs();
  const result = await runRiskApprovalOpsSuite(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderText(result));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ risk approval ops suite 실패:',
  });
}
