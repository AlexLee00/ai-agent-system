#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildRuntimeRiskApprovalReport } from './runtime-risk-approval-report.ts';
import { buildRuntimeRiskApprovalReadiness } from './runtime-risk-approval-readiness.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  return {
    days: Math.max(1, Number(daysArg?.split('=').slice(1).join('=') || 30)),
    json: argv.includes('--json'),
  };
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function findMode(summary = {}, mode) {
  return (summary.application?.byMode || []).find((item) => String(item.mode || '') === mode) || null;
}

export function buildRiskApprovalModeAuditDecision({ riskApproval, readiness }) {
  const summary = riskApproval.summary || {};
  const readinessDecision = readiness.decision || {};
  const currentMode = readinessDecision.currentMode || readiness.modeConfig?.mode || 'shadow';
  const blockerCount = Array.isArray(readinessDecision.blockers) ? readinessDecision.blockers.length : 0;
  const application = summary.application || {};
  const applied = safeNumber(application.applied);
  const rejected = safeNumber(application.rejected);
  const assistMode = findMode(summary, 'assist');
  const enforceMode = findMode(summary, 'enforce');
  const shadowMode = findMode(summary, 'shadow');
  const nonShadowApplications = safeNumber(assistMode?.applied) + safeNumber(enforceMode?.applied) + safeNumber(enforceMode?.rejected);
  const unavailablePreviewCount = safeNumber(summary.amount?.byPreviewStatus?.unavailable);
  const reasons = [
    `current mode ${currentMode}`,
    `readiness ${readinessDecision.status || 'unknown'}`,
    `blockers ${blockerCount}`,
    `application applied ${applied}`,
    `application rejected ${rejected}`,
    `non-shadow applications ${nonShadowApplications}`,
    `preview unavailable ${unavailablePreviewCount}`,
  ];
  const actionItems = [];
  let status = 'risk_approval_mode_audit_ok';
  let headline = '리스크 승인 mode 적용과 readiness 상태가 충돌하지 않습니다.';

  if (currentMode === 'shadow' && nonShadowApplications > 0) {
    status = 'risk_approval_mode_audit_attention';
    headline = '현재 mode는 shadow인데 assist/enforce 적용 기록이 관찰됩니다.';
    actionItems.push('runtime_config overlay, stale process, 네메시스 배포 상태를 확인합니다.');
  } else if (currentMode !== 'shadow' && blockerCount > 0 && nonShadowApplications > 0) {
    status = 'risk_approval_mode_audit_attention';
    headline = 'readiness blocker가 남아 있는데 리스크 승인 mode 적용이 발생했습니다.';
    actionItems.push('mode를 shadow로 되돌릴지 검토하고 blocker 원인을 먼저 해소합니다.');
  } else if (currentMode !== 'shadow' && blockerCount > 0) {
    status = 'risk_approval_mode_audit_mode_watch';
    headline = 'readiness blocker가 남아 있지만 아직 적용 표본은 관찰되지 않았습니다.';
    actionItems.push('신규 BUY 승인 전에 mode 설정과 readiness blocker를 재확인합니다.');
  } else if (currentMode !== 'shadow' && nonShadowApplications === 0) {
    status = 'risk_approval_mode_audit_sampling';
    headline = 'non-shadow mode로 설정되어 있으나 적용 표본은 아직 없습니다.';
    actionItems.push('다음 네메시스 승인 표본에서 application telemetry가 기록되는지 확인합니다.');
  } else if (unavailablePreviewCount > 0) {
    status = 'risk_approval_mode_audit_preview_watch';
    headline = '리스크 승인 preview unavailable 표본이 관찰됩니다.';
    actionItems.push('preview_failed 원인과 모델/DB 입력 누락 여부를 확인합니다.');
  } else {
    actionItems.push('mode/readiness/application telemetry를 계속 관찰합니다.');
  }

  return {
    status,
    headline,
    reasons,
    actionItems,
    metrics: {
      currentMode,
      readinessStatus: readinessDecision.status || 'unknown',
      blockerCount,
      applied,
      rejected,
      nonShadowApplications,
      unavailablePreviewCount,
      byMode: {
        shadow: shadowMode || null,
        assist: assistMode || null,
        enforce: enforceMode || null,
      },
    },
  };
}

function renderText(payload) {
  return [
    '🧭 Risk Approval Mode Audit',
    `days: ${payload.days}`,
    `status: ${payload.decision.status}`,
    `headline: ${payload.decision.headline}`,
    '',
    '근거:',
    ...payload.decision.reasons.map((reason) => `- ${reason}`),
    '',
    '권장 조치:',
    ...payload.decision.actionItems.map((item) => `- ${item}`),
  ].join('\n');
}

export async function buildRuntimeRiskApprovalModeAudit({ days = 30, json = false } = {}) {
  const [riskApproval, readiness] = await Promise.all([
    buildRuntimeRiskApprovalReport({ days, json: true }),
    buildRuntimeRiskApprovalReadiness({ days, json: true }),
  ]);
  const decision = buildRiskApprovalModeAuditDecision({ riskApproval, readiness });
  const payload = {
    ok: true,
    days: Number(days),
    generatedAt: new Date().toISOString(),
    decision,
    riskApproval: {
      status: riskApproval.decision?.status || 'unknown',
      summary: riskApproval.summary || {},
    },
    readiness: {
      status: readiness.decision?.status || 'unknown',
      currentMode: readiness.decision?.currentMode || readiness.modeConfig?.mode || null,
      targetMode: readiness.decision?.targetMode || null,
      blockers: readiness.decision?.blockers || [],
    },
  };
  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeRiskApprovalModeAudit(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-risk-approval-mode-audit 오류:',
  });
}
