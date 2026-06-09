import path from 'node:path';
import {
  buildLunaHybridPromotionGateReport,
  PHASE10_RUNTIME_COMMAND,
} from './luna-hybrid-promotion-gate.ts';

export const LUNA_HYBRID_PHASE11 = 'phase11_hybrid_promotion_review';
export const PHASE11_RUNTIME_COMMAND = 'runtime:luna-hybrid-promotion-review';
export const PHASE11_A2A_SKILL = 'hybrid-promotion-review';

type QueryFn = (sql: string, params?: unknown[]) => Promise<unknown> | unknown;
type GateReport = Awaited<ReturnType<typeof buildLunaHybridPromotionGateReport>>;

type EvidenceCheck = {
  phase?: number;
  name?: string;
  status?: string;
  count?: number | null;
  latestAt?: unknown;
  ok?: boolean;
};

type BridgeRow = {
  bridge_status?: string;
  count?: number;
  latest_at?: unknown;
  items?: unknown;
};

type BridgeStatus = {
  ok: boolean;
  status: string;
  checked: boolean;
  pendingApproval: number;
  latestAt: unknown;
  rows: BridgeRow[];
  warning?: string;
};

type ChecklistItem = {
  name: string;
  ok: boolean;
  detail: string;
};

type ReviewChecklistOptions = {
  dataRequired?: boolean;
  promotionEntryTriggerBridge?: BridgeStatus;
};

type RunbookOptions = {
  investmentRoot?: string;
};

type ReviewReportOptions = RunbookOptions & {
  projectRoot?: string;
  hours?: number;
  dataRequired?: boolean;
  queryFn?: QueryFn;
};

function defaultInvestmentRoot() {
  return path.resolve(import.meta.dirname, '..');
}

function reviewCommand(script: string, args = '-- --json', investmentRoot = defaultInvestmentRoot()) {
  return `npm --prefix ${investmentRoot} run -s ${script} ${args}`;
}

function phaseEvidenceSummary(gateReport: GateReport) {
  const checks = gateReport.evidenceChecks || [];
  return checks
    .filter((item: EvidenceCheck) => Number(item.phase || 0) >= 1 && Number(item.phase || 0) <= 8)
    .map((item: EvidenceCheck) => ({
      phase: item.phase,
      name: item.name,
      status: item.status,
      count: item.count,
      latestAt: item.latestAt,
      ok: item.ok === true,
    }));
}

function bridgeReviewDetail(bridge: BridgeStatus, dataRequired = true) {
  if (!dataRequired) return 'skipped in contract-only no-db mode';
  if (bridge.ok === false) {
    return `promotion entry-trigger bridge check failed: ${bridge.warning || bridge.status || 'unknown_error'}`;
  }
  if (bridge.checked === false) {
    return 'promotion entry-trigger bridge status was not checked; run with DB access before master review';
  }
  const pending = Number(bridge.pendingApproval || 0);
  return pending > 0
    ? `${pending} promotion-ready symbol(s) require explicit master-approved entry-trigger materialization`
    : 'no pending promotion-to-entry-trigger bridge items';
}

function buildReviewChecklist(gateReport: GateReport, options: ReviewChecklistOptions = {}): ChecklistItem[] {
  const dataRequired = options.dataRequired !== false;
  const bridge = options.promotionEntryTriggerBridge || {
    ok: false,
    status: 'promotion_entry_trigger_bridge_not_checked',
    checked: false,
    pendingApproval: 0,
    latestAt: null,
    rows: [],
  };
  const bridgeReviewOk = !dataRequired || (bridge.ok !== false && bridge.checked !== false);
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
    {
      name: 'promotion_entry_trigger_bridge_reviewed',
      ok: bridgeReviewOk,
      detail: bridgeReviewDetail(bridge, dataRequired),
    },
  ];
}

function buildRunbook(gateReport: GateReport, options: RunbookOptions = {}) {
  const investmentRoot = path.resolve(options.investmentRoot || defaultInvestmentRoot());
  const extendedGateReport = gateReport as GateReport & { rollbackCommand?: string };
  return {
    reviewOnly: true,
    liveMutationAllowed: false,
    protectedPidMutationAllowed: false,
    promotionReady: false,
    requiredApproval: 'explicit_master_live_promotion_approval',
    prePromotionReviewCommands: [
      reviewCommand(PHASE10_RUNTIME_COMMAND, '-- --json --strict', investmentRoot),
      reviewCommand(PHASE11_RUNTIME_COMMAND, '-- --json --strict', investmentRoot),
      reviewCommand('runtime:luna-promotion-entry-trigger-coverage', '-- --json --dry-run --market=all --exchange=all --hours=168', investmentRoot),
      reviewCommand('runtime:luna-promotion-entry-trigger-bridge', '-- --json --dry-run --market=all --exchange=all --hours=168', investmentRoot),
      reviewCommand('runtime:luna-promotion-entry-trigger-materialize', '-- --json --dry-run --market=all --exchange=all --hours=168', investmentRoot),
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
    rollbackCommand: extendedGateReport.rollbackCommand
      || 'launchctl unsetenv LUNA_INTELLIGENT_DISCOVERY_MODE && launchctl setenv LUNA_LIVE_FIRE_ENABLED false && launchctl setenv LUNA_POSITION_RUNTIME_AUTONOMOUS_DISPATCH_ENABLED false',
    nextAction: gateReport.manualPromotionReviewCandidate
      ? 'master_review_required_before_any_live_promotion'
      : 'continue_shadow_observation_until_phase10_ready',
  };
}

async function loadPromotionEntryTriggerBridgeStatus({ queryFn, hours = 168 }: { queryFn?: QueryFn; hours?: number } = {}): Promise<BridgeStatus> {
  if (!queryFn) {
    return {
      ok: false,
      status: 'promotion_entry_trigger_bridge_not_checked',
      checked: false,
      pendingApproval: 0,
      latestAt: null,
      rows: [],
      warning: 'queryFn unavailable; run without --no-db to check promotion entry-trigger bridge status',
    };
  }
  let rows: BridgeRow[] = [];
  try {
    const queryRows = await Promise.resolve(queryFn(`
      SELECT bridge_status,
             COUNT(*)::int AS count,
             MAX(updated_at) AS latest_at,
             jsonb_agg(
               jsonb_build_object(
                 'symbol', symbol,
                 'market', market,
                 'exchange', exchange,
                 'gapReason', gap_reason,
                 'promotionConfidence', promotion_confidence,
                 'updatedAt', updated_at
               )
               ORDER BY updated_at DESC
             ) AS items
        FROM luna_promotion_entry_trigger_bridge_shadow
       WHERE updated_at >= now() - ($1::int * INTERVAL '1 hour')
         AND shadow_only IS TRUE
         AND live_mutation IS FALSE
         AND entry_trigger_db_mutation IS FALSE
       GROUP BY bridge_status
       ORDER BY latest_at DESC
    `, [Math.max(1, Number(hours || 168))]));
    rows = Array.isArray(queryRows) ? queryRows as BridgeRow[] : [];
  } catch (error) {
    const warning = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 'promotion_entry_trigger_bridge_query_failed',
      checked: false,
      pendingApproval: 0,
      latestAt: null,
      rows: [],
      warning,
    };
  }
  const pending = (rows || [])
    .filter((row: BridgeRow) => String(row.bridge_status || '') === 'shadow_bridge_pending_approval')
    .reduce((sum: number, row: BridgeRow) => sum + Number(row.count || 0), 0);
  const latestAt = (rows || [])
    .map((row: BridgeRow) => row.latest_at)
    .filter(Boolean)
    .sort()
    .at(-1) || null;
  return {
    ok: true,
    status: pending > 0
      ? 'promotion_entry_trigger_bridge_pending_approval'
      : 'promotion_entry_trigger_bridge_clear',
    checked: true,
    pendingApproval: pending,
    latestAt,
    rows: rows || [],
  };
}

export async function buildLunaHybridPromotionReviewReport(options: ReviewReportOptions = {}) {
  const hours = Math.max(1, Number(options.hours || 168));
  const gateReport = await buildLunaHybridPromotionGateReport({
    queryFn: options.queryFn,
    dataRequired: options.dataRequired,
    hours,
    investmentRoot: options.investmentRoot,
    projectRoot: options.projectRoot,
  });
  const dataRequired = options.dataRequired !== false;
  const promotionEntryTriggerBridge = await loadPromotionEntryTriggerBridgeStatus({
    queryFn: options.queryFn,
    hours,
  });
  const checklist = buildReviewChecklist(gateReport, { dataRequired, promotionEntryTriggerBridge });
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
    promotionEntryTriggerBridge,
    checklist,
    evidenceSummary: phaseEvidenceSummary(gateReport),
    runbook,
    warnings: [
      ...(gateReport.warnings || []),
      ...(promotionEntryTriggerBridge.warning
        ? [`promotion_entry_trigger_bridge_check:${promotionEntryTriggerBridge.warning}`]
        : []),
      ...(Number(promotionEntryTriggerBridge.pendingApproval || 0) > 0
        ? [`entry_trigger_bridge_pending_approval:${Number(promotionEntryTriggerBridge.pendingApproval || 0)}`]
        : []),
    ],
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
