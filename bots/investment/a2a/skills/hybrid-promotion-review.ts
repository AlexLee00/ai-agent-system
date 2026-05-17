import {
  buildLunaHybridPromotionReviewReport,
  LUNA_HYBRID_PHASE11,
  PHASE11_A2A_SKILL,
} from '../../shared/luna-hybrid-promotion-review.ts';
import { query as defaultQuery } from '../../shared/db.ts';
import { registerSkillHandler } from '../handlers/task-handler.ts';

function broadcastEnabled() {
  return String(process.env.LUNA_A2A_BROADCAST_ENABLED || '').toLowerCase() === 'true';
}

export function createHybridPromotionReviewHandler(options = {}) {
  return async function hybridPromotionReview(params = {}) {
    const report = await buildLunaHybridPromotionReviewReport({
      queryFn: params.noDb ? null : options.queryFn || defaultQuery,
      dataRequired: !params.noDb,
      hours: params.hours || options.hours || 168,
      investmentRoot: options.investmentRoot || params.investmentRoot,
      projectRoot: options.projectRoot || params.projectRoot,
    });
    const output = {
      ok: report.ok,
      skill: PHASE11_A2A_SKILL,
      phase: LUNA_HYBRID_PHASE11,
      shadowMode: true,
      status: report.status,
      readyForMasterReview: report.readyForMasterReview,
      masterApprovalRequired: report.masterApprovalRequired,
      promotionReady: false,
      checklist: report.checklist,
      runbook: report.runbook,
      blockers: report.blockers,
      warnings: report.warnings || [],
      promotionEntryTriggerBridge: report.promotionEntryTriggerBridge,
      summary: {
        ...(report.gate?.summary || {}),
        promotionEntryTriggerBridgePending: Number(report.promotionEntryTriggerBridge?.pendingApproval || 0),
      },
      broadcastPlanned: broadcastEnabled() && params?.broadcast !== false,
      liveMutation: false,
      verificationRequired: report.readyForMasterReview,
      verificationSkill: 'verification',
      evidence: {
        source: 'luna_hybrid_promotion_review_report',
        generatedAt: report.generatedAt,
        gateStatus: report.gate?.status,
      },
    };
    return {
      status: report.ok ? 'completed' : 'failed',
      output,
      metadata: {
        phase: LUNA_HYBRID_PHASE11,
        broadcastEnabled: broadcastEnabled(),
        liveMutation: false,
        protectedPidMutation: false,
      },
      error: report.ok ? undefined : {
        code: -32603,
        message: `hybrid promotion review blocked: ${report.blockers.map((item) => item.name).join(', ')}`,
      },
    };
  };
}

export function registerHybridPromotionReviewSkill(options = {}) {
  registerSkillHandler(PHASE11_A2A_SKILL, createHybridPromotionReviewHandler(options));
}

export default {
  createHybridPromotionReviewHandler,
  registerHybridPromotionReviewSkill,
};
