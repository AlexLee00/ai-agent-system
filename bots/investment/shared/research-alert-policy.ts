// @ts-nocheck

import fs from 'node:fs';
import path from 'node:path';
import { investmentOpsRuntimeFile } from './runtime-ops-path.ts';

const DEFAULT_COOLDOWN_MINUTES = 6 * 60;
const DEFAULT_STATE_PATH = investmentOpsRuntimeFile('luna-research-alert-state.json');

function parseBool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseCooldownMinutes(value, fallback = DEFAULT_COOLDOWN_MINUTES) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, parsed);
}

function readJsonSafe(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonSafe(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function normalizeResearchSymbols(symbols = []) {
  return [...new Set(
    (symbols || [])
      .map((symbol) => String(symbol || '').trim().toUpperCase())
      .filter(Boolean)
  )].sort();
}

function symbolDigest(symbols = []) {
  return normalizeResearchSymbols(symbols).join('|');
}

function marketKey(market) {
  return String(market || 'unknown').trim().toLowerCase() || 'unknown';
}

export function shouldPublishResearchAlert({
  market,
  symbols = [],
  state = {},
  now = new Date(),
  cooldownMinutes,
  env = process.env,
} = {}) {
  const key = marketKey(market);
  const currentSymbols = normalizeResearchSymbols(symbols);
  const currentDigest = symbolDigest(currentSymbols);
  const minutes = parseCooldownMinutes(cooldownMinutes ?? env.LUNA_RESEARCH_ALERT_COOLDOWN_MINUTES);
  const previous = state?.markets?.[key] || {};
  const lastAlertMs = Date.parse(previous.lastAlertAt || '');
  const elapsedMs = Number.isFinite(lastAlertMs) ? now.getTime() - lastAlertMs : Infinity;
  const cooldownMs = minutes * 60 * 1000;
  const changed = currentDigest !== String(previous.symbolDigest || '');
  const publishChangedWithinCooldown = parseBool(env.LUNA_RESEARCH_ALERT_PUBLISH_CHANGED_WITHIN_COOLDOWN, false);

  if (parseBool(env.LUNA_RESEARCH_ALERT_EVERY_CYCLE, false)) {
    return {
      shouldPublish: true,
      reason: 'forced_every_cycle',
      changed,
      cooldownMinutes: minutes,
      symbols: currentSymbols,
    };
  }

  if (!previous.lastAlertAt) {
    return {
      shouldPublish: true,
      reason: 'first_research_alert',
      changed: true,
      cooldownMinutes: minutes,
      symbols: currentSymbols,
    };
  }

  if (changed && (elapsedMs >= cooldownMs || publishChangedWithinCooldown)) {
    return {
      shouldPublish: true,
      reason: 'watchlist_changed',
      changed: true,
      cooldownMinutes: minutes,
      symbols: currentSymbols,
      lastAlertAt: previous.lastAlertAt,
    };
  }

  if (changed) {
    return {
      shouldPublish: false,
      reason: 'watchlist_changed_cooldown_suppressed',
      changed: true,
      cooldownMinutes: minutes,
      symbols: currentSymbols,
      lastAlertAt: previous.lastAlertAt,
      nextEligibleAt: new Date(lastAlertMs + cooldownMs).toISOString(),
    };
  }

  if (elapsedMs >= cooldownMs) {
    return {
      shouldPublish: true,
      reason: 'cooldown_elapsed',
      changed: false,
      cooldownMinutes: minutes,
      symbols: currentSymbols,
      lastAlertAt: previous.lastAlertAt,
    };
  }

  return {
    shouldPublish: false,
    reason: 'cooldown_suppressed',
    changed: false,
    cooldownMinutes: minutes,
    symbols: currentSymbols,
    lastAlertAt: previous.lastAlertAt,
    nextEligibleAt: new Date(lastAlertMs + cooldownMs).toISOString(),
  };
}

export function recordResearchAlertState({
  market,
  symbols = [],
  state = {},
  now = new Date(),
  meta = {},
} = {}) {
  const key = marketKey(market);
  const nextState = {
    ...state,
    markets: {
      ...(state?.markets || {}),
      [key]: {
        lastAlertAt: now.toISOString(),
        symbolDigest: symbolDigest(symbols),
        symbols: normalizeResearchSymbols(symbols),
        meta,
      },
    },
    updatedAt: now.toISOString(),
  };
  return nextState;
}

export function evaluateResearchAlertState({
  market,
  symbols = [],
  statePath = DEFAULT_STATE_PATH,
  now = new Date(),
  cooldownMinutes,
  env = process.env,
  meta = {},
  write = true,
} = {}) {
  const state = readJsonSafe(statePath, { markets: {} });
  const decision = shouldPublishResearchAlert({
    market,
    symbols,
    state,
    now,
    cooldownMinutes,
    env,
  });

  if (decision.shouldPublish && write) commitResearchAlertState({ market, symbols, statePath, now, meta });

  return {
    ...decision,
    statePath,
  };
}

export function commitResearchAlertState({
  market,
  symbols = [],
  statePath = DEFAULT_STATE_PATH,
  now = new Date(),
  meta = {},
} = {}) {
  const state = readJsonSafe(statePath, { markets: {} });
  const nextState = recordResearchAlertState({ market, symbols, state, now, meta });
  writeJsonSafe(statePath, nextState);
  return {
    statePath,
    updatedAt: nextState.updatedAt,
  };
}

export default {
  commitResearchAlertState,
  evaluateResearchAlertState,
  normalizeResearchSymbols,
  recordResearchAlertState,
  shouldPublishResearchAlert,
};
