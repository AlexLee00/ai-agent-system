// @ts-nocheck

import { getLunaIntelligentDiscoveryFlags } from '../luna-intelligent-discovery-config.ts';

const BUY_ACTION = 'BUY';
const MIN_CONFIDENCE = 0.48;
const MAX_CONFIDENCE = 0.90;

function finiteNumber(value: any, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value: any, min = MIN_CONFIDENCE, max = MAX_CONFIDENCE) {
  return Math.max(min, Math.min(max, finiteNumber(value, min)));
}

function normalizeSymbol(symbol: any) {
  return String(symbol || '').trim().toUpperCase();
}

function normalizeRegime(regime: any, ctx: any = {}) {
  if (typeof regime === 'string') return regime;
  return regime?.dominant || regime?.market_regime || ctx.regime || ctx.market_regime || '';
}

function setupTypeForFamily(family: any) {
  const normalized = String(family || '').toLowerCase();
  if (normalized.includes('testah') || normalized.includes('pullback')) return 'strategy_family_pullback';
  if (normalized.includes('turtle') || normalized.includes('breakout')) return 'strategy_family_breakout';
  return 'strategy_family_entry';
}

function triggerTypeForFamily(family: any) {
  const normalized = String(family || '').toLowerCase();
  if (normalized.includes('testah') || normalized.includes('pullback')) return 'pullback_to_support';
  if (normalized.includes('turtle') || normalized.includes('breakout')) return 'breakout_confirmation';
  return 'mtf_alignment';
}

function confidenceForSignal(signal: any = {}) {
  const details = signal.details || {};
  let score = 0.60;
  const rr = finiteNumber(signal.rr, 0);
  if (signal.matched === true) score += 0.08;
  if (rr >= 2) score += 0.08;
  else if (rr >= 1.5) score += 0.04;
  if (details.regimeMatched === true) score += 0.04;
  if (details.atr != null || details.ma != null || details.maFast != null) score += 0.03;
  if (details.previousHigh != null || details.previousSwingHigh != null) score += 0.03;
  if (signal.matched === false) score -= 0.05;
  return clamp(score);
}

export function strategySignalToEntryCandidate(signal: any = {}, ctx: any = {}) {
  if (String(signal.signalType || signal.signal_type || '').trim() !== 'entry') return null;
  const symbol = normalizeSymbol(signal.symbol);
  if (!symbol) return null;

  const market = String(signal.market || ctx.market || 'crypto').trim() || 'crypto';
  const regime = normalizeRegime(signal.regime, ctx);
  const family = String(signal.family || 'strategy_family').trim() || 'strategy_family';
  const confidence = confidenceForSignal(signal);
  if (confidence < MIN_CONFIDENCE) return null;

  return {
    action: BUY_ACTION,
    symbol,
    market,
    regime,
    market_regime: regime,
    confidence,
    setup_type: setupTypeForFamily(family),
    triggerType: triggerTypeForFamily(family),
    side: 'long',
    entry_price: signal.price ?? null,
    target_price: signal.price ?? null,
    sl_price: signal.stop ?? null,
    stop_loss: signal.stop ?? null,
    tp_price: signal.target ?? null,
    take_profit: signal.target ?? null,
    reasoning: [
      `strategy:${family}:entry`,
      signal.reason ? `reason=${signal.reason}` : null,
      signal.rr != null ? `rr=${signal.rr}` : null,
      signal.matched != null ? `regimeMatched=${signal.matched === true}` : null,
    ].filter(Boolean).join(' | ').slice(0, 220),
    strategy_route: {
      source: 'strategy_family',
      family,
      setupType: setupTypeForFamily(family),
      signalType: 'entry',
      ruleVersion: signal.ruleVersion || signal.rule_version || 'v1',
    },
    triggerHints: {
      discoveryScore: confidence,
      mtfAgreement: signal.matched === true ? 0.74 : 0.58,
      mtfAlignmentScore: signal.matched === true ? 0.24 : 0.12,
      mtfDominantSignal: BUY_ACTION,
      breakoutRetest: triggerTypeForFamily(family) === 'pullback_to_support',
      strategyFamily: family,
      strategyReason: signal.reason || null,
      rr: signal.rr ?? null,
      details: signal.details || {},
    },
    block_meta: {
      strategyFamilyAdapter: {
        source: 'strategy-to-entry-trigger-adapter',
        confidenceFormula: 'base_0.60 + regime/rr/rule-evidence bonuses, clamped 0.48..0.90',
        candleTs: signal.candleTs || signal.candle_ts || null,
      },
    },
  };
}

export function strategySignalsToEntryCandidates(signals: any[] = [], ctx: any = {}) {
  return (Array.isArray(signals) ? signals : [])
    .map((signal) => strategySignalToEntryCandidate(signal, ctx))
    .filter(Boolean);
}

export function buildEntryTriggerShadowFlags({ env = process.env, baseFlags = null } = {}) {
  const forcedEnv = {
    ...env,
    LUNA_RUNTIME_ENV_SOURCE: 'process',
    LUNA_INTELLIGENT_DISCOVERY_MODE: env?.LUNA_INTELLIGENT_DISCOVERY_MODE || 'shadow',
    LUNA_ENTRY_TRIGGER_ENGINE_ENABLED: 'true',
    LUNA_LIVE_FIRE_ENABLED: 'false',
    LUNA_ENTRY_TRIGGER_FIRE_IN_SHADOW: 'false',
    LUNA_ENTRY_TRIGGER_SHADOW_BLOCKS_BUY: 'false',
  };
  const flags = baseFlags || getLunaIntelligentDiscoveryFlags({ env: forcedEnv });
  return {
    ...flags,
    mode: 'shadow',
    shadow: true,
    supervised: false,
    autonomous: false,
    liveFireEnabled: false,
    phases: {
      ...(flags.phases || {}),
      entryTriggerEnabled: true,
    },
    entryTrigger: {
      ...(flags.entryTrigger || {}),
      fireInShadow: false,
      mutateInShadow: false,
    },
    shouldAllowLiveEntryFire() {
      return false;
    },
    shouldEntryTriggerMutate() {
      return false;
    },
  };
}

export function assertEntryTriggerShadow(flags: any = {}, context: any = {}) {
  const observeOnlyPersistence = context.entryTriggerShadowPersistence === true;
  if (context.dryRun !== true && !observeOnlyPersistence) {
    throw new Error('entry_trigger_shadow_requires_dry_run_or_observe_only_persistence');
  }
  if (flags.liveFireEnabled !== false) throw new Error('entry_trigger_shadow_live_fire_not_forced_false');
  if (typeof flags.shouldAllowLiveEntryFire !== 'function') throw new Error('entry_trigger_shadow_flags_missing_live_fire_guard');
  if (flags.shouldAllowLiveEntryFire() !== false) throw new Error('entry_trigger_shadow_live_fire_guard_not_false');
  if (typeof flags.shouldEntryTriggerMutate !== 'function') throw new Error('entry_trigger_shadow_flags_missing_mutation_guard');
  if (flags.shouldEntryTriggerMutate() !== false) throw new Error('entry_trigger_shadow_mutation_guard_not_false');
  return true;
}

export default {
  strategySignalToEntryCandidate,
  strategySignalsToEntryCandidates,
  buildEntryTriggerShadowFlags,
  assertEntryTriggerShadow,
};
