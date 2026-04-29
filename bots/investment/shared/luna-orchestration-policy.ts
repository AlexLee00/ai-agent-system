// @ts-nocheck
/**
 * Pure Luna orchestration policy helpers.
 *
 * These functions gate discovery, reduce candidate pressure, and normalize
 * small labels/scores. Keeping them outside team/luna.ts makes the runtime
 * orchestrator easier to audit without changing trading behavior.
 */

import { ACTIONS } from './signal.ts';

export function shouldRunDiscovery(capitalSnapshot = null, modeOverride = '') {
  if (String(modeOverride || '').trim().toLowerCase() === 'monitor_only') return false;
  if (!capitalSnapshot) return true; // 스냅샷 없으면 허용 (안전 폴백)
  return capitalSnapshot.mode === 'ACTIVE_DISCOVERY';
}

export function resolveCapitalGateAction(capitalSnapshot = null, openPositionCount = 0, modeOverride = '') {
  if (shouldRunDiscovery(capitalSnapshot, modeOverride)) return 'active_discovery';
  if (Number(openPositionCount || 0) > 0) return 'exit_only';
  return 'idle_digest';
}

export function formatCapitalModeLog(snapshot = null) {
  if (!snapshot) return '';
  const { mode, reasonCode, buyableAmount, minOrderAmount, balanceStatus, openPositionCount, maxPositionCount } = snapshot;
  return `[자본상태] mode=${mode} | reason=${reasonCode || 'none'} | 매수가능=${Number(buyableAmount || 0).toFixed(2)} 최소=${minOrderAmount} | 잔고=${balanceStatus} | 포지션=${openPositionCount}/${maxPositionCount}`;
}

export function applyDiscoveryThrottleToSymbols(symbols = [], throttle = null) {
  if (!Array.isArray(symbols)) return [];
  if (!throttle?.enabled) return symbols;
  const maxSymbols = Number(throttle?.maxSymbols || 0);
  if (!(maxSymbols > 0) || symbols.length <= maxSymbols) return symbols;
  return symbols.slice(0, maxSymbols);
}

export function applyDiscoveryHardCap(symbols = [], maxSymbols = 60) {
  if (!Array.isArray(symbols)) return [];
  const cap = Math.max(1, Number(maxSymbols || 60));
  return symbols.length > cap ? symbols.slice(0, cap) : symbols;
}

export function applyDiscoveryThrottleToDecision(decision = null, throttle = null) {
  if (!decision || !Array.isArray(decision.decisions)) {
    return { decision, reducedCount: 0 };
  }
  if (!throttle?.enabled) return { decision, reducedCount: 0 };
  const maxBuyCandidates = Number(throttle?.maxBuyCandidates || 0);
  if (!(maxBuyCandidates > 0)) return { decision, reducedCount: 0 };

  const buys = decision.decisions
    .map((item, idx) => ({ item, idx }))
    .filter(({ item }) => item?.action === ACTIONS.BUY)
    .sort((a, b) => Number(b.item?.confidence || 0) - Number(a.item?.confidence || 0));
  if (buys.length <= maxBuyCandidates) return { decision, reducedCount: 0 };

  const keep = new Set(buys.slice(0, maxBuyCandidates).map((entry) => entry.idx));
  let reducedCount = 0;
  const nextDecisions = decision.decisions.map((item, idx) => {
    if (item?.action !== ACTIONS.BUY || keep.has(idx)) return item;
    reducedCount += 1;
    return {
      ...item,
      action: ACTIONS.HOLD,
      amount_usdt: 0,
      reasoning: `discovery_throttle: maxBuyCandidates=${maxBuyCandidates} 상한으로 후보 보류 | ${item.reasoning || ''}`.slice(0, 220),
      block_meta: {
        ...(item.block_meta || {}),
        discoveryThrottle: {
          modeOverride: throttle.modeOverride || null,
          maxBuyCandidates,
          reducedByThrottle: true,
        },
      },
    };
  });

  return {
    decision: { ...decision, decisions: nextDecisions },
    reducedCount,
  };
}

export function mergeUniqueSymbols(primary = [], fallback = []) {
  const out = [];
  const seen = new Set();
  for (const item of [...primary, ...fallback]) {
    const value = String(item || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function normalizeRegimeLabel(marketRegime = null) {
  const raw = String(marketRegime?.regime || marketRegime?.label || marketRegime || '').trim();
  return raw || 'ranging';
}

export function clamp01(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

export default {
  shouldRunDiscovery,
  resolveCapitalGateAction,
  formatCapitalModeLog,
  applyDiscoveryThrottleToSymbols,
  applyDiscoveryHardCap,
  applyDiscoveryThrottleToDecision,
  mergeUniqueSymbols,
  normalizeRegimeLabel,
  clamp01,
};

