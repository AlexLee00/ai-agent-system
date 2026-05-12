import path from 'node:path';
import {
  buildLunaHybridPromotionGateReport,
  PHASE10_RUNTIME_COMMAND,
} from './luna-hybrid-promotion-gate.ts';

export const LUNA_HYBRID_PHASE11 = 'phase11_hybrid_promotion_review';
export const PHASE11_RUNTIME_COMMAND = 'runtime:luna-hybrid-promotion-review';
export const PHASE11_A2A_SKILL = 'hybrid-promotion-review';

function defaultInvestmentRoot() {
  return path.resolve(import.meta.dirname, '..');
}

function reviewCommand(script, args = '-- --json', investmentRoot = defaultInvestmentRoot()) {
  return `npm --prefix ${investmentRoot} run -s ${script} ${args}`;
}

function phaseEvidenceSummary(gateReport = {}) {
  const checks = gateReport.evidenceChecks || [];
  return checks
    .filter((item) => Number(item.phase || 0) >= 1 && Number(item.phase || 0) <= 8)
    .map((item) => ({
      phase: item.phase,
      name: item.name,
      status: item.status,
      count: item.count,
      latestAt: item.latestAt,
      ok: item.ok === true,
    }));
}

function buildReviewChecklist(gateReport = {}, options = {}) {
  const dataRequired = options.dataRequired !== false;
  const evidence = phaseEvidenceSummary(gateReport);
  return [
    {
      name: 'phase10_contract_ready',
      ok: gateReport.contractReady === true,
      detail: gateReport.contractReady === true ? 'ready' : 'phase10 contract blockers remain',
    },
    {
      name: 'phase_shadow_data_ready',
      ok: dataRequired ? gateReport.dataReady === true : true,
      detail: dataRequired
        ? (gateReport.dataReady === true ? 'ready' : 'recent Phase 1-8 shadow evidence is missing')
        : 'skipped in contract-only no-db mode',
    },
    {
      name: 'communication_ready',
      ok: gateReport.communication?.ok === true,
      detail: gateReport.communication?.ok === true ? 'ready' : 'A2A/Hook communication gate not ready',
    },
    {
      name: 'security_ready',
      ok: Number(gateReport.summary?.securityFailures || 0) === 0,
      detail: Number(gateReport.summary?.securityFailures || 0) === 0 ? 'ready' : 'security failures remain',
    },
    {
      name: 'manual_master_approval_required',
      ok: gateReport.promotionReady === false,
      detail: 'Phase 11 is review-only; live promotion stays blocked until explicit master-approved runbook',
    },
    {
      name: 'shadow_evidence_count_ready',
      ok: dataRequired ? evidence.every((item) => item.ok) : true,
      detail: dataRequired
        ? `${evidence.filter((item) => item.ok).length}/${evidence.length} Phase 1-8 evidence checks ready`
        : 'skipped in contract-only no-db mode',
    },
  ];
}

function buildRunbook(gateReport = {}, options = {}) {
  const investmentRoot = path.resolve(options.investmentRoot || defaultInvestmentRoot());
  return {
    reviewOnly: true,
    liveMutationAllowed: false,
    protectedPidMutationAllowed: false,
    promotionReady: false,
    requiredApproval: 'explicit_master_live_promotion_approval',
    prePromotionReviewCommands: [
      reviewCommand(PHASE10_RUNTIME_COMMAND, '-- --json --strict', investmentRoot),
      reviewCommand(PHASE11_RUNTIME_COMMAND, '-- --json --strict', investmentRoot),
      reviewCommand('runtime:luna-bottleneck-autonomy', '-- --json --no-fail', investmentRoot),
      reviewCommand('runtime:marketdata-realtime-connectivity', '-- --json --no-fail', investmentRoot),
    ],
    prohibitedWithoutApproval: [
      'live trade',
      'live-fire cutover',
      'manual reconcile apply',
      'rollback execution',
      'secret changes',
      'protected PID restart/kill/unload',
    ],
    rollbackCommand: gateReport.rollbackCommand
      || 'launchctl unsetenv LUNA_INTELLIGENT_DISCOVERY_MODE && launchctl setenv LUNA_LIVE_FIRE_ENABLED false && launchctl setenv LUNA_POSITION_RUNTIME_AUTONOMOUS_DISPATCH_ENABLED false',
    nextAction: gateReport.manualPromotionReviewCandidate
      ? 'master_review_required_before_any_live_promotion'
      : 'continue_shadow_observation_until_phase10_ready',
  };
}

export async function buildLunaHybridPromotionReviewReport(options = {}) {
  const hours = Math.max(1, Number(options.hours || 168));
  const gateReport = await buildLunaHybridPromotionGateReport({
    queryFn: options.queryFn,
    dataRequired: options.dataRequired,
    hours,
    investmentRoot: options.investmentRoot,
    projectRoot: options.projectRoot,
  });
  const dataRequired = options.dataRequired !== false;
  const checklist = buildReviewChecklist(gateReport, { dataRequired });
  const failures = checklist.filter((item) => !item.ok);
  const runbook = buildRunbook(gateReport, { investmentRoot: options.investmentRoot });
  const readyForMasterReview = dataRequired && failures.length === 0 && gateReport.manualPromotionReviewCandidate === true;
  const status = readyForMasterReview
    ? 'luna_hybrid_promotion_review_ready'
    : !dataRequired
      ? 'luna_hybrid_promotion_review_contract_only'
    : gateReport.contractReady === false
      ? 'luna_hybrid_promotion_review_contract_blocked'
      : 'luna_hybrid_promotion_review_shadow_data_pending';

  return {
    ok: failures.length === 0,
    phase: LUNA_HYBRID_PHASE11,
    status,
    shadowMode: true,
    liveMutation: false,
    protectedPidMutation: false,
    promotionReady: false,
    readyForMasterReview,
    dataChecked: gateReport.dataChecked === true,
    dataRequired,
    masterApprovalRequired: true,
    evidenceLookbackHours: hours,
    gate: {
      status: gateReport.status,
      ok: gateReport.ok,
      contractReady: gateReport.contractReady,
      dataChecked: gateReport.dataChecked,
      dataRequired: gateReport.dataRequired,
      dataReady: gateReport.dataReady,
      manualPromotionReviewCandidate: gateReport.manualPromotionReviewCandidate,
      summary: gateReport.summary,
      blockers: gateReport.blockers,
      warnings: gateReport.warnings,
    },
    checklist,
    evidenceSummary: phaseEvidenceSummary(gateReport),
    runbook,
    blockers: failures.map((item) => ({
      type: 'review_check',
      name: item.name,
      detail: item.detail,
    })),
    generatedAt: new Date().toISOString(),
  };
}

export default {
  LUNA_HYBRID_PHASE11,
  PHASE11_RUNTIME_COMMAND,
  PHASE11_A2A_SKILL,
  buildLunaHybridPromotionReviewReport,
};
