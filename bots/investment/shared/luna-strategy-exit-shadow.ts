// @ts-nocheck

import * as db from './db.ts';
import {
  LUNA_STRATEGY_DEFAULTS,
  LUNA_STRATEGY_SIGNAL_FAMILIES,
  dropIncompleteLastBar,
  evaluateTestahPullback,
  evaluateTurtleBreakout,
  loadStrategyFamilyParameters,
} from './luna-strategy-families.ts';
import {
  fetchPhaseABars,
  normalizePhaseAMarket,
  normalizePhaseASymbol,
} from './luna-phase-a-market-data.ts';

export const LUNA_STRATEGY_EXIT_SHADOW_ENV = 'LUNA_STRATEGY_EXIT_SHADOW';
export const LUNA_STRATEGY_EXIT_SHADOW_CONFIRM_ENV = 'LUNA_STRATEGY_EXIT_SHADOW_CONFIRM';
export const LUNA_STRATEGY_EXIT_SHADOW_CONFIRM = 'luna-strategy-exit-shadow';

function truthy(value: any) {
  if (value === true) return true;
  if (value === false || value == null) return false;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function finite(value: any, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value: any, digits = 6) {
  const n = finite(value);
  return n == null ? null : Number(n.toFixed(digits));
}

function setupTypeOf(profile: any = {}) {
  return String(profile?.setup_type || profile?.setupType || '').trim().toLowerCase();
}

export function mapSetupTypeToStrategyExitFamily(profile: any = {}) {
  const setupType = setupTypeOf(profile);
  if (setupType === 'breakout' || setupType === 'trend_following') {
    return {
      setupType,
      familyKey: 'turtle',
      family: LUNA_STRATEGY_SIGNAL_FAMILIES.turtle,
      skipped: false,
      reason: null,
    };
  }
  if (setupType === 'micro_swing') {
    return {
      setupType,
      familyKey: 'testah',
      family: LUNA_STRATEGY_SIGNAL_FAMILIES.testah,
      skipped: false,
      reason: null,
    };
  }
  return {
    setupType: setupType || null,
    familyKey: null,
    family: null,
    skipped: true,
    reason: setupType ? `unmapped_setup_type:${setupType}` : 'missing_setup_type',
  };
}

function normalizedBar(row: any = {}) {
  const timestamp = row.timestamp ?? row.candle_ts ?? row.time ?? null;
  return {
    timestamp,
    close: finite(row.close ?? row.c ?? row.price),
  };
}

function lastValidBar(bars: any[] = []) {
  const normalized = (Array.isArray(bars) ? bars : [])
    .map(normalizedBar)
    .filter((bar) => bar.timestamp != null && bar.close != null)
    .sort((a, b) => Date.parse(String(a.timestamp)) - Date.parse(String(b.timestamp)));
  return normalized[normalized.length - 1] || null;
}

export function isStrategyExitShadowEnabled(options: any = {}) {
  if (typeof options.enabled === 'boolean') return options.enabled;
  if (typeof options.strategyExitShadow === 'boolean') return options.strategyExitShadow;
  const env = { ...(process.env || {}), ...(options.env || {}) };
  return truthy(env[LUNA_STRATEGY_EXIT_SHADOW_ENV]);
}

export function canWriteStrategyExitShadow(options: any = {}) {
  if (options.persist === false || options.dryRun === true) return false;
  if (options.canWrite === true) return true;
  const env = { ...(process.env || {}), ...(options.env || {}) };
  return String(options.confirm || env[LUNA_STRATEGY_EXIT_SHADOW_CONFIRM_ENV] || '').trim() === LUNA_STRATEGY_EXIT_SHADOW_CONFIRM;
}

export function strategyExitShadowMarketForExchange(exchange: any = '') {
  const normalized = String(exchange || '').trim().toLowerCase();
  if (normalized === 'binance') return 'crypto';
  if (normalized === 'kis') return 'domestic';
  if (normalized === 'kis_overseas') return 'overseas';
  return null;
}

export function buildStrategyExitPositionId({ position = {}, strategyProfile = null, tradeMode = null } = {}) {
  const profileId = String(strategyProfile?.id || '').trim();
  if (profileId) return profileId;
  const exchange = String(position.exchange || 'unknown').trim().toLowerCase() || 'unknown';
  const symbol = String(position.symbol || 'unknown').trim().toUpperCase() || 'unknown';
  const mode = String(tradeMode || position.trade_mode || 'normal').trim() || 'normal';
  const paper = position.paper === true ? 'paper' : 'live';
  return `${exchange}:${symbol}:${mode}:${paper}`;
}

export function evaluateStrategyExitShadow({ profile = null, bars = [], params = {} } = {}) {
  const mapping = mapSetupTypeToStrategyExitFamily(profile);
  if (mapping.skipped) {
    return {
      ...mapping,
      c3Decision: null,
      c3Reason: mapping.reason,
      c3ExitPrice: null,
      candleTs: null,
      skipped: true,
    };
  }

  const effectiveParams = {
    turtle: { ...LUNA_STRATEGY_DEFAULTS.turtle, ...(params.turtle || {}) },
    testah: { ...LUNA_STRATEGY_DEFAULTS.testah, ...(params.testah || {}) },
  };
  const result = mapping.familyKey === 'turtle'
    ? evaluateTurtleBreakout(bars, { ...effectiveParams.turtle, positionOpen: true })
    : evaluateTestahPullback(bars, { ...effectiveParams.testah, positionOpen: true });

  return {
    ...mapping,
    c3Decision: result.signalType === 'exit' ? 'exit' : 'hold',
    c3Reason: result.reason || null,
    c3ExitPrice: result.signalType === 'exit' ? result.price ?? null : null,
    candleTs: result.candleTs || lastValidBar(bars)?.timestamp || null,
    rawSignal: result,
    skipped: false,
  };
}

export async function loadStrategyExitShadowParameters(options: any = {}, deps: any = {}) {
  return options.params || await (deps.loadStrategyFamilyParameters || loadStrategyFamilyParameters)(options, deps);
}

export function buildStrategyExitShadowRow({
  position = {},
  strategyProfile = null,
  tradeMode = null,
  currentDecision = {},
  evaluation = {},
  bars = [],
} = {}) {
  if (!evaluation || evaluation.skipped === true) return null;
  const lastBar = lastValidBar(bars);
  const candleTs = evaluation.candleTs || lastBar?.timestamp || null;
  if (!candleTs) return null;
  const currentRecommendation = String(currentDecision?.recommendation || 'HOLD').toUpperCase();
  const c3Decision = evaluation.c3Decision || 'hold';
  return {
    positionId: buildStrategyExitPositionId({ position, strategyProfile, tradeMode }),
    symbol: String(position.symbol || '').trim(),
    exchange: String(position.exchange || '').trim().toLowerCase(),
    family: evaluation.family,
    c3Decision,
    c3Reason: evaluation.c3Reason || null,
    currentDecision: currentRecommendation,
    currentReason: currentDecision?.reasonCode || currentDecision?.reason || null,
    agreement: (c3Decision === 'exit') === (currentRecommendation === 'EXIT'),
    candleTs,
    c3ExitPrice: evaluation.c3ExitPrice ?? null,
    lastPrice: round(lastBar?.close),
    shadowOnly: true,
  };
}

export async function upsertStrategyExitShadow(row: any = {}, runFn = db.run) {
  return runFn(
    `INSERT INTO luna_strategy_exit_shadow
       (position_id, symbol, exchange, family, c3_decision, c3_reason,
        current_decision, current_reason, agreement, candle_ts, c3_exit_price,
        last_price, evaluated_at, shadow_only)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),TRUE)
     ON CONFLICT (position_id, candle_ts) DO UPDATE SET
       symbol = EXCLUDED.symbol,
       exchange = EXCLUDED.exchange,
       family = EXCLUDED.family,
       c3_decision = EXCLUDED.c3_decision,
       c3_reason = EXCLUDED.c3_reason,
       current_decision = EXCLUDED.current_decision,
       current_reason = EXCLUDED.current_reason,
       agreement = EXCLUDED.agreement,
       c3_exit_price = EXCLUDED.c3_exit_price,
       last_price = EXCLUDED.last_price,
       evaluated_at = EXCLUDED.evaluated_at,
       shadow_only = TRUE
     RETURNING id`,
    [
      row.positionId,
      row.symbol,
      row.exchange,
      row.family,
      row.c3Decision,
      row.c3Reason,
      row.currentDecision,
      row.currentReason,
      row.agreement === true,
      row.candleTs,
      row.c3ExitPrice,
      row.lastPrice,
    ],
  );
}

export async function runStrategyExitShadowSidecar(options: any = {}, deps: any = {}) {
  const enabled = isStrategyExitShadowEnabled(options);
  if (!enabled) {
    return { ok: true, enabled: false, skipped: true, reason: 'strategy_exit_shadow_disabled', written: 0 };
  }

  const { position = {}, strategyProfile = null, currentDecision = {}, tradeMode = null } = options;
  const market = strategyExitShadowMarketForExchange(position.exchange);
  if (!market) {
    return { ok: true, enabled: true, skipped: true, reason: `unsupported_exchange:${position.exchange || 'unknown'}`, written: 0 };
  }
  if (!position.symbol) {
    return { ok: false, enabled: true, skipped: true, reason: 'missing_symbol', written: 0 };
  }
  const mapping = mapSetupTypeToStrategyExitFamily(strategyProfile);
  if (mapping.skipped === true) {
    return { ok: true, enabled: true, skipped: true, reason: mapping.reason, evaluation: mapping, written: 0 };
  }

  try {
    const params = await loadStrategyExitShadowParameters(options, deps);
    const normalizedSymbol = normalizePhaseASymbol(position.symbol, market);
    const fetchBars = deps.fetchPhaseABars || fetchPhaseABars;
    const marketData = Array.isArray(options.bars)
      ? { bars: options.bars, source: 'provided_bars', error: null }
      : await fetchBars({
          symbol: normalizedSymbol,
          market: normalizePhaseAMarket(market),
          timeframe: options.timeframe || LUNA_STRATEGY_DEFAULTS.timeframe,
          lookbackDays: options.lookbackDays || LUNA_STRATEGY_DEFAULTS.lookbackDays,
          getOhlcv: options.getOhlcv,
        });
    if (marketData.error) {
      return { ok: false, enabled: true, skipped: true, reason: 'ohlcv_fetch_failed', error: marketData.error, written: 0 };
    }

    const bars = dropIncompleteLastBar(marketData.bars || [], market, options.now || new Date());
    if (bars.length === 0) {
      return { ok: false, enabled: true, skipped: true, reason: 'no_completed_bars', written: 0 };
    }

    const evaluation = evaluateStrategyExitShadow({ profile: strategyProfile, bars, params });
    if (evaluation.skipped === true) {
      return { ok: true, enabled: true, skipped: true, reason: evaluation.reason, evaluation, written: 0 };
    }

    const row = buildStrategyExitShadowRow({
      position,
      strategyProfile,
      tradeMode,
      currentDecision,
      evaluation,
      bars,
    });
    if (!row) {
      return { ok: false, enabled: true, skipped: true, reason: 'row_build_failed', evaluation, written: 0 };
    }

    const canWrite = canWriteStrategyExitShadow({ ...options, persist: options.persist });
    if (!canWrite) {
      return { ok: true, enabled: true, skipped: false, canWrite: false, row, evaluation, written: 0 };
    }

    const result = await (deps.upsertStrategyExitShadow || upsertStrategyExitShadow)(row, deps.runFn || db.run);
    return {
      ok: true,
      enabled: true,
      skipped: false,
      canWrite: true,
      row,
      evaluation,
      written: Number(result?.rowCount || 0),
      id: result?.rows?.[0]?.id || null,
    };
  } catch (error) {
    return {
      ok: false,
      enabled: true,
      skipped: true,
      reason: 'strategy_exit_shadow_error',
      error: error?.message || String(error),
      written: 0,
    };
  }
}

export const _testOnly = {
  truthy,
  finite,
  lastValidBar,
  setupTypeOf,
};

export default {
  LUNA_STRATEGY_EXIT_SHADOW_CONFIRM,
  LUNA_STRATEGY_EXIT_SHADOW_ENV,
  buildStrategyExitPositionId,
  buildStrategyExitShadowRow,
  canWriteStrategyExitShadow,
  evaluateStrategyExitShadow,
  isStrategyExitShadowEnabled,
  loadStrategyExitShadowParameters,
  mapSetupTypeToStrategyExitFamily,
  runStrategyExitShadowSidecar,
  strategyExitShadowMarketForExchange,
  upsertStrategyExitShadow,
};
