// @ts-nocheck

function envFlag(env, key, fallback = true) {
  const value = env?.[key];
  if (value == null || value === '') return fallback;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(text)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(text)) return false;
  return fallback;
}

function envNumber(env, keys = [], fallback = 0) {
  for (const key of keys) {
    const value = Number(env?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return fallback;
}

function normalizeMarket(exchange = '') {
  const value = String(exchange || '').toLowerCase();
  if (value === 'crypto') return 'binance';
  if (value === 'domestic') return 'kis';
  if (value === 'overseas') return 'kis_overseas';
  return value;
}

function marketPrefix(market) {
  if (market === 'binance') return 'CRYPTO';
  if (market === 'kis') return 'DOMESTIC';
  if (market === 'kis_overseas') return 'OVERSEAS';
  return 'GENERIC';
}

export function resolveDecisionLlmBudget({ exchange, env = process.env } = {}) {
  const market = normalizeMarket(exchange);
  const prefix = marketPrefix(market);
  const defaultEnabled = market === 'binance';
  const enabled = envFlag(env, 'LUNA_DECISION_LLM_BUDGET_ENABLED', defaultEnabled)
    && envFlag(env, `LUNA_${prefix}_DECISION_LLM_BUDGET_ENABLED`, defaultEnabled);
  const defaultMaxSymbols = market === 'binance' ? 3 : 0;
  const maxSymbols = Math.max(0, Math.floor(envNumber(env, [
    `LUNA_${prefix}_DECISION_LLM_MAX_SYMBOLS_PER_CYCLE`,
    'LUNA_DECISION_LLM_MAX_SYMBOLS_PER_CYCLE',
  ], defaultMaxSymbols)));
  return {
    enabled: Boolean(enabled && maxSymbols > 0),
    market,
    maxSymbols,
    reason: enabled && maxSymbols > 0 ? 'budget_active' : 'budget_disabled',
  };
}

export function prefilterConfidence(prefilter = {}) {
  const values = [
    prefilter.confidence,
    prefilter.technical?.confidence,
    prefilter.flow?.confidence,
    prefilter.support?.confidence,
    prefilter.relaxation?.avgConfidence,
  ].map(Number).filter(Number.isFinite);
  return values.length > 0 ? Math.max(...values) : null;
}

export function createDecisionLlmBudgetGate({ exchange, liveHeldSymbols = null, env = process.env } = {}) {
  const policy = resolveDecisionLlmBudget({ exchange, env });
  const state = {
    considered: 0,
    used: 0,
    heldBypass: 0,
    skipped: 0,
    selected: [],
    skippedSymbols: [],
  };

  return {
    policy,
    allow({ symbol, prefilter } = {}) {
      const normalizedSymbol = String(symbol || '').trim();
      const held = liveHeldSymbols?.has?.(normalizedSymbol) === true;
      const confidence = prefilterConfidence(prefilter);
      state.considered += 1;
      if (!policy.enabled) {
        state.used += 1;
        state.selected.push({ symbol: normalizedSymbol, confidence, reason: 'budget_disabled' });
        return { allow: true, held, confidence, reason: 'budget_disabled' };
      }
      if (held) {
        state.heldBypass += 1;
        state.selected.push({ symbol: normalizedSymbol, confidence, reason: 'held_symbol_budget_bypass' });
        return { allow: true, held, confidence, reason: 'held_symbol_budget_bypass' };
      }
      if (state.used < policy.maxSymbols) {
        state.used += 1;
        state.selected.push({ symbol: normalizedSymbol, confidence, reason: 'within_budget' });
        return { allow: true, held, confidence, reason: 'within_budget' };
      }
      state.skipped += 1;
      state.skippedSymbols.push({ symbol: normalizedSymbol, confidence, reason: 'decision_llm_symbol_budget_reached' });
      return { allow: false, held, confidence, reason: 'decision_llm_symbol_budget_reached' };
    },
    snapshot() {
      return {
        ...policy,
        ...state,
        selected: [...state.selected],
        skippedSymbols: [...state.skippedSymbols],
      };
    },
  };
}

export default {
  resolveDecisionLlmBudget,
  prefilterConfidence,
  createDecisionLlmBudgetGate,
};
