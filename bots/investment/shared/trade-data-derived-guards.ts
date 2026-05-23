// @ts-nocheck
/**
 * Guards derived from Luna's realized trade data.
 *
 * These rules intentionally stay deterministic and env-disableable so live
 * trading behavior can be audited without depending on the current DB state.
 */

import {
  getLunaOperatingEpoch,
  shouldUseDevelopmentDerivedHardGates,
  shouldUseRowForPolicyLearning,
} from './luna-operating-epoch.ts';

const DISABLE_VALUES = new Set(['0', 'false', 'off', 'disabled']);
const ENABLE_VALUES = new Set(['1', 'true', 'on', 'enabled', 'yes']);

export const EXPECTED_SELL_NOOP_CODES = new Set([
  'missing_position',
  'partial_sell_below_minimum',
  'sell_amount_below_minimum',
  'no_free_balance_for_sell',
  'broker_position_missing',
  'invalid_sell_quantity',
]);

export const TRADE_DATA_WEAK_SYMBOLS = Object.freeze({
  'CRYPTO:OPN/USDT': { reason: 'closed>=14, winRate=0%, avgPnl=-29.18%' },
  'CRYPTO:SIGN/USDT': { reason: 'closed=6, winRate=0%, avgPnl=-14.54%' },
  'CRYPTO:KITE/USDT': { reason: 'closed=17, avgPnl=-13.48%' },
  'CRYPTO:KAT/USDT': { reason: 'closed=10, avgPnl=-8.77%' },
  'CRYPTO:SAHARA/USDT': { reason: 'closed=14, avgPnl=-3.43%' },
  'CRYPTO:MOVR/USDT': { reason: 'current epoch closed=2, avgPnl=-2.69%; require fresh confirmation before re-entry' },
  'CRYPTO:PARTI/USDT': { reason: 'current epoch loss=-5.38%; require fresh confirmation before re-entry' },
  'CRYPTO:MITO/USDT': { reason: 'current epoch loss=-2.88%; require fresh confirmation before re-entry' },
  'CRYPTO:CETUS/USDT': { reason: 'current epoch loss=-3.13%; require fresh confirmation before re-entry' },
  'CRYPTO:CHIP/USDT': { reason: 'current epoch loss=-2.69%; require fresh confirmation before re-entry' },
  'CRYPTO:LUNC/USDT': { reason: 'current epoch loss=-3.10% plus historical reconcile pressure; require cooldown/probe-only evidence before re-entry' },
  'CRYPTO:ATOM/USDT': { reason: 'current epoch loss=-1.66%; require fresh confirmation before re-entry' },
  'CRYPTO:UNI/USDT': { reason: 'current epoch loss=-1.70%; require fresh confirmation before re-entry' },
  'DOMESTIC:006340': { reason: 'closed=6, winRate=0%, avgPnl=-11.48%' },
  'OVERSEAS:POET': { reason: 'closed=3, avgPnl=-15.11%; require cooldown/probe-only evidence before re-entry' },
});

export const CRYPTO_STRUCTURAL_BLOCKED_SYMBOLS = Object.freeze({
  'CRYPTO:RLUSD/USDT': { reason: 'stablecoin pair; directional edge is too small for Luna live auto-trading' },
  'CRYPTO:USDC/USDT': { reason: 'stablecoin pair; directional edge is too small for Luna live auto-trading' },
  'CRYPTO:FDUSD/USDT': { reason: 'stablecoin pair; directional edge is too small for Luna live auto-trading' },
  'CRYPTO:TUSD/USDT': { reason: 'stablecoin pair; directional edge is too small for Luna live auto-trading' },
  'CRYPTO:BUSD/USDT': { reason: 'stablecoin pair; directional edge is too small for Luna live auto-trading' },
  'CRYPTO:USDP/USDT': { reason: 'stablecoin pair; directional edge is too small for Luna live auto-trading' },
  'CRYPTO:PYUSD/USDT': { reason: 'stablecoin pair; directional edge is too small for Luna live auto-trading' },
  'CRYPTO:DAI/USDT': { reason: 'stablecoin pair; directional edge is too small for Luna live auto-trading' },
  'CRYPTO:USDE/USDT': { reason: 'stablecoin pair; directional edge is too small for Luna live auto-trading' },
  'CRYPTO:USDS/USDT': { reason: 'stablecoin pair; directional edge is too small for Luna live auto-trading' },
  'CRYPTO:USD1/USDT': { reason: 'stablecoin pair; directional edge is too small for Luna live auto-trading' },
});

export function isTradeDataGuardEnabled(env = process.env) {
  return !DISABLE_VALUES.has(String(env.LUNA_TRADE_DATA_DERIVED_GUARDS || '').trim().toLowerCase());
}

export function isStrictTradeDataConfirmationGuardEnabled(env = process.env) {
  return ENABLE_VALUES.has(String(env.LUNA_TRADE_DATA_STRICT_CONFIRMATION_GUARD || '').trim().toLowerCase());
}

export function normalizeTradeDataMarket(market = '') {
  const value = String(market || '').trim().toLowerCase();
  if (value === 'binance' || value === 'crypto') return 'crypto';
  if (value === 'kis' || value === 'domestic') return 'domestic';
  if (value === 'kis_overseas' || value === 'overseas') return 'overseas';
  return value || 'unknown';
}

export function resolveExpectedSellNoopStatus({ action = null, code = null, status = null } = {}) {
  const normalizedAction = String(action || '').toUpperCase();
  const normalizedCode = String(code || '').trim();
  if (normalizedAction === 'SELL' && EXPECTED_SELL_NOOP_CODES.has(normalizedCode)) {
    return {
      status: 'skipped_below_min',
      classification: normalizedCode === 'missing_position' || normalizedCode === 'broker_position_missing'
        ? 'no_position_noop'
        : 'below_minimum_noop',
      reasonCode: normalizedCode,
    };
  }
  return {
    status: status || null,
    classification: null,
    reasonCode: normalizedCode || null,
  };
}

export function checkTradeDataWeakSymbol(symbol, market, env = process.env) {
  if (!isTradeDataGuardEnabled(env)) {
    return { blocked: false, source: null, reason: null, key: null };
  }
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  const normalizedMarket = normalizeTradeDataMarket(market).toUpperCase();
  if (!normalizedSymbol) return { blocked: false, source: null, reason: null, key: null };

  const keys = [
    `${normalizedMarket}:${normalizedSymbol}`,
    normalizedSymbol,
  ];
  const structuralKey = keys.find((item) => CRYPTO_STRUCTURAL_BLOCKED_SYMBOLS[item]);
  if (structuralKey) {
    const row = CRYPTO_STRUCTURAL_BLOCKED_SYMBOLS[structuralKey];
    return {
      blocked: true,
      source: 'pre_entry/crypto_structural_symbol_block',
      reason: `[structural] ${normalizedSymbol} blocked: ${row.reason}`,
      key: structuralKey,
      epoch: getLunaOperatingEpoch(env),
    };
  }
  const key = keys.find((item) => TRADE_DATA_WEAK_SYMBOLS[item]);
  if (!key) return { blocked: false, source: null, reason: null, key: null };
  const row = TRADE_DATA_WEAK_SYMBOLS[key];
  const hardGate = shouldUseDevelopmentDerivedHardGates(env);
  const source = hardGate
    ? 'pre_entry/trade_data_weak_symbol'
    : 'pre_entry/trade_data_weak_symbol_development_stage';
  return {
    blocked: hardGate,
    source,
    reason: `[trade-data] ${normalizedSymbol} cooldown: ${row.reason}`,
    key,
    epoch: getLunaOperatingEpoch(env),
  };
}

function clamp01(value, fallback = 1) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.max(0, Math.min(1, numberValue));
}

function firstFinite(...values) {
  for (const value of values) {
    if (value == null || value === '') continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function applySizingAdjustment(meta, {
  code,
  multiplier,
  reason,
} = {}) {
  if (!code || !(Number(multiplier) > 0)) return;
  const next = {
    code,
    multiplier: clamp01(multiplier, 1),
    reason: reason || code,
  };
  meta.sizingAdjustments = Array.isArray(meta.sizingAdjustments)
    ? [...meta.sizingAdjustments, next]
    : [next];
  const current = Number(meta.sizingMultiplier ?? 1);
  meta.sizingMultiplier = Number((Math.min(Number.isFinite(current) ? current : 1, next.multiplier)).toFixed(4));
}

function resolveStrategyFamilyPerformanceBias(signal = {}, strategyFamily = '') {
  const route = signal.strategy_route || signal.strategyRoute || {};
  const family = String(strategyFamily || route.selectedFamily || '').trim().toLowerCase();
  const selectedBias = Number(route?.familyPerformance?.selectedBias);
  if (Number.isFinite(selectedBias)) return selectedBias;
  const familyBias = Number(route?.familyPerformance?.bias?.[family]);
  return Number.isFinite(familyBias) ? familyBias : 0;
}

function resolveExternalEvidenceCount(signal = {}) {
  const candidates = [
    signal?.externalEvidence?.evidenceCount,
    signal?.external_evidence?.evidenceCount,
    signal?.external_evidence?.evidence_count,
    signal?.strategy_route?.externalEvidence?.evidenceCount,
    signal?.strategyRoute?.externalEvidence?.evidenceCount,
    signal?.block_meta?.externalEvidence?.evidenceCount,
    signal?.block_meta?.entryEvidence?.evidenceCount,
  ];
  for (const value of candidates) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function resolveExternalEvidenceObject(signal = {}) {
  return [
    signal?.externalEvidence,
    signal?.external_evidence,
    signal?.strategy_route?.externalEvidence,
    signal?.strategyRoute?.externalEvidence,
    signal?.block_meta?.externalEvidence,
    signal?.block_meta?.entryEvidence,
  ].find((value) => value && typeof value === 'object') || {};
}

function resolveExternalEvidenceMetrics(signal = {}) {
  const source = resolveExternalEvidenceObject(signal);
  const evidenceCount = resolveExternalEvidenceCount(signal);
  const sourceDiversity = source.sourceDiversity || source.source_diversity || {};
  const sourceCount = firstFinite(
    source.sourceCount,
    source.source_count,
    source.uniqueSourceCount,
    source.unique_source_count,
    sourceDiversity.sourceCount,
    Array.isArray(sourceDiversity.uniqueSources) ? sourceDiversity.uniqueSources.length : null,
  );
  const avgQuality = firstFinite(
    source.avgQuality,
    source.avg_quality,
    source.qualityScore,
    source.quality_score,
    source.avgSourceQuality,
    source.avg_source_quality,
  );
  const avgFreshness = firstFinite(
    source.avgFreshness,
    source.avg_freshness,
    source.freshnessScore,
    source.freshness_score,
  );
  return {
    evidenceCount,
    sourceCount,
    avgQuality,
    avgFreshness,
  };
}

function hasTechnicalPresignal(signal = {}) {
  const values = [
    signal?.hasTechnicalPresignal,
    signal?.has_technical_presignal,
    signal?.strategy_route?.hasTechnicalPresignal,
    signal?.strategyRoute?.hasTechnicalPresignal,
    signal?.block_meta?.technicalPresignal?.ok,
    signal?.block_meta?.entryEvidence?.hasTechnicalPresignal,
  ];
  if (values.some((value) => value === true || String(value).toLowerCase() === 'true')) return true;
  if (values.some((value) => value === false || String(value).toLowerCase() === 'false')) return false;
  return null;
}

function resolveTechnicalConfirmation(signal = {}) {
  const direct = hasTechnicalPresignal(signal);
  const hints = signal?.triggerHints || signal?.trigger_hints || signal?.block_meta?.entryEvidence || {};
  const mtfAgreement = firstFinite(
    signal?.mtfAgreement,
    signal?.mtf_agreement,
    hints?.mtfAgreement,
    hints?.mtf_agreement,
  );
  const mtfAlignmentScore = firstFinite(
    signal?.mtfAlignmentScore,
    signal?.mtf_alignment_score,
    hints?.mtfAlignmentScore,
    hints?.mtf_alignment_score,
  );
  const volumeBurst = firstFinite(
    signal?.volumeBurst,
    signal?.volume_burst,
    hints?.volumeBurst,
    hints?.volume_burst,
  );
  const breakoutRetest = [
    signal?.breakoutRetest,
    signal?.breakout_retest,
    hints?.breakoutRetest,
    hints?.breakout_retest,
  ].some((value) => value === true || String(value).toLowerCase() === 'true');
  const numericScore = Math.max(
    direct === true ? 1 : direct === false ? 0 : 0,
    mtfAgreement == null ? 0 : clamp01(mtfAgreement, 0),
    mtfAlignmentScore == null ? 0 : clamp01(mtfAlignmentScore, 0),
    volumeBurst == null ? 0 : clamp01(volumeBurst / 2, 0),
    breakoutRetest ? 0.62 : 0,
  );
  return {
    ok: direct === true || numericScore >= 0.58,
    direct,
    score: Number(numericScore.toFixed(4)),
    mtfAgreement,
    mtfAlignmentScore,
    volumeBurst,
    breakoutRetest,
  };
}

export function buildTradeDataConfirmationQuality(signal = {}) {
  const external = resolveExternalEvidenceMetrics(signal);
  const technical = resolveTechnicalConfirmation(signal);
  const evidenceCount = external.evidenceCount;
  const sourceCount = external.sourceCount;
  const avgQuality = external.avgQuality;
  const avgFreshness = external.avgFreshness;
  const evidenceCoverage = evidenceCount == null ? 0 : clamp01(evidenceCount / 4, 0);
  const sourceDiversity = sourceCount == null ? 0 : clamp01(sourceCount / 3, 0);
  const qualityScore = avgQuality == null ? 0.5 : clamp01(avgQuality, 0.5);
  const freshnessScore = avgFreshness == null ? 0.5 : clamp01(avgFreshness, 0.5);
  const externalScore = Number((
    evidenceCoverage * 0.45
    + sourceDiversity * 0.15
    + qualityScore * 0.22
    + freshnessScore * 0.18
  ).toFixed(4));
  const score = Number((externalScore * 0.55 + technical.score * 0.45).toFixed(4));
  const deficits = [];
  if (evidenceCount == null) deficits.push('external_evidence_missing');
  else if (evidenceCount < 2) deficits.push('external_evidence_count_lt_2');
  if (evidenceCount > 0 && sourceCount == null) deficits.push('source_diversity_missing');
  else if (sourceCount != null && sourceCount < 2) deficits.push('source_diversity_lt_2');
  if (evidenceCount > 0 && avgQuality == null) deficits.push('source_quality_missing');
  else if (avgQuality != null && avgQuality < 0.55) deficits.push('source_quality_lt_0.55');
  if (evidenceCount > 0 && avgFreshness == null) deficits.push('freshness_missing');
  else if (avgFreshness != null && avgFreshness < 0.5) deficits.push('freshness_lt_0.5');
  if (technical.direct === false) deficits.push('technical_presignal_false');
  else if (!technical.ok) deficits.push('technical_confirmation_missing');
  return {
    score,
    grade: score >= 0.74 ? 'strong' : score >= 0.58 ? 'adequate' : score >= 0.42 ? 'thin' : 'missing',
    external: {
      ...external,
      score: externalScore,
    },
    technical,
    deficits,
  };
}

export function evaluateLearningTradeQuality(row = {}, env = process.env) {
  const reasons = [];
  const status = String(row.status || '').toLowerCase();
  const closed = status === 'closed' || row.exit_time != null || row.exitTime != null;
  const rawPnl = Number(row.pnl_percent ?? row.pnlPercent);
  const tpSlSet = row.tp_sl_set === true || row.tpSlSet === true;
  const excluded = row.exclude_from_learning === true || row.excludeFromLearning === true;
  const qualityFlag = String(row.quality_flag || row.qualityFlag || '').toLowerCase();
  const hasPolicyTimestamp = [
    row.created_at,
    row.createdAt,
    row.executed_at,
    row.executedAt,
    row.entry_time,
    row.entryTime,
    row.exit_time,
    row.exitTime,
  ].some((value) => value != null && value !== '');

  if (excluded || qualityFlag === 'exclude_from_learning') reasons.push('explicitly_excluded_from_learning');
  if (hasPolicyTimestamp && !shouldUseRowForPolicyLearning(row, ['created_at', 'createdAt', 'executed_at', 'executedAt', 'entry_time', 'entryTime', 'exit_time', 'exitTime'], env)) {
    reasons.push('development_stage_before_operating_epoch');
  }
  if (!closed) reasons.push('trade_not_closed');
  if (!Number.isFinite(rawPnl) || Math.abs(rawPnl) > 1000) reasons.push('pnl_percent_outlier_or_missing');
  if (!tpSlSet) reasons.push('tp_sl_not_set');

  return {
    trusted: reasons.length === 0,
    excludeFromLearning: reasons.length > 0,
    reasons,
    qualityFlag: reasons.length > 0 ? 'low_trust_trade_data' : 'trusted',
  };
}

export function evaluateTradeDataEntryGuard(signal = {}, env = process.env) {
  if (!isTradeDataGuardEnabled(env)) {
    return { blocked: false, blockers: [], warnings: [], meta: {} };
  }
  const action = String(signal.action || '').toUpperCase();
  if (action !== 'BUY') return { blocked: false, blockers: [], warnings: [], meta: {} };

  const market = normalizeTradeDataMarket(signal.market || signal.exchange);
  const strategyFamily = String(
    signal.strategy_family
      || signal.strategyFamily
      || signal.strategy_route?.selectedFamily
      || signal.strategyRoute?.selectedFamily
      || signal.setup_type
      || '',
  ).toLowerCase();
  const tradeMode = String(signal.trade_mode || signal.tradeMode || '').toLowerCase();
  const regime = String(signal.marketRegime || signal.regime || signal.market_regime || '').toLowerCase();
  const blockers = [];
  const warnings = [];
  const meta = { market, strategyFamily: strategyFamily || null, tradeMode: tradeMode || null, regime: regime || null };
  const familyPerformanceBias = resolveStrategyFamilyPerformanceBias(signal, strategyFamily);
  const externalEvidenceCount = resolveExternalEvidenceCount(signal);
  const technicalPresignal = hasTechnicalPresignal(signal);
  const noExternalEvidence = externalEvidenceCount != null && externalEvidenceCount <= 0;
  const noTechnicalPresignal = technicalPresignal === false;
  const strictConfirmationGuard = isStrictTradeDataConfirmationGuardEnabled(env);
  const confirmationQuality = buildTradeDataConfirmationQuality(signal);
  meta.confirmationQuality = confirmationQuality;

  if (market === 'crypto' && regime.includes('trending_bull')) {
    warnings.push('crypto_trending_bull_current_epoch_mtf_required');
    meta.cryptoTrendingBullPressure = {
      reason: 'current operating-epoch trending_bull closed=9, avgPnl=-1.21%, winRate=22%; new BUY requires explicit MTF/technical confirmation',
      externalEvidenceCount,
      hasTechnicalPresignal: technicalPresignal,
    };
    applySizingAdjustment(meta, {
      code: 'crypto_trending_bull_current_epoch_mtf_required',
      multiplier: tradeMode === 'validation' ? 0.8 : 0.65,
      reason: 'trending_bull 최근 실현 손실 압력이 높아 명시적 기술 확인 전까지 sizing 축소',
    });
    if (noTechnicalPresignal) {
      blockers.push('crypto_trending_bull_without_mtf_confirmation');
      meta.cryptoTrendingBullPressure.blockerReason = 'explicit technical presignal=false under current-epoch trending_bull loss pressure';
    }
    if (confirmationQuality.grade === 'thin' || confirmationQuality.grade === 'missing') {
      warnings.push('crypto_trending_bull_confirmation_quality_thin');
      if (strictConfirmationGuard) blockers.push('crypto_trending_bull_confirmation_quality_thin');
    }
  }

  if (market === 'crypto' && strategyFamily === 'trend_following' && familyPerformanceBias <= -0.14) {
    warnings.push('crypto_trend_following_current_epoch_probe_only');
    meta.cryptoTrendFollowing = {
      reason: 'current operating-epoch trend_following closed=2, avgPnl=-3.73%, winRate=0%; keep learning but require confirmation and reduce live exposure',
      familyPerformanceBias,
      externalEvidenceCount,
      hasTechnicalPresignal: technicalPresignal,
    };
    applySizingAdjustment(meta, {
      code: 'crypto_trend_following_current_epoch_probe_only',
      multiplier: tradeMode === 'validation' ? 0.85 : 0.75,
      reason: 'trend_following 최근 실현 성과가 약해 차단 대신 live/probe sizing을 축소',
    });
    if (noExternalEvidence || noTechnicalPresignal) {
      blockers.push('crypto_trend_following_without_confirmation');
      meta.cryptoTrendFollowing.blockerReason = 'underperforming trend_following requires external evidence and technical presignal';
    }
    if (confirmationQuality.grade === 'thin' || confirmationQuality.grade === 'missing') {
      warnings.push('crypto_trend_following_confirmation_quality_thin');
      if (strictConfirmationGuard) blockers.push('crypto_trend_following_confirmation_quality_thin');
    }
  }

  if (strategyFamily === 'promotion_ready_shadow') {
    warnings.push('promotion_ready_shadow_current_epoch_probe_only');
    meta.promotionReadyShadow = {
      reason: 'current operating-epoch promotion_ready_shadow closed=3, winRate=0%, avgPnl=-5.12%; keep observation/probe until sample quality recovers',
      familyPerformanceBias,
      externalEvidenceCount,
      hasTechnicalPresignal: technicalPresignal,
    };
    applySizingAdjustment(meta, {
      code: 'promotion_ready_shadow_current_epoch_probe_only',
      multiplier: market === 'domestic' ? 0.25 : market === 'overseas' ? 0.35 : 0.5,
      reason: 'promotion_ready_shadow 최근 실현 성과가 약해 신규 진입은 observation/probe 수준으로 축소',
    });
    if ((market === 'domestic' || market === 'overseas') && (noExternalEvidence || noTechnicalPresignal)) {
      blockers.push('promotion_ready_shadow_without_confirmation');
      meta.promotionReadyShadow.blockerReason = 'promotion_ready_shadow requires fresh external evidence and technical confirmation before equity BUY';
    }
    if (confirmationQuality.grade === 'thin' || confirmationQuality.grade === 'missing') {
      warnings.push('promotion_ready_shadow_confirmation_quality_thin');
      if (strictConfirmationGuard || market === 'domestic' || market === 'overseas') {
        blockers.push('promotion_ready_shadow_confirmation_quality_thin');
      }
    }
  }

  const weak = checkTradeDataWeakSymbol(signal.symbol, market, env);
  if (weak.key) {
    meta.weakSymbol = weak;
    if (weak.blocked) {
      blockers.push('trade_data_weak_symbol');
    } else {
      warnings.push('trade_data_weak_symbol_development_stage');
    }
  }

  if (market === 'domestic' && strategyFamily === 'defensive_rotation') {
    warnings.push('domestic_defensive_rotation_probe_only');
    meta.domesticDefensiveRotation = {
      reason: 'domestic defensive_rotation closed winRate=10.7%, pnlNet=-889681 KRW',
    };
    applySizingAdjustment(meta, {
      code: 'domestic_defensive_rotation_probe_only',
      multiplier: 0.25,
      reason: 'defensive_rotation은 국내장 과거 성과가 약해 차단 대신 25% probe sizing으로 축소',
    });
  }

  if (market === 'domestic' && strategyFamily === 'mean_reversion') {
    warnings.push('domestic_mean_reversion_probe_only');
    meta.domesticMeanReversion = {
      reason: 'domestic mean_reversion closed winRate=0%, avgPnl=-6.37%',
    };
    applySizingAdjustment(meta, {
      code: 'domestic_mean_reversion_probe_only',
      multiplier: 0.35,
      reason: 'mean_reversion은 국내장 샘플이 약해 35% probe sizing으로 축소',
    });
  }

  if (market === 'crypto' && strategyFamily === 'defensive_rotation') {
    if (noExternalEvidence || noTechnicalPresignal) {
      blockers.push('crypto_defensive_rotation_without_live_evidence');
      meta.cryptoDefensiveRotationEvidence = {
        reason: 'defensive_rotation live BUY requires fresh external evidence or an explicit technical presignal',
        externalEvidenceCount,
        hasTechnicalPresignal: technicalPresignal,
      };
    }
    if (confirmationQuality.grade === 'thin' || confirmationQuality.grade === 'missing') {
      warnings.push('crypto_defensive_rotation_confirmation_quality_thin');
      if (strictConfirmationGuard) blockers.push('crypto_defensive_rotation_confirmation_quality_thin');
    }
  }

  if (market === 'crypto' && strategyFamily === 'mean_reversion') {
    warnings.push('crypto_mean_reversion_current_epoch_probe_only');
    meta.cryptoMeanReversion = {
      reason: 'current operating-epoch mean_reversion closed=4, avgPnl=-2.14%, winRate=25%; require reversal evidence before live-sized entry',
      externalEvidenceCount,
      hasTechnicalPresignal: technicalPresignal,
    };
    applySizingAdjustment(meta, {
      code: 'crypto_mean_reversion_current_epoch_probe_only',
      multiplier: tradeMode === 'validation' ? 0.65 : 0.55,
      reason: 'mean_reversion 최근 실현 성과가 약해 reversal evidence 확인 전까지 sizing 축소',
    });
    if (noExternalEvidence || noTechnicalPresignal) {
      blockers.push('crypto_mean_reversion_without_reversal_evidence');
      meta.cryptoMeanReversion.blockerReason = 'mean_reversion requires positive external or technical reversal evidence under current-epoch loss pressure';
    }
    if (confirmationQuality.grade === 'thin' || confirmationQuality.grade === 'missing') {
      warnings.push('crypto_mean_reversion_confirmation_quality_thin');
      if (strictConfirmationGuard) blockers.push('crypto_mean_reversion_confirmation_quality_thin');
    }
  }

  if (market === 'crypto' && strategyFamily === 'short_term_scalping') {
    warnings.push('crypto_short_term_scalping_early_exit_loss_pressure');
    meta.cryptoShortTermScalping = {
      reason: 'current operating-epoch sub-1h exits include 11 crypto samples with 6 losses; require fast-read confirmation before fresh scalp BUY',
      externalEvidenceCount,
      hasTechnicalPresignal: technicalPresignal,
      confirmationGrade: confirmationQuality.grade,
    };
    applySizingAdjustment(meta, {
      code: 'crypto_short_term_scalping_early_exit_loss_pressure',
      multiplier: tradeMode === 'validation' ? 0.75 : 0.65,
      reason: 'short-term/scalp 조기 손실 압력이 있어 신규 진입 sizing을 축소',
    });
    if (regime.includes('ranging') && (noExternalEvidence || noTechnicalPresignal)) {
      blockers.push('crypto_short_term_scalping_ranging_without_confirmation');
      meta.cryptoShortTermScalping.blockerReason = 'ranging scalp entries require external evidence and technical presignal after early-exit loss cluster';
    }
    if (confirmationQuality.grade === 'thin' || confirmationQuality.grade === 'missing') {
      warnings.push('crypto_short_term_scalping_confirmation_quality_thin');
      if (strictConfirmationGuard) blockers.push('crypto_short_term_scalping_confirmation_quality_thin');
    }
  }

  if (market === 'crypto' && regime.includes('ranging')) {
    warnings.push('crypto_ranging_current_epoch_probe_only');
    meta.cryptoRangingPressure = {
      reason: 'current operating-epoch ranging closed=12, avgPnl=-2.59%, winRate=25%; new BUY requires reversal/technical confirmation',
      externalEvidenceCount,
      hasTechnicalPresignal: technicalPresignal,
    };
    applySizingAdjustment(meta, {
      code: 'crypto_ranging_current_epoch_probe_only',
      multiplier: tradeMode === 'validation' ? 0.7 : 0.55,
      reason: 'ranging 장세 손실 압력으로 신규 BUY sizing 축소',
    });
    if ((strategyFamily === 'mean_reversion' || strategyFamily === 'short_term_scalping') && (noExternalEvidence || noTechnicalPresignal)) {
      blockers.push('crypto_ranging_without_reversal_confirmation');
      meta.cryptoRangingPressure.blockerReason = 'ranging mean-reversion/scalp entries require reversal evidence and technical presignal';
    }
  }

  if (tradeMode === 'validation' && (regime.includes('bear') || regime.includes('ranging'))) {
    warnings.push('validation_regime_probe_only');
    meta.validationRegime = {
      reason: regime.includes('bear')
        ? 'trending_bear validation avgPnl=-7.68%'
        : 'ranging validation avgPnl=-2.13%',
    };
    applySizingAdjustment(meta, {
      code: 'validation_regime_probe_only',
      multiplier: regime.includes('bear') ? 0.25 : 0.4,
      reason: '약세/횡보 검증 구간은 데이터 축적을 위해 probe sizing으로 축소',
    });
  }

  if (market === 'overseas') {
    warnings.push('overseas_sample_cap_required');
    meta.overseas = {
      reason: 'overseas sample is small and avgPnl=-9.63%; keep capped until >=30 closed outcomes',
    };
    applySizingAdjustment(meta, {
      code: 'overseas_sample_cap_required',
      multiplier: tradeMode === 'validation' ? 0.55 : 0.45,
      reason: 'overseas 표본이 작고 현재 평균 손실이라 신규 BUY sizing을 캡',
    });
  }

  return {
    blocked: blockers.length > 0,
    blockers,
    warnings,
    meta,
  };
}

export function applyTradeDataEntryGuardToDecision(decision = {}, exchange = null, env = process.env) {
  const guard = evaluateTradeDataEntryGuard({
    ...decision,
    exchange,
    market: decision.market || exchange,
  }, env);
  if (!guard.blocked) {
    const sizingMultiplier = Number(guard?.meta?.sizingMultiplier ?? 1);
    const shouldResize = Number.isFinite(sizingMultiplier) && sizingMultiplier > 0 && sizingMultiplier < 1 && Number(decision.amount_usdt || 0) > 0;
    if (guard.warnings.length === 0 && !shouldResize) return { decision, guard, changed: false };
    const adjustedAmount = shouldResize
      ? Number((Number(decision.amount_usdt || 0) * sizingMultiplier).toFixed(4))
      : decision.amount_usdt;
    return {
      decision: {
        ...decision,
        amount_usdt: adjustedAmount,
        confidence: shouldResize
          ? Math.max(0, Number(decision.confidence || 0) - 0.03)
          : decision.confidence,
        reasoning: shouldResize
          ? `${decision.reasoning || ''} | trade_data_probe_sizing(${sizingMultiplier})`.slice(0, 220)
          : decision.reasoning,
        block_meta: {
          ...(decision.block_meta || {}),
          trade_data_guard: guard,
        },
      },
      guard,
      changed: true,
    };
  }

  return {
    decision: {
      ...decision,
      action: 'HOLD',
      amount_usdt: 0,
      confidence: Math.max(0, Number(decision.confidence || 0) - 0.15),
      reasoning: `trade_data_entry_guard_blocked: ${guard.blockers.join(',')} | ${decision.reasoning || ''}`.slice(0, 220),
      block_meta: {
        ...(decision.block_meta || {}),
        trade_data_guard: guard,
      },
    },
    guard,
    changed: true,
  };
}

export default {
  EXPECTED_SELL_NOOP_CODES,
  TRADE_DATA_WEAK_SYMBOLS,
  CRYPTO_STRUCTURAL_BLOCKED_SYMBOLS,
  isTradeDataGuardEnabled,
  normalizeTradeDataMarket,
  resolveExpectedSellNoopStatus,
  checkTradeDataWeakSymbol,
  buildTradeDataConfirmationQuality,
  evaluateTradeDataEntryGuard,
  applyTradeDataEntryGuardToDecision,
};
