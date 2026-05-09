// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { investmentOpsRuntimeFile } from './runtime-ops-path.ts';

const DEFAULT_DECISION_LLM_STATE_FILE = investmentOpsRuntimeFile('luna-decision-llm-budget-state.json');
const DECISION_LLM_STATE_RETENTION_MS = 24 * 60 * 60 * 1000;

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

function readJsonSafe(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonSafe(filePath, payload) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

function stateKeyFor({ market, symbol }) {
  return `${normalizeMarket(market)}:${String(symbol || '').trim().toUpperCase()}`;
}

function compactDecisionLlmState(state = {}, nowMs = Date.now()) {
  const next = { updatedAt: new Date(nowMs).toISOString(), symbols: {} };
  for (const [key, value] of Object.entries(state?.symbols || {})) {
    const lastAllowedAt = Date.parse(value?.lastAllowedAt || '');
    if (!Number.isFinite(lastAllowedAt)) continue;
    if (nowMs - lastAllowedAt > DECISION_LLM_STATE_RETENTION_MS) continue;
    next.symbols[key] = value;
  }
  return next;
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
  const defaultCooldownMinutes = market === 'binance' ? 30 : 0;
  const cooldownMinutes = Math.max(0, Math.floor(envNumber(env, [
    `LUNA_${prefix}_DECISION_LLM_COOLDOWN_MINUTES`,
    'LUNA_DECISION_LLM_COOLDOWN_MINUTES',
  ], defaultCooldownMinutes)));
  return {
    enabled: Boolean(enabled && maxSymbols > 0),
    market,
    maxSymbols,
    cooldownMinutes,
    reason: enabled && maxSymbols > 0 ? 'budget_active' : 'budget_disabled',
  };
}

export function resolveDecisionDebateBudget({ exchange, env = process.env } = {}) {
  const market = normalizeMarket(exchange);
  const prefix = marketPrefix(market);
  const defaultEnabled = market === 'binance';
  const enabled = envFlag(env, 'LUNA_DECISION_DEBATE_BUDGET_ENABLED', defaultEnabled)
    && envFlag(env, `LUNA_${prefix}_DECISION_DEBATE_BUDGET_ENABLED`, defaultEnabled);
  const defaultMaxSymbols = market === 'binance' ? 1 : 0;
  const maxSymbols = Math.max(0, Math.floor(envNumber(env, [
    `LUNA_${prefix}_DECISION_DEBATE_MAX_SYMBOLS_PER_CYCLE`,
    'LUNA_DECISION_DEBATE_MAX_SYMBOLS_PER_CYCLE',
  ], defaultMaxSymbols)));
  return {
    enabled: Boolean(enabled && maxSymbols > 0),
    market,
    maxSymbols,
    reason: enabled && maxSymbols > 0 ? 'debate_budget_active' : 'debate_budget_disabled',
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

export function createDecisionLlmBudgetGate({
  exchange,
  liveHeldSymbols = null,
  env = process.env,
  stateFile = DEFAULT_DECISION_LLM_STATE_FILE,
  now = () => new Date(),
} = {}) {
  const policy = resolveDecisionLlmBudget({ exchange, env });
  const market = normalizeMarket(exchange);
  let persistedState = compactDecisionLlmState(readJsonSafe(stateFile, { symbols: {} }), now().getTime());
  const state = {
    considered: 0,
    used: 0,
    heldBypass: 0,
    cooldownSkipped: 0,
    skipped: 0,
    selected: [],
    skippedSymbols: [],
  };

  function cooldownDecision(symbol) {
    const cooldownMinutes = Number(policy.cooldownMinutes || 0);
    if (!policy.enabled || cooldownMinutes <= 0) return null;
    const key = stateKeyFor({ market, symbol });
    const lastAllowedAt = persistedState?.symbols?.[key]?.lastAllowedAt || null;
    if (!lastAllowedAt) return null;
    const lastMs = Date.parse(lastAllowedAt);
    if (!Number.isFinite(lastMs)) return null;
    const nowDate = now();
    const nowMs = nowDate.getTime();
    const cooldownMs = cooldownMinutes * 60 * 1000;
    const ageMs = nowMs - lastMs;
    if (ageMs < 0 || ageMs >= cooldownMs) return null;
    return {
      key,
      lastAllowedAt,
      nextEligibleAt: new Date(lastMs + cooldownMs).toISOString(),
      cooldownMinutes,
    };
  }

  function markAllowed(symbol, reason) {
    if (!policy.enabled || Number(policy.cooldownMinutes || 0) <= 0) return;
    const key = stateKeyFor({ market, symbol });
    const nowDate = now();
    persistedState = compactDecisionLlmState(persistedState, nowDate.getTime());
    persistedState.symbols[key] = {
      market,
      symbol: String(symbol || '').trim().toUpperCase(),
      lastAllowedAt: nowDate.toISOString(),
      reason,
    };
    writeJsonSafe(stateFile, persistedState);
  }

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
      const cooldown = cooldownDecision(normalizedSymbol);
      if (cooldown) {
        state.cooldownSkipped += 1;
        state.skipped += 1;
        state.skippedSymbols.push({
          symbol: normalizedSymbol,
          confidence,
          reason: 'decision_llm_symbol_cooldown',
          nextEligibleAt: cooldown.nextEligibleAt,
        });
        return {
          allow: false,
          held,
          confidence,
          reason: 'decision_llm_symbol_cooldown',
          nextEligibleAt: cooldown.nextEligibleAt,
          lastAllowedAt: cooldown.lastAllowedAt,
        };
      }
      if (state.used < policy.maxSymbols) {
        state.used += 1;
        state.selected.push({ symbol: normalizedSymbol, confidence, reason: 'within_budget' });
        markAllowed(normalizedSymbol, 'within_budget');
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
        stateFile,
        selected: [...state.selected],
        skippedSymbols: [...state.skippedSymbols],
      };
    },
  };
}

export function createDecisionDebateBudgetGate({ exchange, env = process.env } = {}) {
  const policy = resolveDecisionDebateBudget({ exchange, env });
  const state = {
    considered: 0,
    used: 0,
    skipped: 0,
    selected: [],
    skippedSymbols: [],
  };

  return {
    policy,
    allow({ symbol, prefilter } = {}) {
      const normalizedSymbol = String(symbol || '').trim();
      const confidence = prefilterConfidence(prefilter);
      state.considered += 1;
      if (!policy.enabled) {
        state.used += 1;
        state.selected.push({ symbol: normalizedSymbol, confidence, reason: 'debate_budget_disabled' });
        return { allow: true, confidence, reason: 'debate_budget_disabled' };
      }
      if (state.used < policy.maxSymbols) {
        state.used += 1;
        state.selected.push({ symbol: normalizedSymbol, confidence, reason: 'within_debate_budget' });
        return { allow: true, confidence, reason: 'within_debate_budget' };
      }
      state.skipped += 1;
      state.skippedSymbols.push({ symbol: normalizedSymbol, confidence, reason: 'decision_debate_budget_reached' });
      return { allow: false, confidence, reason: 'decision_debate_budget_reached' };
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
  resolveDecisionDebateBudget,
  prefilterConfidence,
  createDecisionLlmBudgetGate,
  createDecisionDebateBudgetGate,
};
