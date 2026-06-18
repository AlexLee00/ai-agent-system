// @ts-nocheck
import { recordGuardEvent } from './guard-event-recorder.ts';
import {
  ensureLunaDiscoveryEntryTables,
  expireEntryTriggers,
  expireActiveEntryTriggersForSymbols,
  getRecentFiredEntryTrigger,
  insertEntryTrigger,
  updateEntryTriggerState,
  listActiveEntryTriggers,
} from './luna-discovery-entry-store.ts';
import { getLunaIntelligentDiscoveryFlags } from './luna-intelligent-discovery-config.ts';
import { checkAvoidPatterns } from './reflexion-engine.ts';
import { getPosttradeFeedbackRuntimeConfig } from './runtime-config.ts';
import { evaluateLunaConstitutionForEntry } from './luna-constitution.ts';
import { buildPredictiveValidationEvidence } from './predictive-validation.ts';
import { isMaturePosition } from './luna-discovery-mature-policy.ts';
import { enforceTpSlRequirement } from './tp-sl-enforcer.ts';
import { evaluateTradingViewEntryGuard } from './tradingview-entry-guard.ts';
import { query as dbQuery } from './db/core.ts';
import {
  evaluateCandidateBacktestStatus,
  isShadowUnvalidatedPassthroughEnabled,
} from './candidate-backtest-gate.ts';
import {
  BINANCE_TOP_VOLUME_BLOCK_REASON,
  evaluateBinanceTopVolumeUniverseGate,
  getCachedBinanceTopVolumeUniverse,
} from './binance-top-volume-universe.ts';
import { evaluateTechnicalEntryChangeGate } from './technical-change-gates.ts';

const ACTIONS = {
  BUY: 'BUY',
  SELL: 'SELL',
  HOLD: 'HOLD',
};

function nowIso() {
  return new Date().toISOString();
}

function plusMinutes(minutes = 180) {
  return new Date(Date.now() + Math.max(1, Number(minutes || 180)) * 60000).toISOString();
}

function normalizeSymbol(symbol = '') {
  return String(symbol || '').trim().toUpperCase();
}

async function loadOpenEntryPositionSymbols(exchange = 'binance', context = {}) {
  if (Array.isArray(context.openPositionSymbols)) {
    return new Set(context.openPositionSymbols.map(normalizeSymbol).filter(Boolean));
  }
  const rows = await dbQuery(
    `SELECT symbol
       FROM positions
      WHERE amount > 0
        AND exchange = $1
        AND COALESCE(paper, false) = false`,
    [exchange],
  ).catch(() => []);
  return new Set((rows || []).map((row) => normalizeSymbol(row.symbol)).filter(Boolean));
}

async function expireOpenPositionEntryTriggers(exchange = 'binance', openPositionSymbols = new Set()) {
  const symbols = [...openPositionSymbols].filter(Boolean);
  if (symbols.length === 0) return { count: 0, symbols: [] };
  return expireActiveEntryTriggersForSymbols({
    symbols,
    exchange,
    reason: 'open_position_reentry_guard',
    triggerMetaPatch: {
      source: 'entry-trigger-engine',
      openPositionEntryTriggerExpired: true,
    },
  }).catch(() => ({ count: 0, symbols: [] }));
}

function resolveTriggerType(candidate = {}) {
  const setup = String(candidate?.setup_type || candidate?.strategy_route?.setupType || candidate?.setupType || '').toLowerCase();
  if (setup.includes('breakout')) return 'breakout_confirmation';
  if (setup.includes('mean') || setup.includes('pullback')) return 'pullback_to_support';
  if (setup.includes('volume') || setup.includes('vsa')) return 'volume_burst';
  if (setup.includes('mtf')) return 'mtf_alignment';
  if (setup.includes('news')) return 'news_momentum';
  return 'mtf_alignment';
}

function isAllowedTriggerType(triggerType, flags) {
  const allowed = Array.isArray(flags?.entryTrigger?.triggerTypes)
    ? flags.entryTrigger.triggerTypes.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  return allowed.length <= 0 || allowed.includes(triggerType);
}

function clamp01(value, fallback) {
  const numeric = finiteNumber(value, fallback);
  return Math.max(0, Math.min(1, Number(numeric ?? fallback ?? 0)));
}

function resolvePullbackMinConfidence(context = {}) {
  const explicit = context?.pullbackMinConfidence ?? process.env.LUNA_ENTRY_TRIGGER_PULLBACK_MIN_CONFIDENCE;
  if (explicit != null && String(explicit).trim() !== '') return clamp01(explicit, 0.6);
  const globalMin = finiteNumber(context?.entryTriggerMinConfidence ?? process.env.LUNA_ENTRY_TRIGGER_MIN_CONFIDENCE, null);
  return clamp01(Math.max(globalMin ?? 0.6, 0.6), 0.6);
}

function boolConfig(value, fallback = false) {
  if (value == null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return fallback;
}

function boolEnv(name, fallback = false, env = process.env) {
  return boolConfig(env?.[name], fallback);
}

function numEnv(name, fallback = 0, env = process.env) {
  const value = finiteNumber(env?.[name], NaN);
  return Number.isFinite(value) ? value : fallback;
}

function normalizeEntryTriggerMarket(exchange = 'binance') {
  const value = String(exchange || '').trim().toLowerCase();
  if (value === 'binance') return 'crypto';
  if (value === 'kis') return 'domestic';
  if (value === 'kis_overseas') return 'overseas';
  return value || 'crypto';
}

function isTruthy(value) {
  return value === true || String(value).trim().toLowerCase() === 'true';
}

function backtestRowForGate(backtest = {}) {
  if (!backtest) return null;
  return {
    ...backtest,
    max_drawdown: backtest.max_drawdown ?? backtest.maxDrawdown,
    win_rate: backtest.win_rate ?? backtest.winRate,
    gate_status: backtest.gate_status ?? backtest.gateStatus,
    would_block: backtest.would_block ?? backtest.wouldBlock,
    block_reasons: backtest.block_reasons ?? backtest.blockReasons,
    last_backtest_at: backtest.last_backtest_at ?? backtest.lastBacktestAt,
    total_trades_oos: backtest.total_trades_oos ?? backtest.totalTradesOos,
  };
}

function applyBacktestGateEvaluation(backtest = null, env = process.env, options = {}) {
  if (!backtest) return { backtest: null, evaluation: null };
  const evaluation = evaluateCandidateBacktestStatus(backtestRowForGate(backtest), env);
  const shadowUnvalidatedPassthrough = options.allowShadowUnvalidated === true
    && isShadowUnvalidatedPassthroughEnabled(env)
    && evaluation?.dataIncomplete === true
    && evaluation?.genuineFail !== true
    && evaluation?.universeBlock !== true;
  const evaluatedWouldBlock = shadowUnvalidatedPassthrough
    ? false
    : (isTruthy(backtest.wouldBlock ?? backtest.would_block) || evaluation?.wouldBlock === true);
  const evaluatedHealthy = shadowUnvalidatedPassthrough
    ? true
    : (evaluation?.wouldBlock === true ? false : backtest.healthy);
  const currentGateStatus = String(backtest.gateStatus || backtest.gate_status || '').trim();
  const evaluatedGateStatus = shadowUnvalidatedPassthrough
    ? 'shadow_unvalidated'
    : evaluation?.wouldBlock === true && !currentGateStatus.toLowerCase().startsWith('would_block')
    ? 'would_block_unhealthy'
    : currentGateStatus || null;
  const blockReasons = [
    ...parseJsonMaybe(backtest.blockReasons ?? backtest.block_reasons, []),
    ...(Array.isArray(evaluation?.reasons) ? evaluation.reasons : []),
  ];
  return {
    evaluation,
    backtest: {
      ...backtest,
      healthy: evaluatedHealthy,
      gateStatus: evaluatedGateStatus,
      wouldBlock: evaluatedWouldBlock,
      blockReasons: [...new Set(blockReasons.map((item) => String(item || '').trim()).filter(Boolean))],
      dataIncomplete: evaluation?.dataIncomplete === true,
      genuineFail: evaluation?.genuineFail === true,
      universeBlock: evaluation?.universeBlock === true,
      shadowUnvalidated: shadowUnvalidatedPassthrough,
      shadow_unvalidated: shadowUnvalidatedPassthrough,
    },
  };
}

function hasDsrBacktestHardBlock(backtest = null, options = {}) {
  const reasons = parseJsonMaybe(backtest?.blockReasons ?? backtest?.block_reasons, []);
  return reasons.some((reason) => {
    const value = String(reason || '');
    if (value.startsWith('candidate_backtest_dsr_low')) return true;
    if (value.startsWith('candidate_backtest_insufficient_trades')) {
      return options.allowInsufficientTrades !== true;
    }
    return false;
  });
}

function normalizeQualityMap(input = null) {
  if (!input) return new Map();
  if (input instanceof Map) {
    return new Map([...input.entries()].map(([symbol, quality]) => [normalizeSymbol(symbol), quality]));
  }
  if (Array.isArray(input)) {
    return new Map(input.map((quality) => [normalizeSymbol(quality?.symbol), quality]).filter(([symbol]) => symbol));
  }
  if (typeof input === 'object') {
    return new Map(Object.entries(input).map(([symbol, quality]) => [normalizeSymbol(symbol), quality]));
  }
  return new Map();
}

export async function loadActiveEntryTriggerQuality(symbols = [], context = {}) {
  const normalized = [...new Set((symbols || []).map(normalizeSymbol).filter(Boolean))];
  if (normalized.length === 0) return new Map();
  const market = String(context.market || normalizeEntryTriggerMarket(context.exchange || 'binance'));
  const queryFn = context.queryFn || dbQuery;
  const [backtestRows, predictiveRows] = await Promise.all([
    queryFn(
      `SELECT symbol, market, fresh, healthy, sharpe, max_drawdown, win_rate,
              last_backtest_at, gate_status, would_block, block_reasons, updated_at,
              sharpe_oos, sharpe_is, sharpe_oos_deflated, overfit_gap,
              n_obs_oos, total_trades_oos, oos_status, selection_method,
              dsr, psr, sr0, sr_oos_unann, periods_per_year
         FROM candidate_backtest_status
        WHERE symbol = ANY($1::text[])
          AND market = $2`,
      [normalized, market],
    ).catch(() => []),
    queryFn(
      `SELECT DISTINCT ON (symbol, market)
              symbol, market, decision, score, threshold, component_coverage,
              blocked_reason, created_at
         FROM predictive_validation_log
        WHERE symbol = ANY($1::text[])
          AND market = $2
        ORDER BY symbol, market, created_at DESC`,
      [normalized, market],
    ).catch(() => []),
  ]);

  const qualityBySymbol = new Map();
  for (const row of backtestRows || []) {
    const symbol = normalizeSymbol(row.symbol);
    if (!symbol) continue;
    const { backtest } = applyBacktestGateEvaluation({
      fresh: row.fresh,
      healthy: row.healthy,
      sharpe: row.sharpe == null ? null : Number(row.sharpe),
      maxDrawdown: row.max_drawdown == null ? null : Number(row.max_drawdown),
      winRate: row.win_rate == null ? null : Number(row.win_rate),
      lastBacktestAt: row.last_backtest_at || null,
      gateStatus: row.gate_status || null,
      wouldBlock: row.would_block,
      blockReasons: Array.isArray(row.block_reasons) ? row.block_reasons : parseJsonMaybe(row.block_reasons, []),
      updatedAt: row.updated_at || null,
      sharpeOos: row.sharpe_oos == null ? null : Number(row.sharpe_oos),
      sharpeIs: row.sharpe_is == null ? null : Number(row.sharpe_is),
      sharpeOosDeflated: row.sharpe_oos_deflated == null ? null : Number(row.sharpe_oos_deflated),
      overfitGap: row.overfit_gap == null ? null : Number(row.overfit_gap),
      nObsOos: row.n_obs_oos == null ? null : Number(row.n_obs_oos),
      totalTradesOos: row.total_trades_oos == null ? null : Number(row.total_trades_oos),
      oosStatus: row.oos_status || null,
      selectionMethod: row.selection_method || null,
      dsr: row.dsr == null ? null : Number(row.dsr),
      psr: row.psr == null ? null : Number(row.psr),
      sr0: row.sr0 == null ? null : Number(row.sr0),
      srOosUnann: row.sr_oos_unann == null ? null : Number(row.sr_oos_unann),
      periodsPerYear: row.periods_per_year == null ? null : Number(row.periods_per_year),
    }, context.env || process.env);
    qualityBySymbol.set(symbol, {
      ...(qualityBySymbol.get(symbol) || {}),
      symbol,
      market,
      backtest,
    });
  }
  for (const row of predictiveRows || []) {
    const symbol = normalizeSymbol(row.symbol);
    if (!symbol) continue;
    qualityBySymbol.set(symbol, {
      ...(qualityBySymbol.get(symbol) || {}),
      symbol,
      market,
      predictive: {
        decision: row.decision || null,
        score: row.score == null ? null : Number(row.score),
        threshold: row.threshold == null ? null : Number(row.threshold),
        componentCoverage: row.component_coverage == null ? null : Number(row.component_coverage),
        blockedReason: row.blocked_reason || null,
        createdAt: row.created_at || null,
      },
    });
  }
  return qualityBySymbol;
}

export function evaluateActiveEntryTriggerQualityGate(trigger = {}, quality = null, context = {}) {
  const enabled = boolConfig(
    context?.activeQualityGateEnabled ?? process.env.LUNA_ENTRY_TRIGGER_ACTIVE_QUALITY_GATE_ENABLED,
    true,
  );
  if (!enabled) return { ok: true, enabled: false, reason: 'active_quality_gate_disabled' };
  const mode = String(
    context?.activeQualityGateMode ?? process.env.LUNA_ENTRY_TRIGGER_ACTIVE_QUALITY_GATE_MODE ?? 'notify',
  ).trim().toLowerCase();

  const minPredictiveScore = clamp01(
    context?.activeQualityGateMinPredictiveScore ?? process.env.LUNA_ENTRY_TRIGGER_ACTIVE_QUALITY_GATE_MIN_PREDICTIVE_SCORE,
    0.55,
  );
  const maxBacktestAgeHours = Math.max(1, finiteNumber(
    context?.activeQualityGateMaxBacktestAgeHours ?? process.env.LUNA_ENTRY_TRIGGER_ACTIVE_QUALITY_GATE_MAX_BACKTEST_AGE_HOURS,
    36,
  ));
  const nowMs = Number(context.nowMs || Date.now());
  const reasons = [];
  const backtest = quality?.backtest || null;
  const predictive = quality?.predictive || null;
  const env = context.env || process.env;
  const runtimeFlags = context.flags || getLunaIntelligentDiscoveryFlags({ env });
  const liveEntryFire = typeof runtimeFlags?.shouldAllowLiveEntryFire === 'function'
    ? runtimeFlags.shouldAllowLiveEntryFire()
    : false;
  const allowShadowUnvalidated = !liveEntryFire && isShadowUnvalidatedPassthroughEnabled(env);
  const backtestEvaluation = backtest
    ? applyBacktestGateEvaluation(backtest, env, { allowShadowUnvalidated })
    : { backtest: null, evaluation: null };
  const evaluatedBacktest = backtestEvaluation.backtest;
  const shadowUnvalidatedBacktest = evaluatedBacktest?.shadowUnvalidated === true;
  const dsrHardBlock = hasDsrBacktestHardBlock(evaluatedBacktest, {
    allowInsufficientTrades: shadowUnvalidatedBacktest,
  });
  let backtestRawFresh = false;
  let backtestFresh = false;
  let backtestAgeHours = null;

  if (!quality || (!backtest && !predictive)) {
    reasons.push('active_quality_evidence_missing');
  }

  if (!evaluatedBacktest) {
    reasons.push('backtest_missing_or_stale');
  } else {
    const gateStatus = String(evaluatedBacktest.gateStatus || evaluatedBacktest.gate_status || '').trim().toLowerCase();
    const lastBacktestAt = evaluatedBacktest.lastBacktestAt || evaluatedBacktest.last_backtest_at || null;
    const ageHours = lastBacktestAt ? (nowMs - new Date(lastBacktestAt).getTime()) / 3600000 : null;
    backtestRawFresh = evaluatedBacktest.fresh === true;
    backtestAgeHours = Number.isFinite(ageHours) ? Number(ageHours.toFixed(2)) : null;
    backtestFresh = backtestRawFresh
      && Boolean(lastBacktestAt)
      && !(Number.isFinite(ageHours) && ageHours > maxBacktestAgeHours);
    if (evaluatedBacktest.fresh !== true || !lastBacktestAt || (Number.isFinite(ageHours) && ageHours > maxBacktestAgeHours)) {
      reasons.push('backtest_missing_or_stale');
    }
    if (
      evaluatedBacktest.healthy !== true
      || isTruthy(evaluatedBacktest.wouldBlock ?? evaluatedBacktest.would_block)
      || gateStatus.startsWith('would_block')
    ) {
      if (!shadowUnvalidatedBacktest) {
        reasons.push('backtest_unhealthy_or_would_block');
      }
    }
  }

  if (!predictive) {
    reasons.push('predictive_evidence_missing');
  } else {
    const decision = String(predictive.decision || '').trim().toLowerCase();
    const score = finiteNumber(predictive.score, null);
    if (decision.includes('block') || decision.includes('would_block') || predictive.blockedReason || predictive.blocked_reason) {
      reasons.push('predictive_blocked');
    }
    if (score != null && score < minPredictiveScore) {
      reasons.push('predictive_score_below_min');
    }
  }

  const uniqueReasons = [...new Set(reasons)];
  const notifyMode = mode !== 'hard_gate';
  const effectiveOk = notifyMode && !dsrHardBlock ? true : uniqueReasons.length === 0;
  return {
    ok: effectiveOk,
    enabled: true,
    notifyMode,
    hardBlock: dsrHardBlock,
    hardBlockReason: dsrHardBlock ? 'candidate_backtest_dsr_gate' : null,
    shadowUnvalidated: shadowUnvalidatedBacktest,
    shadow_unvalidated: shadowUnvalidatedBacktest,
    advisoryReasons: shadowUnvalidatedBacktest ? ['shadow_unvalidated_backtest_passthrough'] : [],
    reason: uniqueReasons[0] || 'active_quality_gate_passed',
    reasons: uniqueReasons,
    blockedReasons: uniqueReasons,
    symbol: normalizeSymbol(trigger.symbol || quality?.symbol || ''),
    minPredictiveScore,
    maxBacktestAgeHours,
    backtest: evaluatedBacktest ? {
      fresh: backtestFresh,
      rawFresh: backtestRawFresh,
      healthy: evaluatedBacktest.healthy === true,
      gateStatus: evaluatedBacktest.gateStatus || evaluatedBacktest.gate_status || null,
      wouldBlock: isTruthy(evaluatedBacktest.wouldBlock ?? evaluatedBacktest.would_block),
      dataIncomplete: evaluatedBacktest.dataIncomplete === true,
      genuineFail: evaluatedBacktest.genuineFail === true,
      universeBlock: evaluatedBacktest.universeBlock === true,
      shadowUnvalidated: shadowUnvalidatedBacktest,
      sharpe: evaluatedBacktest.sharpe ?? null,
      maxDrawdown: evaluatedBacktest.maxDrawdown ?? evaluatedBacktest.max_drawdown ?? null,
      winRate: evaluatedBacktest.winRate ?? evaluatedBacktest.win_rate ?? null,
      lastBacktestAt: evaluatedBacktest.lastBacktestAt || evaluatedBacktest.last_backtest_at || null,
      ageHours: backtestAgeHours,
      blockReasons: evaluatedBacktest.blockReasons || evaluatedBacktest.block_reasons || [],
      dsr: evaluatedBacktest.dsr ?? null,
      totalTradesOos: evaluatedBacktest.totalTradesOos ?? evaluatedBacktest.total_trades_oos ?? null,
    } : null,
    predictive: predictive ? {
      decision: predictive.decision || null,
      score: predictive.score == null ? null : Number(predictive.score),
      threshold: predictive.threshold == null ? null : Number(predictive.threshold),
      componentCoverage: predictive.componentCoverage ?? predictive.component_coverage ?? null,
      blockedReason: predictive.blockedReason || predictive.blocked_reason || null,
      createdAt: predictive.createdAt || predictive.created_at || null,
    } : null,
  };
}

function shouldExpireQualityBlockedActiveTriggers(context = {}) {
  return boolConfig(
    context?.expireQualityBlockedActiveTriggers ?? process.env.LUNA_ENTRY_TRIGGER_ACTIVE_QUALITY_EXPIRE_BLOCKED_ENABLED,
    true,
  );
}

function isTerminalActiveEntryTriggerQualityGateBlock(qualityGate = {}) {
  if (!qualityGate?.enabled || qualityGate?.ok === true) return false;
  const reasons = new Set((qualityGate.reasons || []).map((reason) => String(reason || '').trim()));
  return reasons.has('backtest_unhealthy_or_would_block') || reasons.has('predictive_blocked');
}

function resolvePullbackTechnicalConfirmation(details = {}, thresholds = {}, context = {}) {
  const enabled = boolConfig(
    context?.pullbackTechnicalConfirmationEnabled ?? process.env.LUNA_ENTRY_TRIGGER_PULLBACK_TECHNICAL_CONFIRMATION_ENABLED,
    true,
  );
  const gapTolerance = Math.max(0, finiteNumber(
    context?.pullbackTechnicalConfirmationTolerance ?? process.env.LUNA_ENTRY_TRIGGER_PULLBACK_TECHNICAL_CONFIRMATION_TOLERANCE,
    0.05,
  ));
  const minMtfAgreement = clamp01(
    context?.pullbackTechnicalConfirmationMinMtfAgreement ?? process.env.LUNA_ENTRY_TRIGGER_PULLBACK_TECHNICAL_CONFIRMATION_MIN_MTF,
    0.8,
  );
  const minMtfAlignmentScore = Math.max(0, finiteNumber(
    context?.pullbackTechnicalConfirmationMinMtfAlignmentScore ?? process.env.LUNA_ENTRY_TRIGGER_PULLBACK_TECHNICAL_CONFIRMATION_MIN_ALIGNMENT,
    0.18,
  ));
  const minVolumeBurst = Math.max(0, finiteNumber(
    context?.pullbackTechnicalConfirmationMinVolumeBurst ?? process.env.LUNA_ENTRY_TRIGGER_PULLBACK_TECHNICAL_CONFIRMATION_MIN_VOLUME,
    1.1,
  ));
  const mtfAlignmentScore = finiteNumber(details.mtfAlignmentScore, 0);
  const gaps = {
    confidence: Number((Number(thresholds.minConfidence || 0) - Number(details.confidence || 0)).toFixed(6)),
    predictiveScore: Number((Number(thresholds.minPredictiveScore || 0) - Number(details.predictiveScore || 0)).toFixed(6)),
    discoveryScore: Number((Number(thresholds.minDiscoveryScore || 0) - Number(details.discoveryScore || 0)).toFixed(6)),
  };
  const gapOk = Object.values(gaps).every((gap) => Number.isFinite(gap) && gap >= 0 && gap <= gapTolerance);
  const ok = enabled
    && details.breakoutRetest === true
    && details.mtfBullish === true
    && Number(details.mtfAgreement || 0) >= minMtfAgreement
    && mtfAlignmentScore >= minMtfAlignmentScore
    && Number(details.volumeBurst || 0) >= minVolumeBurst
    && gapOk;
  return {
    ok,
    enabled,
    gapTolerance,
    gaps,
    minMtfAgreement,
    minMtfAlignmentScore,
    minVolumeBurst,
    observedMtfAgreement: Number(details.mtfAgreement || 0),
    observedMtfAlignmentScore: mtfAlignmentScore,
    observedVolumeBurst: Number(details.volumeBurst || 0),
  };
}

function applyEntryTriggerEffectiveScores(candidate = {}, fireReadiness = {}) {
  const details = fireReadiness?.details || {};
  if (details.technicalProbeApplied !== true) return candidate;
  const effectiveConfidence = Math.max(Number(candidate.confidence || 0), Number(details.effectiveConfidence || 0));
  const effectivePredictiveScore = Math.max(Number(candidate.predictiveScore || 0), Number(details.effectivePredictiveScore || 0));
  const effectiveDiscoveryScore = Math.max(
    Number(candidate.triggerHints?.discoveryScore || 0),
    Number(details.effectiveDiscoveryScore || 0),
  );
  return {
    ...candidate,
    confidence: effectiveConfidence,
    predictiveScore: effectivePredictiveScore,
    prediction: {
      ...(candidate.prediction || {}),
      score: Math.max(Number(candidate.prediction?.score || 0), effectivePredictiveScore),
      source: 'pullback_technical_confirmation',
    },
    analystAccuracy: Math.max(Number(candidate.analystAccuracy || 0), effectiveConfidence),
    triggerHints: {
      ...(candidate.triggerHints || {}),
      discoveryScore: effectiveDiscoveryScore,
      activeTechnicalConfirmation: details.technicalConfirmation || null,
    },
    block_meta: {
      ...(candidate.block_meta || {}),
      activeTechnicalConfirmation: details.technicalConfirmation || null,
    },
  };
}

function resolveActiveEntryTriggerPredictiveScore(trigger = {}, triggerQuality = null) {
  const stored = finiteNumber(trigger.predictive_score ?? trigger.predictiveScore, null);
  if (stored != null && stored > 0) return stored;
  const qualityScore = finiteNumber(triggerQuality?.predictive?.score, null);
  if (qualityScore != null && qualityScore > 0) return qualityScore;
  return null;
}

export function buildEntryTriggerFireReadiness(candidate = {}, context = {}) {
  const hints = candidate?.triggerHints || {};
  const rawMtfAgreement = hints.mtfAgreement ?? context?.mtfAgreement ?? null;
  const mtfAgreementValue = finiteNumber(rawMtfAgreement, null);
  const mtfAgreement = mtfAgreementValue == null ? 0 : mtfAgreementValue;
  const rawMtfAlignmentScore = hints.mtfAlignmentScore ?? hints.alignmentScore ?? context?.mtfAlignmentScore ?? null;
  const mtfAlignmentScore = rawMtfAlignmentScore == null ? null : Number(rawMtfAlignmentScore);
  const mtfDominantSignal = String(hints.mtfDominantSignal ?? hints.dominantSignal ?? context?.mtfDominantSignal ?? '').toUpperCase();
  const technicalTelemetry = hints.technicalTelemetry || context?.technicalTelemetry || {};
  const mtfTelemetryAvailable = technicalTelemetry.mtfAvailable === true
    || (
      technicalTelemetry.mtfAvailable !== false
      && mtfAgreementValue != null
    );
  const mtfBullish = mtfTelemetryAvailable
    ? mtfDominantSignal
      ? mtfDominantSignal === ACTIONS.BUY
      : Number.isFinite(mtfAlignmentScore)
        ? mtfAlignmentScore > 0
        : mtfAgreement > 0
    : false;
  const discoveryScore = Number(hints.discoveryScore ?? context?.discoveryScore ?? 0);
  const rawVolumeBurst = hints.volumeBurst ?? context?.volumeBurst ?? null;
  const volumeBurstValue = finiteNumber(rawVolumeBurst, null);
  const volumeBurst = volumeBurstValue == null ? 0 : volumeBurstValue;
  const volumeTelemetryAvailable = technicalTelemetry.volumeAvailable === true
    || (technicalTelemetry.volumeAvailable !== false && volumeBurstValue != null);
  const breakoutRetest = hints.breakoutRetest === true;
  const newsMomentum = Number(hints.newsMomentum ?? 0);
  const confidence = Number(candidate?.confidence ?? context?.confidence ?? 0);
  const predictiveScore = Number(candidate?.predictiveScore ?? context?.predictiveScore ?? 0);
  const triggerType = String(candidate?.triggerType || candidate?.trigger_type || resolveTriggerType(candidate));
  const setupType = String(candidate?.setup_type || candidate?.setupType || '').trim().toLowerCase();
  const details = {
    triggerType,
    setupType: setupType || null,
    mtfAgreement,
    mtfAlignmentScore: Number.isFinite(mtfAlignmentScore) ? mtfAlignmentScore : null,
    mtfDominantSignal: mtfDominantSignal || null,
    mtfBullish,
    discoveryScore,
    volumeBurst,
    technicalTelemetry: {
      ...technicalTelemetry,
      mtfAvailable: mtfTelemetryAvailable,
      volumeAvailable: volumeTelemetryAvailable,
      missing: hints.technicalTelemetryMissing === true || context?.technicalTelemetryMissing === true || !mtfTelemetryAvailable || !volumeTelemetryAvailable,
    },
    breakoutRetest,
    newsMomentum,
    confidence,
    predictiveScore,
  };
  const promotionReadyTrigger = setupType === 'promotion_ready_shadow' || hints.promotionReady === true || context?.promotionReady === true;
  if (promotionReadyTrigger) {
    const minConfidence = clamp01(
      context?.promotionReadyMinConfidence ?? process.env.LUNA_ENTRY_TRIGGER_PROMOTION_READY_MIN_CONFIDENCE,
      0.65,
    );
    const minPassCount = Math.max(1, finiteNumber(
      context?.promotionReadyMinPassCount ?? process.env.LUNA_ENTRY_TRIGGER_PROMOTION_READY_MIN_PASS_COUNT,
      3,
    ));
    const minConsecutivePasses = Math.max(1, finiteNumber(
      context?.promotionReadyMinConsecutivePasses ?? process.env.LUNA_ENTRY_TRIGGER_PROMOTION_READY_MIN_CONSECUTIVE_PASSES,
      3,
    ));
    const passCount = finiteNumber(hints.promotionPassCount ?? context?.promotionPassCount, 0);
    const consecutivePasses = finiteNumber(hints.promotionConsecutivePasses ?? context?.promotionConsecutivePasses, 0);
    const promotionDetails = {
      ...details,
      minConfidence,
      minPassCount,
      minConsecutivePasses,
      promotionPassCount: passCount,
      promotionConsecutivePasses: consecutivePasses,
    };
    if (confidence < minConfidence || passCount < minPassCount || consecutivePasses < minConsecutivePasses) {
      return { ok: false, reason: 'promotion_shadow_readiness_incomplete', details: promotionDetails };
    }
    Object.assign(details, {
      promotionShadowReadinessConfirmed: true,
      minConfidence,
      minPassCount,
      minConsecutivePasses,
      promotionPassCount: passCount,
      promotionConsecutivePasses: consecutivePasses,
    });
  }

  if (triggerType === 'pullback_to_support') {
    const minConfidence = resolvePullbackMinConfidence(context);
    const minPredictiveScore = clamp01(context?.pullbackMinPredictiveScore ?? process.env.LUNA_ENTRY_TRIGGER_PULLBACK_MIN_PREDICTIVE_SCORE, 0.55);
    const minDiscoveryScore = clamp01(context?.pullbackMinDiscoveryScore ?? process.env.LUNA_ENTRY_TRIGGER_PULLBACK_MIN_DISCOVERY_SCORE, 0.58);
    const pullbackDetails = {
      ...details,
      minConfidence,
      minPredictiveScore,
      minDiscoveryScore,
    };
    if (
      breakoutRetest
      && confidence >= minConfidence
      && predictiveScore >= minPredictiveScore
      && discoveryScore >= minDiscoveryScore
    ) {
      return { ok: true, reason: 'pullback_target_retest_predictive_confirmed', details: pullbackDetails };
    }
    const technicalConfirmation = resolvePullbackTechnicalConfirmation(details, {
      minConfidence,
      minPredictiveScore,
      minDiscoveryScore,
    }, context);
    if (technicalConfirmation.ok) {
      return {
        ok: true,
        reason: 'pullback_retest_mtf_technical_probe_confirmed',
        details: {
          ...pullbackDetails,
          technicalProbeApplied: true,
          effectiveConfidence: minConfidence,
          effectivePredictiveScore: minPredictiveScore,
          effectiveDiscoveryScore: minDiscoveryScore,
          technicalConfirmation,
        },
      };
    }
    return {
      ok: false,
      reason: 'pullback_confirmation_incomplete',
      details: {
        ...pullbackDetails,
        technicalConfirmation,
      },
    };
  }

  if (mtfBullish && breakoutRetest && mtfAgreement >= 0.62) return { ok: true, reason: 'breakout_retest_mtf_confirmed', details };
  if (mtfBullish && volumeBurst >= 1.8 && mtfAgreement >= 0.58) return { ok: true, reason: 'volume_burst_mtf_confirmed', details };
  if (newsMomentum >= 0.6 && discoveryScore >= 0.62) return { ok: true, reason: 'news_momentum_discovery_confirmed', details };
  if (mtfBullish && mtfAgreement >= 0.72 && discoveryScore >= 0.58) return { ok: true, reason: 'mtf_discovery_confirmed', details };

  return { ok: false, reason: 'fire_condition_unmet', details };
}

function shouldFireTrigger(candidate = {}, context = {}) {
  return buildEntryTriggerFireReadiness(candidate, context).ok;
}

function summarizeEntryChartGuard(guard = {}) {
  return {
    ok: guard?.ok === true,
    blocked: guard?.blocked === true,
    reason: guard?.reason || null,
    entryMode: guard?.entryMode || null,
    sourcePolicy: guard?.sourcePolicy || null,
    symbol: guard?.symbol || null,
    exchange: guard?.exchange || null,
    checks: Array.isArray(guard?.checks) ? guard.checks : [],
    dailyTrend: guard?.dailyTrend
      ? {
          ok: guard.dailyTrend.ok === true,
          blocked: guard.dailyTrend.blocked === true,
          reason: guard.dailyTrend.reason || null,
          trend: guard.dailyTrend.trend || null,
          checks: Array.isArray(guard.dailyTrend.checks) ? guard.dailyTrend.checks : [],
        }
      : null,
  };
}

function annotateEntryTrigger(candidate = {}, entryTrigger = {}) {
  return {
    ...candidate,
    block_meta: {
      ...(candidate?.block_meta || {}),
      entryTrigger: {
        ...((candidate?.block_meta || {}).entryTrigger || {}),
        ...entryTrigger,
      },
    },
  };
}

function isPredictiveObservationCandidate(candidate = {}) {
  const predictive = candidate?.block_meta?.predictiveValidation || {};
  return predictive.observation === true && predictive.blocked !== true;
}

function getPredictiveObservationMaxPerCycle(flags = {}) {
  const raw = process.env.LUNA_PREDICTIVE_OBSERVATION_MAX_PER_CYCLE
    ?? flags?.predictive?.maxObservationPerCycle
    ?? 1;
  const num = Number(raw);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : 1;
}

function finiteNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function resolveCapitalSnapshot(candidate = {}, context = {}) {
  return (
    context?.capitalSnapshot
    || context?.portfolio?.capitalSnapshot
    || candidate?.capitalSnapshot
    || candidate?.portfolio?.capitalSnapshot
    || null
  );
}

function resolveCapitalCheck(candidate = {}, context = {}) {
  return (
    candidate?.block_meta?.capitalCheck
    || candidate?.capitalCheck
    || context?.capitalCheck
    || null
  );
}

function resolveCandidateTpSlInput(candidate = {}, context = {}, market = 'crypto') {
  return {
    entryPrice: candidate?.entry_price ?? candidate?.entryPrice ?? candidate?.target_price ?? candidate?.targetPrice ?? context?.entryPrice ?? null,
    side: candidate?.side || 'BUY',
    atr: candidate?.atr ?? candidate?.atr_value ?? candidate?.indicators?.atr ?? candidate?.block_meta?.atr ?? context?.atr ?? null,
    prePlannedSl: candidate?.sl_price ?? candidate?.stop_loss ?? candidate?.stopLoss ?? candidate?.block_meta?.sl_price ?? null,
    prePlannedTp: candidate?.tp_price ?? candidate?.take_profit ?? candidate?.takeProfit ?? candidate?.block_meta?.tp_price ?? null,
    tpSlSet: candidate?.tp_sl_set === true || candidate?.tpSlSet === true || candidate?.block_meta?.tp_sl_set === true || candidate?.block_meta?.tpSlSet === true,
    market,
    symbol: candidate?.symbol || null,
  };
}

function applyComputedTpSl(candidate = {}, enforcement = null) {
  if (!enforcement?.computed) return candidate;
  return {
    ...candidate,
    tp_sl_set: true,
    sl_price: candidate?.sl_price ?? candidate?.stop_loss ?? candidate?.stopLoss ?? enforcement.computed.stopLoss,
    tp_price: candidate?.tp_price ?? candidate?.take_profit ?? candidate?.takeProfit ?? enforcement.computed.takeProfit,
    block_meta: {
      ...(candidate?.block_meta || {}),
      tp_sl_enforcer: {
        allowed: true,
        alreadySet: false,
        computed: enforcement.computed,
        warningMessage: enforcement.warningMessage || null,
      },
    },
  };
}

function parseJsonMaybe(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function resolveCandidateStrategyRoute(candidate = {}) {
  return candidate?.strategy_route || candidate?.strategyRoute || null;
}

function resolveCandidateStrategyQuality(candidate = {}, route = null) {
  return candidate?.strategy_quality || candidate?.strategyQuality || route?.quality || null;
}

function resolveCandidateStrategyReadiness(candidate = {}, route = null) {
  const value = candidate?.strategy_readiness
    ?? candidate?.strategyReadiness
    ?? route?.readinessScore
    ?? route?.readiness
    ?? null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function signalRowToEntryCandidate(row = {}) {
  const strategyRoute = parseJsonMaybe(row.strategy_route, null);
  const blockMeta = parseJsonMaybe(row.block_meta, {});
  const strategyQuality = row.strategy_quality || strategyRoute?.quality || null;
  const strategyReadiness = resolveCandidateStrategyReadiness({
    strategy_readiness: row.strategy_readiness,
  }, strategyRoute);
  return {
    symbol: row.symbol,
    action: ACTIONS.BUY,
    amount_usdt: Number(row.amount_usdt || 0),
    confidence: Number(row.confidence || 0),
    reasoning: `entry_trigger_signal_refresh(${row.id}) | ${row.reasoning || ''}`.slice(0, 220),
    exchange: row.exchange || 'binance',
    strategy_family: row.strategy_family || strategyRoute?.selectedFamily || null,
    strategy_route: strategyRoute,
    strategy_quality: strategyQuality,
    strategy_readiness: strategyReadiness,
    setup_type: strategyRoute?.setupType || row.strategy_family || null,
    entry_price: blockMeta?.entry_price ?? blockMeta?.entryPrice ?? null,
    atr: blockMeta?.atr ?? blockMeta?.atr_value ?? null,
    tp_sl_set: blockMeta?.tp_sl_set === true || blockMeta?.tpSlSet === true,
    sl_price: blockMeta?.sl_price ?? blockMeta?.stop_loss ?? null,
    tp_price: blockMeta?.tp_price ?? blockMeta?.take_profit ?? null,
    triggerHints: {
      ...(blockMeta?.entryTrigger?.hints || {}),
      discoveryScore: Number(row.confidence || 0),
    },
    block_meta: {
      ...blockMeta,
      entryTriggerSignalRefresh: {
        signalId: row.id,
        signalCreatedAt: row.created_at || null,
        source: 'recent_buy_signal',
      },
    },
  };
}

export function evaluateEntryTriggerLiveRiskGate({ candidate = {}, trigger = null, context = {}, flags = null } = {}) {
  const runtimeFlags = flags || getLunaIntelligentDiscoveryFlags();
  const gate = runtimeFlags.entryTrigger || {};
  if (!runtimeFlags.shouldAllowLiveEntryFire() || gate.liveRiskGateEnabled === false) {
    return { ok: true, reason: 'not_required' };
  }

  const confidence = finiteNumber(candidate?.confidence ?? trigger?.confidence, 0);
  const predictiveScore = finiteNumber(candidate?.predictiveScore ?? trigger?.predictive_score, 0);
  const amountUsdt = finiteNumber(candidate?.amount_usdt ?? candidate?.amountUsdt ?? context?.defaultAmountUsdt, 0);
  const capitalSnapshot = resolveCapitalSnapshot(candidate, context);
  const capitalCheck = resolveCapitalCheck(candidate, context);
  const triggerType = String(candidate?.triggerType || candidate?.trigger_type || trigger?.trigger_type || '').trim();
  const minLiveConfidence = finiteNumber(gate.minLiveConfidence, 0.68);
  const pullbackMinLiveConfidence = triggerType === 'pullback_to_support'
    ? Math.min(minLiveConfidence, resolvePullbackMinConfidence(context))
    : minLiveConfidence;
  const minPredictiveScore = finiteNumber(gate.minLivePredictiveScore, 0);
  const minLiveAmountUsdt = finiteNumber(gate.minLiveAmountUsdt, 0);
  const predictiveObservation = isPredictiveObservationCandidate(candidate);
  const effectiveMinLiveConfidence = predictiveObservation
    ? finiteNumber(gate.minPredictiveObservationConfidence, 0.35)
    : pullbackMinLiveConfidence;

  if (confidence < effectiveMinLiveConfidence) {
    return {
      ok: false,
      reason: 'live_confidence_below_min',
      details: {
        confidence,
        minLiveConfidence: effectiveMinLiveConfidence,
        configuredMinLiveConfidence: minLiveConfidence,
        triggerType,
        predictiveObservation,
      },
    };
  }

  if (gate.requirePredictiveScore && predictiveScore <= 0) {
    return {
      ok: false,
      reason: 'predictive_score_missing',
      details: { minPredictiveScore },
    };
  }

  if (minPredictiveScore > 0 && predictiveScore > 0 && predictiveScore < minPredictiveScore) {
    return {
      ok: false,
      reason: 'predictive_score_below_min',
      details: { predictiveScore, minPredictiveScore },
    };
  }

  if (runtimeFlags.phases.predictiveValidationEnabled && runtimeFlags.predictive?.mode === 'hard_gate') {
    const evidence = buildPredictiveValidationEvidence(candidate, context, runtimeFlags.predictive);
    if (runtimeFlags.predictive?.requireComponents && Object.keys(evidence.components || {}).length === 0) {
      return {
        ok: false,
        reason: 'predictive_components_missing',
        details: evidence,
      };
    }
    if (evidence.blocked && !predictiveObservation) {
      return {
        ok: false,
        reason: `predictive_validation_${evidence.decision}`,
        details: evidence,
      };
    }
  }

  if (minLiveAmountUsdt > 0 && amountUsdt > 0 && amountUsdt < minLiveAmountUsdt) {
    return {
      ok: false,
      reason: 'live_amount_below_min',
      details: { amountUsdt, minLiveAmountUsdt },
    };
  }

  if (capitalCheck && capitalCheck.result && !['accepted', 'reduced'].includes(String(capitalCheck.result))) {
    return {
      ok: false,
      reason: 'capital_check_not_accepted',
      details: { result: capitalCheck.result, reason: capitalCheck.reason || null },
    };
  }

  if (gate.requireLiveRiskContext && !capitalSnapshot && !capitalCheck) {
    return {
      ok: false,
      reason: 'risk_context_missing',
      details: { requireLiveRiskContext: true },
    };
  }

  if (gate.requireCapitalActive && capitalSnapshot) {
    if (capitalSnapshot.balanceStatus && capitalSnapshot.balanceStatus !== 'ok') {
      return {
        ok: false,
        reason: 'balance_status_not_ok',
        details: { balanceStatus: capitalSnapshot.balanceStatus },
      };
    }
    if (capitalSnapshot.mode && capitalSnapshot.mode !== 'ACTIVE_DISCOVERY') {
      return {
        ok: false,
        reason: 'capital_mode_not_active',
        details: { mode: capitalSnapshot.mode, reasonCode: capitalSnapshot.reasonCode || null },
      };
    }
    if (Number.isFinite(Number(capitalSnapshot.remainingSlots)) && Number(capitalSnapshot.remainingSlots) <= 0) {
      return {
        ok: false,
        reason: 'no_remaining_position_slots',
        details: { remainingSlots: Number(capitalSnapshot.remainingSlots) },
      };
    }
    const buyableAmount = finiteNumber(capitalSnapshot.buyableAmount, 0);
    const minOrderAmount = finiteNumber(capitalSnapshot.minOrderAmount, 0);
    const requiredAmount = Math.max(minOrderAmount, minLiveAmountUsdt, amountUsdt > 0 ? Math.min(amountUsdt, minOrderAmount || amountUsdt) : 0);
    if (requiredAmount > 0 && buyableAmount < requiredAmount) {
      return {
        ok: false,
        reason: 'buyable_amount_below_required',
        details: { buyableAmount, requiredAmount, minOrderAmount },
      };
    }
  }

  return {
    ok: true,
    reason: 'live_risk_gate_passed',
    details: {
      confidence,
      predictiveScore,
      amountUsdt,
      capitalMode: capitalSnapshot?.mode || null,
      capitalCheckResult: capitalCheck?.result || null,
    },
  };
}

// HARD limit 4 (자금 한도 / 잔고 상태): 기존 CAPITAL_HARD_BLOCKS 의미와 이름은 보존한다.
// predictive_validation_discard는 자금 한도는 아니지만 hard_gate 모드에서 이미 "discard"로
// 판정된 후보이므로 notify-only로 흘리지 않고 entry fire를 차단한다.
const CAPITAL_HARD_BLOCKS = new Set([
  'no_remaining_position_slots',
  'buyable_amount_below_required',
  'balance_status_not_ok',
  'capital_mode_not_active',
]);

const ENTRY_TRIGGER_RISK_GATE_HARD_BLOCKS = new Set([
  ...CAPITAL_HARD_BLOCKS,
  'predictive_validation_discard',
]);

function isEntryTriggerRiskGateHardBlock(reason) {
  return ENTRY_TRIGGER_RISK_GATE_HARD_BLOCKS.has(String(reason || ''));
}

function resolveEntryTriggerRiskGateBlockReason(reason) {
  return CAPITAL_HARD_BLOCKS.has(String(reason || ''))
    ? 'live_risk_gate_capital_hard_block'
    : 'live_risk_gate_predictive_hard_block';
}

function isTerminalEntryTriggerLiveRiskGateBlock(riskGate = {}) {
  if (riskGate?.reason !== 'live_confidence_below_min') return false;
  const confidence = finiteNumber(riskGate?.details?.confidence, 0);
  const minLiveConfidence = finiteNumber(riskGate?.details?.minLiveConfidence, 0);
  const tolerance = Math.max(0, finiteNumber(process.env.LUNA_ENTRY_TRIGGER_TERMINAL_CONFIDENCE_GAP, 0.08));
  return confidence + tolerance < minLiveConfidence;
}

export async function evaluateEntryTriggers(candidates = [], context = {}) {
  const env = context?.env || process.env;
  const flags = context?.flags || getLunaIntelligentDiscoveryFlags({ env });
  const posttradeCfg = getPosttradeFeedbackRuntimeConfig();
  const constitutionalEnabled = posttradeCfg?.constitutional_feedback?.enabled === true;
  if (!flags.phases.entryTriggerEnabled) {
    return { decisions: candidates, stats: { enabled: false, armed: 0, fired: 0, blocked: 0 } };
  }

  await ensureLunaDiscoveryEntryTables();
  await expireEntryTriggers().catch(() => 0);

  const exchange = String(context.exchange || 'binance');
  const openPositionSymbols = await loadOpenEntryPositionSymbols(exchange, context);
  await expireOpenPositionEntryTriggers(exchange, openPositionSymbols);
  const ttlMinutes = Number(flags.entryTrigger.ttlMinutes || 180);
  const minConfidence = numEnv('LUNA_MIN_CONFIDENCE', Number(flags.entryTrigger.minConfidence || 0.48), env);
  const fireCooldownMinutes = Number(flags.entryTrigger.fireCooldownMinutes || 10);
  const allowLiveFire = flags.shouldAllowLiveEntryFire();
  const shouldMutate = flags.shouldEntryTriggerMutate();
  const LUNA_FULL_DATA_LOOP = boolEnv('LUNA_FULL_DATA_LOOP_ENABLED', true, env);
  const activeMap = new Map();
  const existing = await listActiveEntryTriggers({ exchange, limit: 1000 }).catch(() => []);
  for (const row of existing) {
    activeMap.set(`${row.symbol}:${row.trigger_type}`, row);
  }

  const output = [];
  let armed = 0;
  let fired = 0;
  let blocked = 0;
  let observed = 0;
  let predictiveObservationFired = 0;
  const predictiveObservationMaxPerCycle = getPredictiveObservationMaxPerCycle(flags);

  for (const candidate of candidates) {
    if (candidate?.action !== ACTIONS.BUY) {
      output.push(candidate);
      continue;
    }

    const rawConfidence = Number(candidate?.confidence || 0);
    if (openPositionSymbols.has(normalizeSymbol(candidate?.symbol))) {
      blocked++;
      const meta = {
        triggerType: resolveTriggerType(candidate),
        state: shouldMutate ? 'blocked' : 'observed',
        reason: 'open_position_reentry_guard',
        mode: flags.mode,
      };
      if (!shouldMutate) observed++;
      output.push(shouldMutate ? {
        ...candidate,
        action: ACTIONS.HOLD,
        amount_usdt: 0,
        reasoning: `entry_trigger_blocked: open_position_reentry_guard | ${candidate.reasoning || ''}`.slice(0, 220),
        block_meta: {
          ...(candidate.block_meta || {}),
          event_type: 'entry_trigger_blocked',
          entryTrigger: meta,
        },
      } : annotateEntryTrigger(candidate, meta));
      continue;
    }
    const market = String(candidate?.market || context?.market || (exchange === 'kis' ? 'domestic' : exchange === 'kis_overseas' ? 'overseas' : 'crypto'));
    const regime = String(candidate?.regime || candidate?.market_regime || context?.regime || '').trim();
    const reflexionGuard = await checkAvoidPatterns(
      String(candidate?.symbol || ''),
      market,
      'long',
      regime,
    ).catch(() => ({ matched: false, penalty: 0, reason: '' }));
    const reflexionMatched = reflexionGuard?.matched === true && Number(reflexionGuard?.penalty || 0) > 0;
    const reflexionMatchMeta = reflexionMatched ? {
      matched: true,
      penalty: Number(reflexionGuard?.penalty || 0),
      reason: reflexionGuard?.reason || 'reflexion_match',
      source: 'reflexion-engine',
    } : null;
    const confidence = Math.max(0, rawConfidence - Number(reflexionGuard?.penalty || 0));
    const triggerType = resolveTriggerType(candidate);
    if (!isAllowedTriggerType(triggerType, flags)) {
      recordGuardEvent({
        guardName: 'trigger_type_disabled_notify',
        symbol: candidate.symbol || null,
        exchange,
        reason: 'trigger_type_disabled',
        severity: 'info',
        decisionBefore: { action: ACTIONS.BUY, triggerType },
        decisionAfter: { action: LUNA_FULL_DATA_LOOP ? ACTIONS.BUY : ACTIONS.HOLD, notifyMode: LUNA_FULL_DATA_LOOP },
        guardMetadata: { triggerType, fullDataLoopEnabled: LUNA_FULL_DATA_LOOP },
      });
      if (!LUNA_FULL_DATA_LOOP) {
        blocked++;
        const meta = {
          triggerType,
          state: shouldMutate ? 'blocked' : 'observed',
          reason: 'trigger_type_disabled',
          mode: flags.mode,
        };
        output.push(shouldMutate ? {
          ...candidate,
          action: ACTIONS.HOLD,
          amount_usdt: 0,
          reasoning: `entry_trigger_blocked: trigger_type_disabled(${triggerType}) | ${candidate.reasoning || ''}`.slice(0, 220),
          block_meta: {
            ...(candidate.block_meta || {}),
            event_type: 'entry_trigger_blocked',
            entryTrigger: meta,
          },
        } : annotateEntryTrigger(candidate, meta));
        continue;
      }
    }
    const key = `${candidate.symbol}:${triggerType}`;
    const existingTrigger = activeMap.get(key) || null;
    const predictiveObservation = isPredictiveObservationCandidate(candidate);
    const fireReadiness = buildEntryTriggerFireReadiness(candidate, context);
    const fireNow = predictiveObservation || fireReadiness.ok;
    const strategyRoute = resolveCandidateStrategyRoute(candidate);
    const strategyQuality = resolveCandidateStrategyQuality(candidate, strategyRoute);
    const strategyReadiness = resolveCandidateStrategyReadiness(candidate, strategyRoute);
    const baseMeta = {
      setupType: candidate?.setup_type || strategyRoute?.setupType || null,
      confidence,
      source: 'entry_trigger_engine',
      evaluatedAt: nowIso(),
      hints: candidate?.triggerHints || {},
      strategyRoute,
      strategyQuality,
      strategyReadiness,
    };

    const tpSlEnforcement = enforceTpSlRequirement(resolveCandidateTpSlInput(candidate, context, market));
    const candidateWithTpSl = applyComputedTpSl(candidate, tpSlEnforcement);
    if (!tpSlEnforcement.allowed) {
      blocked++;
      const tpSlMeta = {
        triggerType,
        state: shouldMutate ? 'blocked' : 'observed',
        reason: 'tp_sl_required_not_met',
        blockReason: tpSlEnforcement.blockReason,
        mode: flags.mode,
      };
      if (!shouldMutate) {
        observed++;
        output.push(annotateEntryTrigger(candidateWithTpSl, tpSlMeta));
        continue;
      }
      output.push({
        ...candidateWithTpSl,
        action: ACTIONS.HOLD,
        amount_usdt: 0,
        reasoning: `entry_trigger_blocked: ${tpSlEnforcement.blockReason || 'tp_sl_required_not_met'} | ${candidate.reasoning || ''}`.slice(0, 220),
        block_meta: {
          ...(candidateWithTpSl.block_meta || {}),
          event_type: 'entry_trigger_blocked',
          entryTrigger: tpSlMeta,
        },
      });
      continue;
    }

    const constitutionAudit = constitutionalEnabled
      ? evaluateLunaConstitutionForEntry(candidateWithTpSl, { ...context, market, exchange })
      : { blocked: false, violations: [], violationCount: 0 };
    const constitutionBlocked = candidateWithTpSl?.block_meta?.constitution?.blocked === true
      || (constitutionAudit?.blocked === true && posttradeCfg?.constitutional_feedback?.hard_gate === true);
    const candidateWithConstitution = constitutionalEnabled ? {
      ...candidateWithTpSl,
      block_meta: {
        ...(candidateWithTpSl.block_meta || {}),
        constitution: {
          ...(candidateWithTpSl.block_meta?.constitution || {}),
          ok: constitutionAudit.ok,
          blocked: constitutionBlocked,
          violations: constitutionAudit.violations || [],
          violationCount: constitutionAudit.violationCount || 0,
          hardGate: posttradeCfg?.constitutional_feedback?.hard_gate === true,
        },
      },
    } : candidateWithTpSl;

    if (constitutionalEnabled && constitutionBlocked) {
      recordGuardEvent({
        guardName: 'constitution_blocked_notify',
        symbol: candidate.symbol || null,
        exchange,
        reason: 'constitution_blocked',
        severity: 'warning',
        decisionBefore: { action: ACTIONS.BUY, triggerType },
        decisionAfter: { action: LUNA_FULL_DATA_LOOP ? ACTIONS.BUY : ACTIONS.HOLD, notifyMode: LUNA_FULL_DATA_LOOP },
        guardMetadata: { violations: constitutionAudit?.violations || [], confidence, fullDataLoopEnabled: LUNA_FULL_DATA_LOOP },
      });
      if (!LUNA_FULL_DATA_LOOP) {
        blocked++;
        const constitutionMeta = {
          triggerType,
          state: shouldMutate ? 'blocked' : 'observed',
          reason: 'constitution_blocked',
          confidence,
          mode: flags.mode,
          violations: constitutionAudit?.violations || candidate?.block_meta?.constitution?.violations || [],
        };
        output.push(shouldMutate ? {
          ...candidateWithConstitution,
          action: ACTIONS.HOLD,
          amount_usdt: 0,
          reasoning: `entry_trigger_blocked: constitution_blocked | ${candidate.reasoning || ''}`.slice(0, 220),
          block_meta: {
            ...(candidateWithConstitution.block_meta || {}),
            event_type: 'entry_trigger_blocked',
            entryTrigger: constitutionMeta,
          },
        } : annotateEntryTrigger(candidateWithConstitution, constitutionMeta));
        continue;
      }
    }
    const activeCandidate = candidateWithConstitution;
    const matureHold = await isMaturePosition(String(activeCandidate?.symbol || ''), exchange).catch(() => false);
    if (matureHold) {
      recordGuardEvent({
        guardName: 'mature_position_hold_notify',
        symbol: activeCandidate.symbol || null,
        exchange,
        reason: 'mature_position_hold',
        severity: 'info',
        decisionBefore: { action: ACTIONS.BUY, triggerType },
        decisionAfter: { action: LUNA_FULL_DATA_LOOP ? ACTIONS.BUY : ACTIONS.HOLD, notifyMode: LUNA_FULL_DATA_LOOP },
        guardMetadata: { fullDataLoopEnabled: LUNA_FULL_DATA_LOOP },
      });
      if (!LUNA_FULL_DATA_LOOP) {
        blocked++;
        const matureMeta = {
          triggerType,
          state: shouldMutate ? 'blocked' : 'observed',
          reason: 'mature_position_hold',
          mode: flags.mode,
        };
        if (!shouldMutate) {
          observed++;
          output.push(annotateEntryTrigger(activeCandidate, matureMeta));
          continue;
        }
        output.push({
          ...activeCandidate,
          action: ACTIONS.HOLD,
          amount_usdt: 0,
          reasoning: `entry_trigger_blocked: mature_position_hold | ${candidate.reasoning || ''}`.slice(0, 220),
          block_meta: {
            ...(activeCandidate.block_meta || {}),
            event_type: 'entry_trigger_blocked',
            entryTrigger: matureMeta,
          },
        });
        continue;
      }
    }

    if (confidence < minConfidence && !predictiveObservation) {
      recordGuardEvent({
        guardName: 'low_confidence_notify',
        symbol: activeCandidate.symbol || null,
        exchange,
        reason: 'low_confidence',
        severity: 'info',
        decisionBefore: { action: ACTIONS.BUY, triggerType },
        decisionAfter: { action: LUNA_FULL_DATA_LOOP ? ACTIONS.BUY : ACTIONS.HOLD, notifyMode: LUNA_FULL_DATA_LOOP },
        guardMetadata: { confidence, minConfidence, fullDataLoopEnabled: LUNA_FULL_DATA_LOOP, ...(reflexionMatchMeta ? { reflexion_match: reflexionMatchMeta } : {}) },
      });
      if (!LUNA_FULL_DATA_LOOP) {
        blocked++;
        if (!shouldMutate) {
          observed++;
          output.push(annotateEntryTrigger(activeCandidate, {
            triggerType,
            state: 'observed',
            reason: 'low_confidence',
            confidence,
            minConfidence,
            mode: flags.mode,
          }));
          continue;
        }
        const blockedDecision = {
          ...activeCandidate,
          action: ACTIONS.HOLD,
          amount_usdt: 0,
          reasoning: `entry_trigger_blocked: confidence ${confidence.toFixed(2)} < ${minConfidence.toFixed(2)} | ${candidate.reasoning || ''}`.slice(0, 220),
          block_meta: {
            ...(activeCandidate.block_meta || {}),
            ...(reflexionMatchMeta ? { reflexion_match: reflexionMatchMeta } : {}),
            event_type: 'entry_trigger_blocked',
            entryTrigger: {
              triggerType,
              state: 'blocked',
              reason: 'low_confidence',
              confidence,
              minConfidence,
              ...(reflexionMatchMeta ? { reflexion_match: reflexionMatchMeta } : {}),
            },
          },
        };
        output.push(blockedDecision);
        continue;
      }
    }

    if (reflexionMatched && !shouldMutate) {
      recordGuardEvent({
        guardName: 'reflexion_penalty_applied_notify',
        symbol: activeCandidate.symbol || null,
        exchange,
        reason: reflexionGuard?.reason || 'reflexion_match',
        severity: 'info',
        decisionBefore: { action: ACTIONS.BUY, triggerType },
        decisionAfter: { action: LUNA_FULL_DATA_LOOP ? ACTIONS.BUY : 'SKIP', notifyMode: LUNA_FULL_DATA_LOOP },
        guardMetadata: { confidenceBefore: rawConfidence, confidenceAfter: confidence, reflexionMatchMeta, fullDataLoopEnabled: LUNA_FULL_DATA_LOOP },
      });
      if (!LUNA_FULL_DATA_LOOP) {
        observed++;
        output.push(annotateEntryTrigger(activeCandidate, {
          triggerType,
          state: 'observed',
          reason: 'reflexion_penalty_applied',
          confidenceBefore: rawConfidence,
          confidenceAfter: confidence,
          reflexionReason: reflexionGuard?.reason || '',
          reflexion_match: reflexionMatchMeta,
        }));
        continue;
      }
    }

    const persisted = await insertEntryTrigger({
      symbol: activeCandidate.symbol,
      exchange,
      setupType: activeCandidate?.setup_type || activeCandidate?.strategy_route?.setupType || null,
      triggerType,
      triggerState: 'armed',
      confidence,
      waitingFor: triggerType,
      targetPrice: Number(activeCandidate?.target_price || activeCandidate?.entry_price || 0) || null,
      stopLoss: Number(activeCandidate?.sl_price || activeCandidate?.stop_loss || 0) || null,
      takeProfit: Number(activeCandidate?.tp_price || activeCandidate?.take_profit || 0) || null,
      triggerContext: baseMeta,
      triggerMeta: { phase: 'F-1', mode: flags.mode },
      predictiveScore: Number(candidate?.predictiveScore || 0) || null,
      expiresAt: plusMinutes(ttlMinutes),
    }).catch(() => null);

    if (!persisted) {
      blocked++;
      if (!shouldMutate) {
        observed++;
      output.push(annotateEntryTrigger(activeCandidate, {
          triggerType,
          state: 'observed',
          reason: 'persist_failed',
          mode: flags.mode,
        }));
        continue;
      }
      output.push({
        ...activeCandidate,
        action: ACTIONS.HOLD,
        amount_usdt: 0,
        reasoning: `entry_trigger_blocked: persist_failed | ${candidate.reasoning || ''}`.slice(0, 220),
        block_meta: {
          ...(activeCandidate.block_meta || {}),
          event_type: 'entry_trigger_blocked',
          entryTrigger: { triggerType, state: 'blocked', reason: 'persist_failed' },
        },
      });
      continue;
    }

    armed++;
    if (!fireNow) {
      if (!shouldMutate) {
        observed++;
        output.push(annotateEntryTrigger(activeCandidate, {
          triggerId: persisted.id,
          triggerType,
          state: 'armed',
          expiresAt: persisted.expires_at || null,
          observedOnly: true,
          mode: flags.mode,
        }));
        continue;
      }
      output.push({
        ...activeCandidate,
        action: ACTIONS.HOLD,
        amount_usdt: 0,
        reasoning: `entry_trigger_armed(${triggerType}) 대기 | ${candidate.reasoning || ''}`.slice(0, 220),
        block_meta: {
          ...(activeCandidate.block_meta || {}),
          event_type: 'entry_trigger_blocked',
          entryTrigger: {
            triggerId: persisted.id,
            triggerType,
            state: 'armed',
            expiresAt: persisted.expires_at || null,
          },
        },
      });
      continue;
    }

    if (!allowLiveFire) {
      blocked++;
      if (!shouldMutate) {
        observed++;
        output.push(annotateEntryTrigger(activeCandidate, {
          triggerId: persisted.id,
          triggerType,
          state: 'ready',
          reason: 'mode_observe_only',
          observedOnly: true,
          mode: flags.mode,
        }));
        continue;
      }
      output.push({
        ...activeCandidate,
        action: ACTIONS.HOLD,
        amount_usdt: 0,
        reasoning: `entry_trigger_ready_but_mode_blocked(${flags.mode}) | ${activeCandidate.reasoning || ''}`.slice(0, 220),
        block_meta: {
          ...(activeCandidate.block_meta || {}),
          event_type: 'entry_trigger_blocked',
          entryTrigger: {
            triggerId: persisted.id,
            triggerType,
            state: 'blocked',
            reason: 'mode_blocked',
            mode: flags.mode,
          },
        },
      });
      continue;
    }

    const tradingViewGuard = await evaluateTradingViewEntryGuard({ candidate: activeCandidate, exchange }).catch((error) => ({
      ok: false,
      blocked: true,
      enabled: true,
      reason: 'tradingview_guard_error',
      error: error?.message || String(error),
    }));
    // notify mode: tradingview 게이트 → 알림 기록 후 계속 진행 (HARD block X)
    if (tradingViewGuard?.blocked) {
      recordGuardEvent({
        guardName: 'tradingview_chart_entry_guard',
        symbol: activeCandidate.symbol || null,
        exchange,
        reason: tradingViewGuard.reason || 'tradingview_chart_blocked',
        severity: 'warning',
        decisionBefore: { action: ACTIONS.BUY, triggerType, triggerId: persisted.id },
        decisionAfter: { action: ACTIONS.BUY, notifyMode: true },
        guardMetadata: { tradingViewReason: tradingViewGuard.reason, tradingViewGuard },
      });
      await updateEntryTriggerState(persisted.id, {
        triggerMetaPatch: {
          tradingViewReason: tradingViewGuard.reason || null,
          tradingViewGuardNotify: true,
        },
      }).catch(() => {});
    }

    const technicalChangeGate = evaluateTechnicalEntryChangeGate({
      candidate: activeCandidate,
      chartGuard: tradingViewGuard,
      context,
      fireReadiness,
    });
    // notify mode: technical change 게이트 → 알림 기록 후 계속 진행
    if (!technicalChangeGate.ok) {
      recordGuardEvent({
        guardName: 'technical_change_entry_gate',
        symbol: activeCandidate.symbol || null,
        exchange,
        reason: technicalChangeGate.reason || 'technical_change_gate_blocked',
        severity: 'warning',
        decisionBefore: { action: ACTIONS.BUY, triggerType, triggerId: persisted.id },
        decisionAfter: { action: ACTIONS.BUY, notifyMode: true },
        guardMetadata: { technicalChangeReason: technicalChangeGate.reason, blockers: technicalChangeGate.blockers },
      });
      await updateEntryTriggerState(persisted.id, {
        triggerMetaPatch: {
          technicalChangeReason: technicalChangeGate.reason,
          technicalChangeGateNotify: true,
        },
      }).catch(() => {});
    }

    const riskGate = evaluateEntryTriggerLiveRiskGate({ candidate: activeCandidate, trigger: persisted, context, flags });
    if (!riskGate.ok && isEntryTriggerRiskGateHardBlock(riskGate.reason)) {
      const hardBlockReason = resolveEntryTriggerRiskGateBlockReason(riskGate.reason);
      const hardBlockLabel = CAPITAL_HARD_BLOCKS.has(String(riskGate.reason || '')) ? 'capital' : 'predictive';
      blocked++;
      await updateEntryTriggerState(persisted.id, {
        triggerState: 'waiting',
        triggerMetaPatch: {
          reason: hardBlockReason,
          riskGateReason: riskGate.reason,
          riskGateDetails: riskGate.details || {},
        },
      }).catch(() => {});
      output.push({
        ...activeCandidate,
        action: ACTIONS.HOLD,
        amount_usdt: 0,
        reasoning: `entry_trigger_blocked(${hardBlockLabel}): ${riskGate.reason} | ${candidate.reasoning || ''}`.slice(0, 220),
        block_meta: {
          ...(activeCandidate.block_meta || {}),
          event_type: 'entry_trigger_blocked',
          entryTrigger: {
            triggerId: persisted.id,
            triggerType,
            state: 'waiting',
            reason: hardBlockReason,
            riskGateReason: riskGate.reason,
          },
        },
      });
      continue;
    }
    // notify mode: 자금 외 live risk gate → 알림 기록 후 계속 진행
    if (!riskGate.ok) {
      recordGuardEvent({
        guardName: 'live_risk_gate_notify',
        symbol: activeCandidate.symbol || null,
        exchange,
        reason: riskGate.reason || 'live_risk_gate_blocked',
        severity: 'warning',
        decisionBefore: { action: ACTIONS.BUY, triggerType, triggerId: persisted.id },
        decisionAfter: { action: ACTIONS.BUY, notifyMode: true },
        guardMetadata: { riskGateReason: riskGate.reason, riskGateDetails: riskGate.details || {} },
      });
    }

    const recentFired = await getRecentFiredEntryTrigger({
      symbol: candidate.symbol,
      exchange,
      triggerType,
      minutes: fireCooldownMinutes,
    }).catch(() => null);
    if (recentFired) {
      blocked++;
      await updateEntryTriggerState(persisted.id, {
        triggerState: 'waiting',
        triggerMetaPatch: {
          duplicateFireCooldownMinutes: fireCooldownMinutes,
          recentFiredTriggerId: recentFired.id,
          reason: 'duplicate_fire_cooldown',
        },
      }).catch(() => {});
      output.push({
        ...activeCandidate,
        action: ACTIONS.HOLD,
        amount_usdt: 0,
        reasoning: `entry_trigger_blocked: duplicate_fire_cooldown(${fireCooldownMinutes}m) | ${candidate.reasoning || ''}`.slice(0, 220),
        block_meta: {
          ...(activeCandidate.block_meta || {}),
          event_type: 'entry_trigger_blocked',
          entryTrigger: {
            triggerId: persisted.id,
            triggerType,
            state: 'waiting',
            reason: 'duplicate_fire_cooldown',
            recentFiredTriggerId: recentFired.id,
            cooldownMinutes: fireCooldownMinutes,
          },
        },
      });
      continue;
    }

    if (predictiveObservation && predictiveObservationFired >= predictiveObservationMaxPerCycle) {
      blocked++;
      await updateEntryTriggerState(persisted.id, {
        triggerState: 'waiting',
        triggerMetaPatch: {
          reason: 'predictive_observation_cycle_cap',
          maxPerCycle: predictiveObservationMaxPerCycle,
        },
      }).catch(() => {});
      output.push({
        ...activeCandidate,
        action: ACTIONS.HOLD,
        amount_usdt: 0,
        reasoning: `entry_trigger_blocked: predictive_observation_cycle_cap(${predictiveObservationMaxPerCycle}) | ${candidate.reasoning || ''}`.slice(0, 220),
        block_meta: {
          ...(activeCandidate.block_meta || {}),
          event_type: 'entry_trigger_blocked',
          entryTrigger: {
            triggerId: persisted.id,
            triggerType,
            state: 'waiting',
            reason: 'predictive_observation_cycle_cap',
            maxPerCycle: predictiveObservationMaxPerCycle,
          },
        },
      });
      continue;
    }

    fired++;
    if (predictiveObservation) predictiveObservationFired++;
    await updateEntryTriggerState(persisted.id, {
      triggerState: 'fired',
      firedAt: nowIso(),
      triggerMetaPatch: {
        reason: 'entry_trigger_fired',
        firedBy: 'entry_trigger_engine',
        eventType: 'entry_trigger_fired',
        tradingViewReason: tradingViewGuard.reason || null,
        tradingViewGuard: summarizeEntryChartGuard(tradingViewGuard),
        technicalChangeReason: technicalChangeGate.reason || null,
        technicalChangeGate,
        riskGateReason: riskGate.reason || null,
        riskGateDetails: riskGate.details || {},
      },
    }).catch(() => {});

    output.push({
      ...activeCandidate,
      block_meta: {
        ...(activeCandidate.block_meta || {}),
        event_type: 'autonomous_action_executed',
        entryTrigger: {
          triggerId: persisted.id,
          triggerType,
          state: 'fired',
          firedAt: nowIso(),
        },
      },
    });
  }

  return {
    decisions: output,
    stats: {
      enabled: true,
      armed,
      fired,
      blocked,
      observed,
      allowLiveFire,
      shouldMutate,
      mode: flags.mode,
      predictiveObservationFired,
      predictiveObservationMaxPerCycle,
    },
  };
}

export async function refreshEntryTriggersFromRecentBuySignals({
  exchange = 'binance',
  hours = 6,
  limit = 25,
  context = {},
} = {}) {
  const flags = getLunaIntelligentDiscoveryFlags();
  if (!flags.phases.entryTriggerEnabled) {
    return { enabled: false, refreshed: 0, armed: 0, fired: 0, blocked: 0, sourceSignals: 0 };
  }
  const refreshEnabled = String(process.env.LUNA_ENTRY_TRIGGER_SIGNAL_REFRESH_ENABLED ?? 'true').trim().toLowerCase() !== 'false';
  if (!refreshEnabled) {
    return { enabled: true, refreshEnabled: false, refreshed: 0, armed: 0, fired: 0, blocked: 0, sourceSignals: 0 };
  }
  await ensureLunaDiscoveryEntryTables();
  const minConfidence = Number(flags.entryTrigger.minConfidence || 0.48);
  const rows = await dbQuery(
    `SELECT id, symbol, action, amount_usdt, confidence, reasoning, status, exchange,
            strategy_family, strategy_quality, strategy_readiness, strategy_route, block_meta, created_at
       FROM signals
      WHERE exchange = $1
        AND action = 'BUY'
        AND created_at >= now() - ($2::int * INTERVAL '1 hour')
        AND COALESCE(exclude_from_learning, false) = false
        AND COALESCE(quality_flag, 'trusted') <> 'exclude_from_learning'
        AND COALESCE(execution_origin, 'strategy') NOT IN ('smoke', 'test', 'fixture')
        AND COALESCE(status, 'pending') IN ('pending', 'approved', 'queued', 'retrying')
        AND COALESCE(confidence, 0) >= $3
      ORDER BY confidence DESC NULLS LAST, created_at DESC
      LIMIT $4`,
    [
      exchange,
      Math.max(1, Number(hours || 6)),
      minConfidence,
      Math.max(1, Number(limit || 25)),
    ],
  ).catch(() => []);

  const candidates = rows.map(signalRowToEntryCandidate).filter((item) => item.symbol);
  if (candidates.length === 0) {
    return { enabled: true, refreshEnabled: true, refreshed: 0, armed: 0, fired: 0, blocked: 0, sourceSignals: 0 };
  }
  const result = await evaluateEntryTriggers(candidates, {
    ...context,
    exchange,
    signalRefresh: true,
  });
  return {
    enabled: true,
    refreshEnabled: true,
    refreshed: Number(result?.stats?.armed || 0),
    armed: Number(result?.stats?.armed || 0),
    fired: Number(result?.stats?.fired || 0),
    blocked: Number(result?.stats?.blocked || 0),
    observed: Number(result?.stats?.observed || 0),
    sourceSignals: candidates.length,
    mode: result?.stats?.mode || flags.mode,
  };
}

export async function evaluateActiveEntryTriggersAgainstMarketEvents(events = [], context = {}) {
  const flags = getLunaIntelligentDiscoveryFlags();
  if (!flags.phases.entryTriggerEnabled) {
    return { enabled: false, fired: 0, readyBlocked: 0, checked: 0, results: [] };
  }
  await ensureLunaDiscoveryEntryTables();
  const dryRun = context.dryRun === true;
  const updateTriggerState = (id, patch) => dryRun ? Promise.resolve(null) : updateEntryTriggerState(id, patch);
  if (!dryRun) await expireEntryTriggers().catch(() => 0);

  const exchange = String(context.exchange || 'binance');
  const openPositionSymbols = await loadOpenEntryPositionSymbols(exchange, context);
  if (!dryRun) await expireOpenPositionEntryTriggers(exchange, openPositionSymbols);
  const allowLiveFire = flags.shouldAllowLiveEntryFire();
  const fireCooldownMinutes = Number(flags.entryTrigger.fireCooldownMinutes || 10);
  const binanceTopVolumeUniverse = exchange === 'binance'
    ? context.binanceTopVolumeUniverse || await getCachedBinanceTopVolumeUniverse().catch((error) => ({
      source: 'binance_top30_unavailable',
      limit: 30,
      symbols: [],
      ranks: {},
      error: String(error?.message || error),
    }))
    : null;
  const eventsBySymbol = new Map();
  for (const event of events || []) {
    const symbol = normalizeSymbol(event?.symbol || '');
    if (!symbol) continue;
    eventsBySymbol.set(symbol, event);
  }

  const active = await listActiveEntryTriggers({ exchange, limit: Number(context.limit || 1000) }).catch(() => []);
  const activeQualityGateEnabled = boolConfig(
    context?.activeQualityGateEnabled ?? process.env.LUNA_ENTRY_TRIGGER_ACTIVE_QUALITY_GATE_ENABLED,
    true,
  );
  const expireQualityBlockedActive = activeQualityGateEnabled && shouldExpireQualityBlockedActiveTriggers(context);
  const providedQualityBySymbol = normalizeQualityMap(context.activeQualityBySymbol || context.activeQualityMap);
  let activeQualityBySymbol = new Map(providedQualityBySymbol);
  if (activeQualityGateEnabled && context.skipActiveQualityLoad !== true) {
    const qualitySymbols = [...new Set((active || [])
      .map((trigger) => normalizeSymbol(trigger.symbol))
      .filter((symbol) => symbol && (expireQualityBlockedActive || eventsBySymbol.has(symbol))))];
    const loadedQualityBySymbol = context.loadActiveTriggerQuality
      ? await context.loadActiveTriggerQuality(qualitySymbols, { exchange, market: normalizeEntryTriggerMarket(exchange), context }).catch(() => new Map())
      : await loadActiveEntryTriggerQuality(qualitySymbols, { exchange, market: normalizeEntryTriggerMarket(exchange) }).catch(() => new Map());
    activeQualityBySymbol = new Map([
      ...normalizeQualityMap(loadedQualityBySymbol),
      ...providedQualityBySymbol,
    ]);
  }
  const results = [];
  let fired = 0;
  let readyBlocked = 0;
  let checked = 0;
  let qualityExpired = 0;
  const reportMissingMarketEvents = context.reportMissingMarketEvents === true;

  for (const trigger of active || []) {
    if (openPositionSymbols.has(normalizeSymbol(trigger.symbol))) {
      results.push({ triggerId: trigger.id, symbol: trigger.symbol, state: 'expired', fired: false, reason: 'open_position_reentry_guard' });
      continue;
    }
    const triggerQuality = activeQualityBySymbol.get(normalizeSymbol(trigger.symbol));
    const preflightQualityGate = activeQualityGateEnabled
      ? evaluateActiveEntryTriggerQualityGate(trigger, triggerQuality, context)
      : null;
    if (preflightQualityGate?.notifyMode && preflightQualityGate.blockedReasons?.length > 0) {
      recordGuardEvent({
        guardName: 'active_quality_gate_notify',
        symbol: trigger.symbol || null,
        exchange,
        reason: preflightQualityGate.blockedReasons.join(','),
        severity: 'info',
        decisionBefore: { wouldBlock: true, reasons: preflightQualityGate.blockedReasons },
        decisionAfter: preflightQualityGate.hardBlock
          ? { notifyMode: true, hardBlock: true, action: 'BUY_BLOCKED' }
          : { notifyMode: true, action: 'BUY_ALLOWED' },
        guardMetadata: { activeQualityGate: preflightQualityGate },
      });
    }
    if (
      expireQualityBlockedActive
      && preflightQualityGate
      && !preflightQualityGate.ok
      && isTerminalActiveEntryTriggerQualityGateBlock(preflightQualityGate)
    ) {
      checked++;
      readyBlocked++;
      qualityExpired++;
      await updateTriggerState(trigger.id, {
        triggerState: 'expired',
        triggerMetaPatch: {
          lastReadyAt: nowIso(),
          reason: 'active_entry_trigger_quality_terminal_blocked',
          activeQualityGate: preflightQualityGate,
          riskGateReason: null,
          riskGateDetails: null,
          tradingViewReason: null,
          tradingViewGuard: null,
          readyBlockedByMode: null,
          duplicateFireCooldownMinutes: null,
          recentFiredTriggerId: null,
          terminalBlock: true,
          terminalBlockedAt: nowIso(),
        },
      }).catch(() => null);
      results.push({
        triggerId: trigger.id,
        symbol: trigger.symbol,
        state: 'expired',
        fired: false,
        reason: 'active_entry_trigger_quality_terminal_blocked',
        qualityGateReason: preflightQualityGate.reason,
        qualityGate: preflightQualityGate,
        terminalBlock: true,
      });
      continue;
    }
    const event = eventsBySymbol.get(normalizeSymbol(trigger.symbol || ''));
    if (!event) {
      if (!reportMissingMarketEvents) continue;
      checked++;
      const predictiveScore = resolveActiveEntryTriggerPredictiveScore(trigger, triggerQuality);
      const missingEventReadiness = {
        triggerType: trigger.trigger_type || null,
        setupType: trigger.setup_type || null,
        confidence: Number(trigger.confidence || 0),
        predictiveScore: predictiveScore == null ? 0 : predictiveScore,
        discoveryScore: Number(trigger.trigger_context?.hints?.discoveryScore || 0),
        mtfAgreement: 0,
        mtfAlignmentScore: null,
        mtfDominantSignal: null,
        mtfBullish: false,
        volumeBurst: 0,
        breakoutRetest: false,
        newsMomentum: Number(trigger.trigger_context?.hints?.newsMomentum || 0),
        technicalTelemetry: {
          mtfAvailable: false,
          volumeAvailable: false,
          missing: true,
          source: 'entry_trigger_market_event_missing',
          exchange,
        },
      };
      await updateTriggerState(trigger.id, {
        triggerState: 'waiting',
        triggerMetaPatch: {
          reason: 'market_event_missing',
          fireReason: 'market_event_missing',
          fireReadiness: missingEventReadiness,
          lastCheckedAt: nowIso(),
        },
      }).catch(() => null);
      results.push({
        triggerId: trigger.id,
        symbol: trigger.symbol,
        state: 'waiting',
        fired: false,
        reason: 'market_event_missing',
        fireReason: 'market_event_missing',
        fireReadiness: missingEventReadiness,
      });
      continue;
    }
    checked++;
    if (exchange === 'binance') {
      const top30Gate = evaluateBinanceTopVolumeUniverseGate(trigger.symbol, binanceTopVolumeUniverse);
      if (top30Gate.blocked) {
        readyBlocked++;
        await updateTriggerState(trigger.id, {
          triggerState: 'waiting',
          triggerMetaPatch: {
            lastReadyAt: nowIso(),
            reason: BINANCE_TOP_VOLUME_BLOCK_REASON,
            binanceTop30Gate: top30Gate,
          },
        }).catch(() => null);
        results.push({
          triggerId: trigger.id,
          symbol: trigger.symbol,
          state: 'waiting',
          fired: false,
          reason: BINANCE_TOP_VOLUME_BLOCK_REASON,
          binanceTop30Rank: top30Gate.rank,
        });
        continue;
      }
    }
    const predictiveScore = resolveActiveEntryTriggerPredictiveScore(trigger, triggerQuality);
    const candidate = {
      symbol: trigger.symbol,
      action: ACTIONS.BUY,
      confidence: Number(trigger.confidence || 0),
      setup_type: trigger.setup_type || null,
      triggerType: trigger.trigger_type || null,
      predictiveScore,
      prediction: predictiveScore != null ? {
        score: predictiveScore,
        source: trigger.predictive_score != null ? 'entry_trigger' : 'active_quality_gate',
      } : undefined,
      analystAccuracy: Number(trigger.confidence || 0),
      setupOutcome: trigger.trigger_context?.setupOutcome || trigger.trigger_meta?.setupOutcome || undefined,
      triggerHints: {
        ...(trigger.trigger_context?.hints || {}),
        ...(event.triggerHints || {}),
        mtfAgreement: event.mtfAgreement ?? event.triggerHints?.mtfAgreement ?? trigger.trigger_context?.hints?.mtfAgreement,
        mtfAlignmentScore: event.mtfAlignmentScore ?? event.alignmentScore ?? event.triggerHints?.mtfAlignmentScore ?? trigger.trigger_context?.hints?.mtfAlignmentScore,
        mtfDominantSignal: event.mtfDominantSignal ?? event.dominantSignal ?? event.triggerHints?.mtfDominantSignal ?? trigger.trigger_context?.hints?.mtfDominantSignal,
        discoveryScore: event.discoveryScore ?? event.triggerHints?.discoveryScore ?? trigger.trigger_context?.hints?.discoveryScore,
        volumeBurst: event.volumeBurst ?? event.triggerHints?.volumeBurst ?? trigger.trigger_context?.hints?.volumeBurst,
        breakoutRetest: event.breakoutRetest ?? event.triggerHints?.breakoutRetest ?? trigger.trigger_context?.hints?.breakoutRetest,
        newsMomentum: event.newsMomentum ?? event.triggerHints?.newsMomentum ?? trigger.trigger_context?.hints?.newsMomentum,
      },
    };
    const fireReadiness = buildEntryTriggerFireReadiness(candidate, context);
    const effectiveCandidate = applyEntryTriggerEffectiveScores(candidate, fireReadiness);
    const fireNow = fireReadiness.ok;
    if (!fireNow) {
      await updateTriggerState(trigger.id, {
        triggerState: 'waiting',
        triggerMetaPatch: {
          reason: 'conditions_not_met',
          fireReason: fireReadiness.reason,
          fireReadiness: fireReadiness.details,
          riskGateReason: null,
          riskGateDetails: null,
          tradingViewReason: null,
          tradingViewGuard: null,
          readyBlockedByMode: null,
          duplicateFireCooldownMinutes: null,
          recentFiredTriggerId: null,
          terminalBlock: false,
          terminalBlockedAt: null,
          lastCheckedAt: nowIso(),
        },
      }).catch(() => null);
      results.push({
        triggerId: trigger.id,
        symbol: trigger.symbol,
        state: 'waiting',
        fired: false,
        reason: 'conditions_not_met',
        fireReason: fireReadiness.reason,
        fireReadiness: fireReadiness.details,
      });
      continue;
    }
    const qualityGate = preflightQualityGate || evaluateActiveEntryTriggerQualityGate(trigger, triggerQuality, context);
    if (qualityGate.notifyMode && qualityGate.blockedReasons?.length > 0 && !preflightQualityGate) {
      // preflight에서 이미 기록하지 않은 경우만 (preflightQualityGate가 없을 때)
      recordGuardEvent({
        guardName: 'active_quality_gate_notify',
        symbol: trigger.symbol || null,
        exchange,
        reason: qualityGate.blockedReasons.join(','),
        severity: 'info',
        decisionBefore: { wouldBlock: true, reasons: qualityGate.blockedReasons },
        decisionAfter: qualityGate.hardBlock
          ? { notifyMode: true, hardBlock: true, action: 'BUY_BLOCKED' }
          : { notifyMode: true, action: 'BUY_ALLOWED' },
        guardMetadata: { activeQualityGate: qualityGate },
      });
    }
    if (!qualityGate.ok) {
      readyBlocked++;
      await updateTriggerState(trigger.id, {
        triggerState: 'waiting',
        triggerMetaPatch: {
          lastReadyAt: nowIso(),
          reason: 'active_entry_trigger_quality_gate_blocked',
          activeQualityGate: qualityGate,
          riskGateReason: null,
          riskGateDetails: null,
          tradingViewReason: null,
          tradingViewGuard: null,
          readyBlockedByMode: null,
          duplicateFireCooldownMinutes: null,
          recentFiredTriggerId: null,
          terminalBlock: false,
          terminalBlockedAt: null,
        },
      }).catch(() => null);
      results.push({
        triggerId: trigger.id,
        symbol: trigger.symbol,
        state: 'waiting',
        fired: false,
        reason: 'active_entry_trigger_quality_gate_blocked',
        qualityGateReason: qualityGate.reason,
        qualityGate,
      });
      continue;
    }
    if (!allowLiveFire) {
      readyBlocked++;
      await updateTriggerState(trigger.id, {
        triggerState: 'waiting',
        triggerMetaPatch: {
          lastReadyAt: nowIso(),
          readyBlockedByMode: flags.mode,
        },
      }).catch(() => null);
      results.push({ triggerId: trigger.id, symbol: trigger.symbol, state: 'waiting', fired: false, reason: 'mode_blocked', mode: flags.mode });
      continue;
    }
    const tradingViewGuard = await evaluateTradingViewEntryGuard({ candidate: effectiveCandidate, event, exchange }).catch((error) => ({
      ok: false,
      blocked: true,
      enabled: true,
      reason: 'tradingview_guard_error',
      error: error?.message || String(error),
    }));
    // notify mode: tradingview 게이트 → 알림 기록 후 계속 진행
    if (tradingViewGuard?.blocked) {
      recordGuardEvent({
        guardName: 'tradingview_chart_active_guard',
        symbol: trigger.symbol || null,
        exchange,
        reason: tradingViewGuard.reason || 'tradingview_chart_blocked',
        severity: 'warning',
        decisionBefore: { action: ACTIONS.BUY, triggerId: trigger.id, triggerType: trigger.trigger_type },
        decisionAfter: { action: ACTIONS.BUY, notifyMode: true },
        guardMetadata: { tradingViewReason: tradingViewGuard.reason, tradingViewGuard },
      });
      await updateTriggerState(trigger.id, {
        triggerMetaPatch: {
          lastReadyAt: nowIso(),
          tradingViewReason: tradingViewGuard.reason || null,
          tradingViewGuardNotify: true,
        },
      }).catch(() => null);
    }

    const technicalChangeGate = evaluateTechnicalEntryChangeGate({
      candidate: effectiveCandidate,
      event,
      chartGuard: tradingViewGuard,
      context,
      fireReadiness,
    });
    // notify mode: technical change 게이트 → 알림 기록 후 계속 진행
    if (!technicalChangeGate.ok) {
      recordGuardEvent({
        guardName: 'technical_change_active_gate',
        symbol: trigger.symbol || null,
        exchange,
        reason: technicalChangeGate.reason || 'technical_change_gate_blocked',
        severity: 'warning',
        decisionBefore: { action: ACTIONS.BUY, triggerId: trigger.id, triggerType: trigger.trigger_type },
        decisionAfter: { action: ACTIONS.BUY, notifyMode: true },
        guardMetadata: { technicalChangeReason: technicalChangeGate.reason, blockers: technicalChangeGate.blockers },
      });
      await updateTriggerState(trigger.id, {
        triggerMetaPatch: {
          lastReadyAt: nowIso(),
          technicalChangeReason: technicalChangeGate.reason,
          technicalChangeGateNotify: true,
        },
      }).catch(() => null);
    }

    const riskGate = evaluateEntryTriggerLiveRiskGate({ candidate: effectiveCandidate, trigger, context, flags });
    if (!riskGate.ok && isEntryTriggerRiskGateHardBlock(riskGate.reason)) {
      readyBlocked++;
      const terminalBlock = isTerminalEntryTriggerLiveRiskGateBlock(riskGate);
      const hardBlockReason = resolveEntryTriggerRiskGateBlockReason(riskGate.reason);
      await updateTriggerState(trigger.id, {
        triggerState: terminalBlock ? 'expired' : 'waiting',
        triggerMetaPatch: {
          reason: hardBlockReason,
          riskGateReason: riskGate.reason,
          riskGateDetails: riskGate.details || {},
          terminalBlock,
          terminalBlockedAt: terminalBlock ? nowIso() : undefined,
        },
      }).catch(() => null);
      results.push({
        triggerId: trigger.id,
        symbol: trigger.symbol,
        state: terminalBlock ? 'expired' : 'waiting',
        fired: false,
        reason: hardBlockReason,
        riskGateReason: riskGate.reason,
        terminalBlock,
      });
      continue;
    }
    if (!riskGate.ok) {
      const terminalBlock = isTerminalEntryTriggerLiveRiskGateBlock(riskGate);
      if (terminalBlock) {
        readyBlocked++;
        await updateTriggerState(trigger.id, {
          triggerState: 'expired',
          triggerMetaPatch: {
            reason: 'live_risk_gate_terminal_blocked',
            riskGateReason: riskGate.reason,
            riskGateDetails: riskGate.details || {},
            terminalBlock: true,
            terminalBlockedAt: nowIso(),
          },
        }).catch(() => null);
        results.push({
          triggerId: trigger.id,
          symbol: trigger.symbol,
          state: 'expired',
          fired: false,
          reason: 'live_risk_gate_terminal_blocked',
          riskGateReason: riskGate.reason,
          terminalBlock: true,
        });
        continue;
      }
      // notify mode: 자금 외 risk gate → 알림 기록 후 계속 진행
      recordGuardEvent({
        guardName: 'live_risk_gate_active_notify',
        symbol: trigger.symbol || null,
        exchange,
        reason: riskGate.reason || 'live_risk_gate_blocked',
        severity: 'warning',
        decisionBefore: { action: ACTIONS.BUY, triggerId: trigger.id },
        decisionAfter: { action: ACTIONS.BUY, notifyMode: true },
        guardMetadata: { riskGateReason: riskGate.reason, riskGateDetails: riskGate.details || {} },
      });
    }
    const recentFired = await getRecentFiredEntryTrigger({
      symbol: trigger.symbol,
      exchange,
      triggerType: trigger.trigger_type,
      minutes: fireCooldownMinutes,
    }).catch(() => null);
    if (recentFired && recentFired.id !== trigger.id) {
      readyBlocked++;
      await updateTriggerState(trigger.id, {
        triggerState: 'waiting',
        triggerMetaPatch: {
          duplicateFireCooldownMinutes: fireCooldownMinutes,
          recentFiredTriggerId: recentFired.id,
          reason: 'duplicate_fire_cooldown',
        },
      }).catch(() => null);
      results.push({
        triggerId: trigger.id,
        symbol: trigger.symbol,
        state: 'waiting',
        fired: false,
        reason: 'duplicate_fire_cooldown',
        recentFiredTriggerId: recentFired.id,
      });
      continue;
    }
    fired++;
    const updated = await updateTriggerState(trigger.id, {
      triggerState: 'fired',
      firedAt: nowIso(),
      triggerMetaPatch: {
        reason: 'entry_trigger_fired',
        firedBy: 'entry_trigger_event_worker',
        eventType: 'entry_trigger_fired',
        event,
        tradingViewReason: tradingViewGuard.reason || null,
        tradingViewGuard: summarizeEntryChartGuard(tradingViewGuard),
        technicalChangeReason: technicalChangeGate.reason || null,
        technicalChangeGate,
        riskGateReason: riskGate.reason || null,
        riskGateDetails: riskGate.details || {},
        fireReadiness: fireReadiness.details,
      },
    }).catch(() => null);
    results.push({ triggerId: trigger.id, symbol: trigger.symbol, state: updated?.trigger_state || 'fired', fired: true });
  }

  return {
    enabled: true,
    dryRun,
    mode: flags.mode,
    allowLiveFire,
    checked,
    fired,
    readyBlocked,
    qualityExpired,
    results,
  };
}

export default evaluateEntryTriggers;
