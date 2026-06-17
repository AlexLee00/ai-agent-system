// @ts-nocheck

import { getTossCredentials } from '../secrets.ts';

export const TOSS_PROMOTION_STAGES = Object.freeze([
  's0_shadow',
  's1_paper_mirror',
  's2_micro_live',
  's3_scaled',
]);

function normalizeStage(value = '') {
  const raw = String(value || '').trim().toLowerCase().replace(/-/g, '_');
  if (TOSS_PROMOTION_STAGES.includes(raw)) return raw;
  if (raw === 'shadow') return 's0_shadow';
  if (raw === 'paper' || raw === 'paper_mirror') return 's1_paper_mirror';
  if (raw === 'micro_live') return 's2_micro_live';
  if (raw === 'scaled' || raw === 'scaled_live') return 's3_scaled';
  return 's0_shadow';
}

function approvalPresent(options = {}) {
  return options.promotionApproved === true
    || process.env.LUNA_TOSS_PROMOTION_APPROVED === 'true'
    || process.env.LUNA_TOSS_S2_APPROVED === 'true';
}

export function getTossPromotionStage(options = {}, deps = {}) {
  const credentials = options.credentials || deps.credentials || (deps.getTossCredentials || getTossCredentials)();
  const requested = normalizeStage(
    options.stage
    || process.env.LUNA_TOSS_PROMOTION_STAGE
    || process.env.TOSS_PROMOTION_STAGE
    || credentials?.promotionStage
    || credentials?.mode
    || 's0_shadow',
  );
  const liveTrading = options.liveTrading === true || credentials?.liveTrading === true;
  const approved = approvalPresent(options);
  if (['s2_micro_live', 's3_scaled'].includes(requested) && !(liveTrading && approved)) {
    return {
      stage: 's0_shadow',
      requestedStage: requested,
      downgraded: true,
      reason: 'toss_live_stage_requires_live_trading_and_master_approval',
      liveTrading,
      approved,
      advisoryOnly: true,
    };
  }
  return {
    stage: requested,
    requestedStage: requested,
    downgraded: false,
    reason: requested === 's0_shadow' ? 'default_shadow' : 'stage_allowed_shadow_advisory',
    liveTrading,
    approved,
    advisoryOnly: !['s2_micro_live', 's3_scaled'].includes(requested),
  };
}

export function isTossPaperMirrorStage(stageState = {}) {
  return String(stageState.stage || '') === 's1_paper_mirror';
}

export default {
  TOSS_PROMOTION_STAGES,
  getTossPromotionStage,
  isTossPaperMirrorStage,
};
