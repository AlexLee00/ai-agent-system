// @ts-nocheck

import { insertStrategyFamilySignal } from './luna-strategy-families.ts';
import { getParameter, setParameter } from './luna-parameter-store.ts';

export const LUNA_C3_REALIGN_MODE_ENV = 'LUNA_C3_REALIGN_MODE';
export const LUNA_C3_REALIGN_PROMOTION_READY_ENV = 'LUNA_C3_REALIGN_PROMOTION_READY';
export const LUNA_C3_REALIGN_PARAMETER_KEY = 'c3_regime_strategy_map_v2';
export const LUNA_C3_REALIGN_RULE_VERSION = 'c3_regime_strategy_map_v2';

export const C3_REGIME_STRATEGY_MAP_V2 = Object.freeze({
  trending_bull: [
    { family: 'momentum_rotation', role: 'primary', weight: 1.0 },
    { family: 'trend_following', role: 'reduced', weight: 0.35 },
  ],
  trending_bear: [
    { family: 'mean_reversion', role: 'primary', weight: 1.0 },
  ],
  ranging: [
    { family: 'mean_reversion', role: 'primary', weight: 1.0 },
  ],
});

function clean(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function parseEnabled(value) {
  return ['1', 'true', 'yes', 'y', 'on'].includes(clean(value).toLowerCase());
}

export function normalizeC3RealignMode(env = process.env) {
  const mode = clean(env?.[LUNA_C3_REALIGN_MODE_ENV], 'off').toLowerCase();
  return mode === 'shadow' || mode === 'enforce' ? mode : 'off';
}

export function isC3RealignPromotionReady(env = process.env, options = {}) {
  return options.promotionReady === true || parseEnabled(env?.[LUNA_C3_REALIGN_PROMOTION_READY_ENV]);
}

export function normalizeC3Regime(raw = null) {
  const value = clean(raw?.regime || raw?.dominant || raw).toLowerCase();
  if (value.includes('bull')) return 'trending_bull';
  if (value.includes('bear')) return 'trending_bear';
  if (value.includes('rang') || value.includes('sideways')) return 'ranging';
  return null;
}

export function resolveC3RegimeStrategyMap(regime, map = C3_REGIME_STRATEGY_MAP_V2) {
  const normalized = normalizeC3Regime(regime);
  const entries = normalized ? map?.[normalized] : null;
  return {
    regime: normalized,
    entries: Array.isArray(entries) ? entries : [],
    primary: Array.isArray(entries) ? entries.find((entry) => entry.role === 'primary') || entries[0] || null : null,
  };
}

export function buildC3RealignOverlay(route = null, options = {}) {
  if (!route) return null;
  const resolved = resolveC3RegimeStrategyMap(options.marketRegime || route.regime || null, options.map);
  if (!resolved.primary?.family) return null;
  const originalFamily = clean(route.selectedFamily || route.setupType);
  const targetFamily = clean(resolved.primary.family);
  const remapped = Boolean(originalFamily && targetFamily && originalFamily !== targetFamily);
  const bearDefensiveExcluded = resolved.regime === 'trending_bear'
    && targetFamily !== 'defensive_rotation'
    && !resolved.entries.some((entry) => entry.family === 'defensive_rotation');
  return {
    mode: normalizeC3RealignMode(options.env || process.env),
    ruleVersion: LUNA_C3_REALIGN_RULE_VERSION,
    regime: resolved.regime,
    originalFamily,
    targetFamily,
    remapped,
    bearDefensiveExcluded,
    entries: resolved.entries,
  };
}

export function applyC3RealignToRoute(route = null, options = {}) {
  const mode = normalizeC3RealignMode(options.env || process.env);
  if (!route || mode === 'off') return route;
  const overlay = buildC3RealignOverlay(route, { ...options, env: { [LUNA_C3_REALIGN_MODE_ENV]: mode } });
  if (!overlay) return route;

  if (mode === 'shadow') {
    return {
      ...route,
      c3Realign: {
        ...overlay,
        shadowOnly: true,
        liveMutation: false,
      },
    };
  }

  if (!isC3RealignPromotionReady(options.env || process.env, options)) {
    return {
      ...route,
      c3Realign: {
        ...overlay,
        shadowOnly: true,
        liveMutation: false,
        enforceBlocked: true,
        blocker: 'promotion_gate_not_ready',
      },
    };
  }

  return {
    ...route,
    selectedFamily: overlay.targetFamily,
    setupType: overlay.targetFamily,
    c3Realign: {
      ...overlay,
      shadowOnly: false,
      liveMutation: true,
      enforced: true,
    },
  };
}

export function buildC3RealignShadowSignal(route = null, options = {}) {
  const overlay = buildC3RealignOverlay(route, options);
  if (!route || !overlay?.targetFamily) return null;
  const now = options.now ? new Date(options.now) : new Date();
  const hourTs = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000).toISOString();
  return {
    market: options.market || (options.exchange === 'binance' ? 'crypto' : 'stock'),
    symbol: options.symbol || route.symbol || 'UNKNOWN',
    family: overlay.targetFamily,
    signalType: 'c3_realign_shadow',
    candleTs: options.candleTs || hourTs,
    price: options.price ?? null,
    stop: null,
    target: null,
    rr: null,
    regime: { regime: overlay.regime, source: 'c3_realign' },
    matched: overlay.remapped ? false : null,
    ruleVersion: LUNA_C3_REALIGN_RULE_VERSION,
    reason: 'c3 regime strategy realign shadow',
    source: 'c3_realign_shadow',
    details: {
      c3Realign: {
        ...overlay,
        shadowOnly: true,
        liveMutation: false,
      },
      excludeFromOrderPath: true,
    },
  };
}

export async function recordC3RealignShadowSignal(route = null, options = {}) {
  if (normalizeC3RealignMode(options.env || process.env) !== 'shadow') {
    return { skipped: true, reason: 'c3_realign_mode_not_shadow' };
  }
  const row = buildC3RealignShadowSignal(route, options);
  if (!row) return { skipped: true, reason: 'no_c3_realign_shadow_signal' };
  const result = await insertStrategyFamilySignal(row, options.runFn);
  return { skipped: false, row, result };
}

export async function buildC3ParameterPlan(options = {}) {
  const current = await getParameter(LUNA_C3_REALIGN_PARAMETER_KEY, 'global', {
    bypassCache: true,
    queryFn: options.queryFn,
    env: options.env || process.env,
  }).catch(() => null);
  return {
    key: LUNA_C3_REALIGN_PARAMETER_KEY,
    scope: 'global',
    desired: C3_REGIME_STRATEGY_MAP_V2,
    current: current?.value || null,
    currentSource: current?.source || null,
    needsApply: JSON.stringify(current?.value || null) !== JSON.stringify(C3_REGIME_STRATEGY_MAP_V2),
  };
}

export async function applyC3ParameterPlan(options = {}) {
  const plan = await buildC3ParameterPlan(options);
  if (options.apply !== true) {
    return { ...plan, applied: false, dryRun: true };
  }
  const stored = await setParameter({
    key: LUNA_C3_REALIGN_PARAMETER_KEY,
    value: C3_REGIME_STRATEGY_MAP_V2,
    evidence: 'SPEC_LUNA_C3_REALIGN_2026-07-02',
    changedBy: 'master',
  }, {
    queryFn: options.queryFn,
    runFn: options.runFn,
  });
  return { ...plan, applied: true, dryRun: false, stored };
}

export default {
  LUNA_C3_REALIGN_PARAMETER_KEY,
  LUNA_C3_REALIGN_RULE_VERSION,
  C3_REGIME_STRATEGY_MAP_V2,
  isC3RealignPromotionReady,
  normalizeC3RealignMode,
  normalizeC3Regime,
  resolveC3RegimeStrategyMap,
  buildC3RealignOverlay,
  applyC3RealignToRoute,
  buildC3RealignShadowSignal,
  recordC3RealignShadowSignal,
  buildC3ParameterPlan,
  applyC3ParameterPlan,
};
