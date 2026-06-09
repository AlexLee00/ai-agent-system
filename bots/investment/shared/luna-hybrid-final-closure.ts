import path from 'node:path';
import {
  PHASE11_RUNTIME_COMMAND,
} from './luna-hybrid-promotion-review.ts';

export const LUNA_HYBRID_PHASE12 = 'phase12_hybrid_final_closure';
export const PHASE12_RUNTIME_COMMAND = 'runtime:luna-hybrid-final-closure';
export const PHASE12_A2A_SKILL = 'hybrid-final-closure';

export const LUNA_PROTECTED_6 = [
  'ai.luna.tradingview-ws',
  'ai.investment.commander',
  'ai.elixir.supervisor',
  'ai.luna.marketdata-mcp',
  'ai.claude.auto-dev.autonomous',
  'ai.hub.resource-api',
];

type StatusReport = {
  ok?: boolean;
  status?: string;
  promotionReady?: boolean;
  readyForMasterReview?: boolean;
  liveMutation?: boolean;
  protectedPidMutation?: boolean;
  gate?: { status?: string };
};

type BottleneckEvidence = {
  marketdata?: { ok?: boolean; status?: string; blockers?: unknown[] };
  finalGate?: { ok?: boolean; status?: string; blockers?: unknown[] };
  postLive?: { ok?: boolean; status?: string; blockers?: unknown[] };
};

type BottleneckReport = {
  status?: string;
  hardBlockers?: unknown[];
  bottlenecks?: unknown[];
  warnings?: unknown[];
  evidence?: BottleneckEvidence;
};

type ProtectedPidStatus = {
  visibleLabels?: unknown[];
  source?: string;
};

type ChecklistOptions = {
  phase11Report?: StatusReport;
  bottleneckReport?: BottleneckReport;
  protectedPidStatus?: ProtectedPidStatus;
  noExec?: boolean;
};

type ChecklistItem = {
  name: string;
  ok: boolean;
  detail: string;
};

type FinalClosureOptions = ChecklistOptions & {
  investmentRoot?: string;
};

function defaultInvestmentRoot() {
  return path.resolve(import.meta.dirname, '..');
}

function reviewCommand(script: string, args = '-- --json', investmentRoot = defaultInvestmentRoot()) {
  return `npm --prefix ${investmentRoot} run -s ${script} ${args}`;
}

function list(value: unknown[] | undefined = []) {
  return Array.isArray(value) ? value : [];
}

function hasStatus(report: StatusReport, expected: string[]) {
  const status = String(report.status || '');
  return expected.includes(status);
}

function isNonBlockingBottleneck(code: unknown) {
  return /live_position_reentry_blocked_recent_buy_signal/.test(String(code || ''));
}

function blockingBottlenecks(report: BottleneckReport = {}) {
  return list(report.bottlenecks).filter((code) => !isNonBlockingBottleneck(code));
}

function protectedPidCheck(protectedPidStatus: ProtectedPidStatus = {}) {
  const visible = new Set(list(protectedPidStatus.visibleLabels));
  const missing = LUNA_PROTECTED_6.filter((label) => !visible.has(label));
  return {
    labels: LUNA_PROTECTED_6,
    visibleLabels: [...visible].filter((label): label is string => typeof label === 'string' && LUNA_PROTECTED_6.includes(label)),
    missing,
    ok: missing.length === 0,
    source: protectedPidStatus.source || 'not_checked',
  };
}

function buildChecklist({
  phase11Report = {},
  bottleneckReport = {},
  protectedPidStatus = {},
  noExec = false,
}: ChecklistOptions = {}): ChecklistItem[] {
  const protectedPid = protectedPidCheck(protectedPidStatus);
  const bottleneckHardBlockers = list(bottleneckReport.hardBlockers);
  const rawBottlenecks = list(bottleneckReport.bottlenecks);
  const bottlenecks = blockingBottlenecks(bottleneckReport);
  const nonBlockingBottlenecks = rawBottlenecks.filter(isNonBlockingBottleneck);
  const marketdata = bottleneckReport.evidence?.marketdata || {};
  const finalGate = bottleneckReport.evidence?.finalGate || {};
  const postLive = bottleneckReport.evidence?.postLive || {};
  const contractOnly = noExec === true;

  return [
    {
      name: 'phase11_review_contract_ready',
      ok: contractOnly ? true : phase11Report.ok === true && phase11Report.promotionReady === false,
      detail: contractOnly
        ? 'skipped in contract-only no-exec mode'
        : phase11Report.ok === true
          ? `phase11=${phase11Report.status || 'ready'}`
          : `phase11 blocked: ${phase11Report.status || 'unknown'}`,
    },
    {
      name: 'phase11_master_review_ready',
      ok: contractOnly ? true : phase11Report.readyForMasterReview === true,
      detail: contractOnly
        ? 'skipped in contract-only no-exec mode'
        : phase11Report.readyForMasterReview === true
          ? 'ready'
          : 'Phase 11 is not ready for master review',
    },
    {
      name: 'bottleneck_autonomy_clear',
      ok: contractOnly ? true : bottleneckHardBlockers.length === 0 && bottlenecks.length === 0,
      detail: contractOnly
        ? 'skipped in contract-only no-exec mode'
        : bottleneckHardBlockers.length === 0 && bottlenecks.length === 0
          ? nonBlockingBottlenecks.length > 0
            ? `clear_with_nonblocking_guards:${nonBlockingBottlenecks.join(',')}`
            : bottleneckReport.status || 'clear'
          : `hard=${bottleneckHardBlockers.length}, bottlenecks=${bottlenecks.length}`,
    },
    {
      name: 'marketdata_realtime_ready',
      ok: contractOnly ? true : marketdata.ok === true || marketdata.status === 'marketdata_realtime_connectivity_ready',
      detail: contractOnly
        ? 'skipped in contract-only no-exec mode'
        : marketdata.status || 'not_checked',
    },
    {
      name: 'live_fire_final_gate_clear',
      ok: contractOnly ? true : finalGate.ok === true || hasStatus(finalGate, ['luna_live_fire_final_gate_clear']),
      detail: contractOnly
        ? 'skipped in contract-only no-exec mode'
        : finalGate.status || 'not_checked',
    },
    {
      name: 'post_live_fire_verified',
      ok: contractOnly ? true : postLive.ok === true || hasStatus(postLive, ['post_live_fire_verified']),
      detail: contractOnly
        ? 'skipped in contract-only no-exec mode'
        : postLive.status || 'not_checked',
    },
    {
      name: 'protected_6_visible',
      ok: contractOnly ? true : protectedPid.ok,
      detail: contractOnly
        ? 'skipped in contract-only no-exec mode'
        : protectedPid.ok
          ? 'all protected labels visible'
          : `missing: ${protectedPid.missing.join(', ')}`,
    },
    {
      name: 'live_mutation_blocked',
      ok: phase11Report.liveMutation !== true
        && phase11Report.protectedPidMutation !== true
        && phase11Report.promotionReady !== true,
      detail: 'final closure is read-only; live promotion remains master-approved only',
    },
  ];
}

function buildRunbook({ investmentRoot = defaultInvestmentRoot() }: { investmentRoot?: string } = {}) {
  const root = path.resolve(investmentRoot);
  return {
    finalClosureOnly: true,
    liveMutationAllowed: false,
    protectedPidMutationAllowed: false,
    promotionReady: false,
    requiredApproval: 'explicit_master_final_live_promotion_approval',
    finalReviewCommands: [
      reviewCommand(PHASE11_RUNTIME_COMMAND, '-- --json --strict', root),
      reviewCommand(PHASE12_RUNTIME_COMMAND, '-- --json --strict', root),
      reviewCommand('runtime:luna-bottleneck-autonomy', '-- --json --no-fail', root),
      reviewCommand('runtime:marketdata-realtime-connectivity', '-- --json --no-fail', root),
      reviewCommand('runtime:luna-live-fire-watchdog', '-- --json', root),
      reviewCommand('runtime:luna-live-fire-final-gate', '-- --json', root),
      reviewCommand('runtime:luna-post-live-fire-verify', '-- --json', root),
    ],
    prohibitedWithoutApproval: [
      'live trade',
      'live-fire cutover',
      'manual reconcile apply',
      'rollback execution',
      'secret changes',
      'protected PID restart/kill/unload',
      'promotion apply',
    ],
    nextAction: 'master_final_review_before_any_live_promotion',
  };
}

export function buildLunaHybridFinalClosureReport(options: FinalClosureOptions = {}) {
  const noExec = options.noExec === true;
  const phase11Report = options.phase11Report || {};
  const bottleneckReport = options.bottleneckReport || {};
  const protectedPidStatus = options.protectedPidStatus || {};
  const checklist = buildChecklist({ phase11Report, bottleneckReport, protectedPidStatus, noExec });
  const failures = checklist.filter((item) => !item.ok);
  const finalClosureReady = !noExec && failures.length === 0 && phase11Report.readyForMasterReview === true;
  const status = noExec
    ? 'luna_hybrid_final_closure_contract_only'
    : finalClosureReady
      ? 'luna_hybrid_final_closure_ready_for_master_operational_review'
      : 'luna_hybrid_final_closure_blocked';
  const runbook = buildRunbook({ investmentRoot: options.investmentRoot });
  const protectedPid = protectedPidCheck(protectedPidStatus);
  const rawBottlenecks = list(bottleneckReport.bottlenecks);
  const blocking = blockingBottlenecks(bottleneckReport);

  return {
    ok: failures.length === 0,
    phase: LUNA_HYBRID_PHASE12,
    status,
    shadowMode: true,
    finalClosureReady,
    masterApprovalRequired: true,
    promotionReady: false,
    liveMutation: false,
    protectedPidMutation: false,
    noExec,
    checklist,
    blockers: failures.map((item) => ({
      type: 'final_closure_check',
      name: item.name,
      detail: item.detail,
    })),
    evidence: {
      phase11: {
        status: phase11Report.status || null,
        ok: phase11Report.ok === true,
        readyForMasterReview: phase11Report.readyForMasterReview === true,
        gateStatus: phase11Report.gate?.status || null,
      },
      bottleneck: {
        status: bottleneckReport.status || null,
        hardBlockers: list(bottleneckReport.hardBlockers),
        bottlenecks: blocking,
        nonBlockingBottlenecks: rawBottlenecks.filter(isNonBlockingBottleneck),
        warnings: list(bottleneckReport.warnings),
      },
      marketdata: {
        status: bottleneckReport.evidence?.marketdata?.status || null,
        blockers: list(bottleneckReport.evidence?.marketdata?.blockers),
      },
      liveFire: {
        finalGateStatus: bottleneckReport.evidence?.finalGate?.status || null,
        finalGateBlockers: list(bottleneckReport.evidence?.finalGate?.blockers),
        postLiveStatus: bottleneckReport.evidence?.postLive?.status || null,
        postLiveBlockers: list(bottleneckReport.evidence?.postLive?.blockers),
      },
      protectedPid,
    },
    runbook,
    generatedAt: new Date().toISOString(),
  };
}

export default {
  LUNA_HYBRID_PHASE12,
  PHASE12_RUNTIME_COMMAND,
  PHASE12_A2A_SKILL,
  LUNA_PROTECTED_6,
  buildLunaHybridFinalClosureReport,
};
