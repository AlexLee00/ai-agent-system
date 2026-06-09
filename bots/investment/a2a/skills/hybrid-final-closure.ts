import {
  buildLunaHybridFinalClosureReport,
  LUNA_HYBRID_PHASE12,
  PHASE12_A2A_SKILL,
} from '../../shared/luna-hybrid-final-closure.ts';
import { registerSkillHandler } from '../handlers/task-handler.ts';

type HybridFinalClosureParams = {
  noExec?: boolean;
  phase11Report?: FinalClosureInput['phase11Report'];
  bottleneckReport?: FinalClosureInput['bottleneckReport'];
  protectedPidStatus?: FinalClosureInput['protectedPidStatus'];
  investmentRoot?: string;
  broadcast?: boolean;
};

type FinalClosureInput = NonNullable<Parameters<typeof buildLunaHybridFinalClosureReport>[0]>;

type HybridFinalClosureOptions = {
  phase11Report?: FinalClosureInput['phase11Report'];
  bottleneckReport?: FinalClosureInput['bottleneckReport'];
  protectedPidStatus?: FinalClosureInput['protectedPidStatus'];
  investmentRoot?: string;
};

function broadcastEnabled() {
  return String(process.env.LUNA_A2A_BROADCAST_ENABLED || '').toLowerCase() === 'true';
}

export function createHybridFinalClosureHandler(options: HybridFinalClosureOptions = {}) {
  return async function hybridFinalClosure(params: HybridFinalClosureParams = {}) {
    const report = buildLunaHybridFinalClosureReport({
      noExec: params.noExec !== false,
      phase11Report: params.phase11Report || options.phase11Report,
      bottleneckReport: params.bottleneckReport || options.bottleneckReport,
      protectedPidStatus: params.protectedPidStatus || options.protectedPidStatus,
      investmentRoot: options.investmentRoot || params.investmentRoot,
    });
    const output = {
      ok: report.ok,
      skill: PHASE12_A2A_SKILL,
      phase: LUNA_HYBRID_PHASE12,
      shadowMode: true,
      status: report.status,
      finalClosureReady: report.finalClosureReady,
      masterApprovalRequired: report.masterApprovalRequired,
      promotionReady: false,
      checklist: report.checklist,
      runbook: report.runbook,
      blockers: report.blockers,
      broadcastPlanned: broadcastEnabled() && params?.broadcast !== false,
      liveMutation: false,
      protectedPidMutation: false,
      evidence: {
        source: 'luna_hybrid_final_closure_report',
        generatedAt: report.generatedAt,
        phase11Status: report.evidence?.phase11?.status,
        bottleneckStatus: report.evidence?.bottleneck?.status,
      },
    };
    return {
      status: report.ok ? 'completed' : 'failed',
      output,
      metadata: {
        phase: LUNA_HYBRID_PHASE12,
        broadcastEnabled: broadcastEnabled(),
        liveMutation: false,
        protectedPidMutation: false,
      },
      error: report.ok ? undefined : {
        code: -32603,
        message: `hybrid final closure blocked: ${report.blockers.map((item) => item.name).join(', ')}`,
      },
    };
  };
}

export function registerHybridFinalClosureSkill(options: HybridFinalClosureOptions = {}) {
  registerSkillHandler(PHASE12_A2A_SKILL, createHybridFinalClosureHandler(options) as any);
}

export default {
  createHybridFinalClosureHandler,
  registerHybridFinalClosureSkill,
};
