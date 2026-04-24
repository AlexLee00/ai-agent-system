// @ts-nocheck
/**
 * regime-strategy-policy.ts
 *
 * 강세장/보합장/약세장/변동장별 전략 정책 수치를 한 곳에서 계산한다.
 * position-runtime-state.ts, position-reevaluator.ts, strategy-profile.ts의
 * 분산된 상수를 이 어댑터로 모은다.
 *
 * 정책 입력:
 *   market, regime, setupType, strategyFamilyFeedback,
 *   latestBacktestDrift, realizedCloseoutResult, pnlPct, holdingAgeDays,
 *   sourceQuality
 *
 * 정책 출력:
 *   stopLossPct, profitLockPct, partialExitRatioBias,
 *   reevaluationWindowMinutes, backgroundBacktestWindowDays,
 *   positionSizeMultiplier, cooldownMinutes, reentryLock,
 *   policyMode, cadenceMs, lane, monitorProfile
 */

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeString(value, fallback = null) {
  const s = String(value || '').trim().toLowerCase();
  return s || fallback;
}

// ──────────────────────────────────────────────
// 기본 베이스라인 (market별)
// ──────────────────────────────────────────────

function getBasePolicy(market = 'crypto') {
  if (market === 'crypto') {
    return {
      stopLossPct: 0.05,
      profitLockPct: 0.10,
      partialExitRatioBias: 1.0,
      reevaluationWindowMinutes: 45,
      backgroundBacktestWindowDays: 21,
      positionSizeMultiplier: 1.0,
      cooldownMinutes: 30,
      cadenceMs: 15_000,
    };
  }
  // stock (domestic/overseas)
  return {
    stopLossPct: 0.04,
    profitLockPct: 0.08,
    partialExitRatioBias: 1.0,
    reevaluationWindowMinutes: 120,
    backgroundBacktestWindowDays: 120,
    positionSizeMultiplier: 1.0,
    cooldownMinutes: 60,
    cadenceMs: 15_000,
  };
}

// ──────────────────────────────────────────────
// regime 조정
// ──────────────────────────────────────────────

function applyRegimeAdjustment(policy, regime = 'ranging', market = 'crypto') {
  const p = { ...policy };
  switch (regime) {
    case 'trending_bear':
      p.stopLossPct *= 0.8;
      p.profitLockPct *= 0.8;
      p.partialExitRatioBias += 0.15;
      p.reevaluationWindowMinutes = market === 'crypto' ? 20 : 45;
      p.backgroundBacktestWindowDays = market === 'crypto' ? 30 : 180;
      p.cooldownMinutes = Math.max(p.cooldownMinutes, 15);
      p.cadenceMs = market === 'crypto' ? 10_000 : 12_000;
      p.policyMode = 'defensive';
      p.monitorProfile = 'defensive_watch';
      p.riskGate = 'strict_risk_gate';
      break;
    case 'trending_bull':
      p.stopLossPct *= 1.05;
      p.profitLockPct *= 1.15;
      p.partialExitRatioBias -= 0.05;
      p.reevaluationWindowMinutes = market === 'crypto' ? 30 : 60;
      p.backgroundBacktestWindowDays = market === 'crypto' ? 21 : 120;
      p.cadenceMs = market === 'crypto' ? 15_000 : 20_000;
      p.policyMode = 'aggressive';
      p.monitorProfile = 'trend_follow_watch';
      p.riskGate = 'execution_safeguard';
      break;
    case 'volatile':
      p.stopLossPct *= 0.85;
      p.partialExitRatioBias += 0.1;
      p.reevaluationWindowMinutes = market === 'crypto' ? 25 : 45;
      p.backgroundBacktestWindowDays = market === 'crypto' ? 28 : 150;
      p.cadenceMs = market === 'crypto' ? 12_000 : 15_000;
      p.policyMode = 'cautious';
      p.monitorProfile = 'volatility_watch';
      p.riskGate = 'execution_safeguard';
      break;
    default: // ranging / unknown
      p.policyMode = 'balanced';
      p.monitorProfile = 'balanced_monitor';
      p.riskGate = 'execution_safeguard';
      break;
  }
  return p;
}

// ──────────────────────────────────────────────
// setupType 조정
// ──────────────────────────────────────────────

function applySetupTypeAdjustment(policy, setupType = 'unknown', market = 'crypto') {
  const p = { ...policy };
  switch (setupType) {
    case 'mean_reversion':
      p.stopLossPct *= 0.9;
      p.profitLockPct *= 0.75;
      p.partialExitRatioBias = Math.min((p.partialExitRatioBias || 1.0) * 1.2, 2.0);
      p.reevaluationWindowMinutes = Math.min(p.reevaluationWindowMinutes, market === 'crypto' ? 20 : 45);
      p.policyMode = p.policyMode === 'balanced' ? 'mean_reversion_control' : p.policyMode;
      break;
    case 'trend_following':
    case 'momentum_rotation':
      p.stopLossPct *= 1.1;
      p.profitLockPct *= 1.25;
      p.partialExitRatioBias = Math.max((p.partialExitRatioBias || 1.0) * 0.85, 0.5);
      p.reevaluationWindowMinutes = Math.max(p.reevaluationWindowMinutes, market === 'crypto' ? 30 : 90);
      p.policyMode = p.policyMode === 'balanced' ? 'trend_follow_control' : p.policyMode;
      break;
    case 'breakout':
      p.profitLockPct *= 1.05;
      p.partialExitRatioBias = Math.max((p.partialExitRatioBias || 1.0) * 0.95, 0.5);
      p.policyMode = p.policyMode === 'balanced' ? 'breakout_control' : p.policyMode;
      break;
    default:
      break;
  }
  return p;
}

// ──────────────────────────────────────────────
// 피드백/드리프트 조정
// ──────────────────────────────────────────────

function applyFeedbackAdjustment(policy, {
  familyBias = null,
  sharpeDrop = 0,
  returnDropPct = 0,
  closeoutAvgPnlPercent = null,
  closeoutWinRate = null,
} = {}) {
  const p = { ...policy };

  if (familyBias === 'downweight_by_pnl') {
    p.partialExitRatioBias += 0.08;
    p.positionSizeMultiplier *= 0.9;
  } else if (familyBias === 'downweight_by_win_rate') {
    p.partialExitRatioBias += 0.04;
    p.positionSizeMultiplier *= 0.95;
  } else if (familyBias === 'upweight_candidate') {
    p.partialExitRatioBias -= 0.03;
    p.positionSizeMultiplier = Math.min(p.positionSizeMultiplier * 1.05, 1.2);
  }

  if (safeNumber(sharpeDrop) > 0 || safeNumber(returnDropPct) > 0) {
    p.partialExitRatioBias += 0.1;
  }

  if (closeoutAvgPnlPercent != null && Number(closeoutAvgPnlPercent) < -3) {
    p.partialExitRatioBias += 0.05;
    p.stopLossPct *= 0.95;
    p.cooldownMinutes = Math.max(p.cooldownMinutes, 30);
  }

  if (closeoutWinRate != null && Number(closeoutWinRate) < 0.4) {
    p.reentryLock = true;
  }

  return p;
}

// ──────────────────────────────────────────────
// 소스 품질 조정
// ──────────────────────────────────────────────

function applySourceQualityAdjustment(policy, sourceQualityScore = 1.0) {
  const p = { ...policy };
  const q = safeNumber(sourceQualityScore, 1.0);
  if (q < 0.4) {
    // stale/low-quality: 실행 보류 권고
    p.sourceQualityBlocked = true;
    p.sourceQualityReason = `source quality ${q.toFixed(2)} < 0.4 — execution should be deferred`;
  } else if (q < 0.7) {
    p.partialExitRatioBias += 0.05;
    p.positionSizeMultiplier *= 0.95;
  }
  return p;
}

// ──────────────────────────────────────────────
// lane / monitorProfile 결정
// ──────────────────────────────────────────────

function determineLane(policy, { recommendation = 'HOLD', attentionType = null } = {}) {
  if (policy.cadenceMs > 25_000 || attentionType === 'tv_bar_stale') {
    return 'stale_recovery';
  }
  if (attentionType || recommendation !== 'HOLD') {
    return 'attention_fast_lane';
  }
  if (policy.monitorProfile === 'defensive_watch') return 'defensive_lane';
  return policy.monitorProfile === 'trend_follow_watch' ? 'trend_follow_lane' : 'normal_lane';
}

// ──────────────────────────────────────────────
// 메인 어댑터
// ──────────────────────────────────────────────

export interface RegimePolicyInput {
  exchange?: string;
  market?: 'crypto' | 'domestic' | 'overseas' | string;
  regime?: string | null;
  setupType?: string | null;
  familyBias?: string | null;
  sharpeDrop?: number;
  returnDropPct?: number;
  closeoutAvgPnlPercent?: number | null;
  closeoutWinRate?: number | null;
  sourceQualityScore?: number;
  recommendation?: string;
  attentionType?: string | null;
  pnlPct?: number;
}

export interface RegimePolicyOutput {
  market: string;
  regime: string;
  setupType: string;
  policyMode: string;
  riskGate: string;
  monitorProfile: string;
  lane: string;
  stopLossPct: number;
  profitLockPct: number;
  partialExitRatioBias: number;
  reevaluationWindowMinutes: number;
  backgroundBacktestWindowDays: number;
  positionSizeMultiplier: number;
  cooldownMinutes: number;
  cadenceMs: number;
  reentryLock?: boolean;
  sourceQualityBlocked?: boolean;
  sourceQualityReason?: string | null;
}

export function computeRegimePolicy(input: RegimePolicyInput = {}): RegimePolicyOutput {
  const market = normalizeString(
    input.market || (input.exchange === 'binance' ? 'crypto' : input.exchange ? 'stock' : 'crypto'),
    'crypto',
  );
  const regime = normalizeString(input.regime, market === 'crypto' ? 'volatile' : 'ranging');
  const setupType = normalizeString(input.setupType, 'unknown');

  let policy = getBasePolicy(market);
  policy.reentryLock = false;
  policy.sourceQualityBlocked = false;
  policy.sourceQualityReason = null;

  policy = applyRegimeAdjustment(policy, regime, market);
  policy = applySetupTypeAdjustment(policy, setupType, market);
  policy = applyFeedbackAdjustment(policy, {
    familyBias: input.familyBias || null,
    sharpeDrop: input.sharpeDrop || 0,
    returnDropPct: input.returnDropPct || 0,
    closeoutAvgPnlPercent: input.closeoutAvgPnlPercent ?? null,
    closeoutWinRate: input.closeoutWinRate ?? null,
  });
  policy = applySourceQualityAdjustment(policy, input.sourceQualityScore ?? 1.0);

  const lane = determineLane(policy, {
    recommendation: input.recommendation || 'HOLD',
    attentionType: input.attentionType || null,
  });

  return {
    market,
    regime,
    setupType,
    policyMode: policy.policyMode || 'balanced',
    riskGate: policy.riskGate || 'execution_safeguard',
    monitorProfile: policy.monitorProfile || 'balanced_monitor',
    lane,
    stopLossPct: Number(Math.min(Math.max(policy.stopLossPct, 0.01), 0.3).toFixed(4)),
    profitLockPct: Number(Math.min(Math.max(policy.profitLockPct, 0.02), 0.5).toFixed(4)),
    partialExitRatioBias: Number(Math.min(Math.max(policy.partialExitRatioBias, 0.5), 2.5).toFixed(4)),
    reevaluationWindowMinutes: Math.round(Math.min(Math.max(policy.reevaluationWindowMinutes, 5), 360)),
    backgroundBacktestWindowDays: Math.round(Math.min(Math.max(policy.backgroundBacktestWindowDays, 7), 365)),
    positionSizeMultiplier: Number(Math.min(Math.max(policy.positionSizeMultiplier, 0.1), 2.0).toFixed(4)),
    cooldownMinutes: Math.round(Math.min(Math.max(policy.cooldownMinutes, 0), 1440)),
    cadenceMs: Math.round(Math.min(Math.max(policy.cadenceMs, 5_000), 60_000)),
    reentryLock: policy.reentryLock === true,
    sourceQualityBlocked: policy.sourceQualityBlocked === true,
    sourceQualityReason: policy.sourceQualityReason || null,
  };
}

export default {
  computeRegimePolicy,
};
