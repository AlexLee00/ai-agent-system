import {
  buildLunaHybridPromotionGateReport,
  LUNA_HYBRID_PHASE10,
  PHASE10_A2A_SKILL,
} from '../../shared/luna-hybrid-promotion-gate.ts';
import { query as defaultQuery } from '../../shared/db.ts';
import { registerSkillHandler } from '../handlers/task-handler.ts';

type HybridPromotionGateParams = {
  noDb?: boolean;
  hours?: number;
  investmentRoot?: string;
  projectRoot?: string;
  broadcast?: boolean;
};

type HybridPromotionGateOptions = {
  queryFn?: (sql: string, params?: unknown[]) => Promise<unknown> | unknown;
  hours?: number;
  investmentRoot?: string;
  projectRoot?: string;
};

type HybridPromotionQueryFn = (sql: string, params?: unknown[]) => Promise<unknown> | unknown;

function broadcastEnabled() {
  return String(process.env.LUNA_A2A_BROADCAST_ENABLED || '').toLowerCase() === 'true';
}

export function createHybridPromotionGateHandler(options: HybridPromotionGateOptions = {}) {
  return async function hybridPromotionGate(params: HybridPromotionGateParams = {}) {
    const report = await buildLunaHybridPromotionGateReport({
      queryFn: params.noDb ? undefined : options.queryFn || (defaultQuery as HybridPromotionQueryFn),
      hours: params.hours || options.hours || 168,
      investmentRoot: options.investmentRoot || params.investmentRoot,
      projectRoot: options.projectRoot || params.projectRoot,
    });
    const output = {
      ok: report.ok,
      skill: PHASE10_A2A_SKILL,
      phase: LUNA_HYBRID_PHASE10,
      shadowMode: true,
      status: report.status,
      promotionReady: report.promotionReady,
      manualPromotionReviewCandidate: report.manualPromotionReviewCandidate,
      contractReady: report.contractReady,
      dataReady: report.dataReady,
      blockers: report.blockers,
      warnings: report.warnings,
      summary: report.summary,
      broadcastPlanned: broadcastEnabled() && params?.broadcast !== false,
      liveMutation: false,
      verificationRequired: report.promotionReady,
      verificationSkill: 'verification',
      evidence: {
        source: 'luna_hybrid_promotion_gate_report',
        generatedAt: report.generatedAt,
        promotionPolicy: report.promotionPolicy,
      },
    };
    return {
      status: report.ok ? 'completed' : 'failed',
      output,
      metadata: {
        phase: LUNA_HYBRID_PHASE10,
        broadcastEnabled: broadcastEnabled(),
        liveMutation: false,
        protectedPidMutation: false,
      },
      error: report.ok ? undefined : {
        code: -32603,
        message: `hybrid promotion gate blocked: ${report.blockers.map((item) => item.name).join(', ')}`,
      },
    };
  };
}

export function registerHybridPromotionGateSkill(options: HybridPromotionGateOptions = {}) {
  registerSkillHandler(PHASE10_A2A_SKILL, createHybridPromotionGateHandler(options) as any);
}

export default {
  createHybridPromotionGateHandler,
  registerHybridPromotionGateSkill,
};
