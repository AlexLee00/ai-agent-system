// @ts-nocheck

import { resolvePositionLifecycleFlags } from './position-lifecycle-flags.ts';

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 6) {
  const scale = 10 ** digits;
  return Math.round(Number(value || 0) * scale) / scale;
}

function clamp(value, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

export function computeDynamicTrail(input = {}) {
  const flags = resolvePositionLifecycleFlags();
  const enabled = flags.shouldApplyDynamicTrail();
  const shadowMode = !enabled;
  const method = String(input.method || 'atr').toLowerCase();
  const side = String(input.side || 'long').toLowerCase();
  const close = Math.max(0, n(input.close, n(input.price, 0)));
  const atr = Math.max(0, n(input.atr, close * 0.015));
  const highestHigh = Math.max(close, n(input.highestHigh, close));
  const lowestLow = Math.min(close, n(input.lowestLow, close));
  const vwap = Math.max(0, n(input.vwap, close));
  const sar = Math.max(0, n(input.sar, close));
  const chandelierMul = Math.max(0.1, n(flags.phaseF.chandelierMultiplier, 3.0));
  const atrMul = Math.max(0.1, n(flags.phaseF.atrMultiplier, 2.5));
  const previousStopPrice = Math.max(0, n(input.previousStopPrice, 0));

  let stop = close;
  let reasonCode = 'trail_hold';

  if (method === 'chandelier') {
    stop = side === 'long'
      ? highestHigh - (atr * chandelierMul)
      : lowestLow + (atr * chandelierMul);
    reasonCode = 'trail_chandelier';
  } else if (method === 'sar') {
    stop = sar;
    reasonCode = 'trail_sar';
  } else if (method === 'vwap') {
    stop = side === 'long'
      ? vwap - (atr * 0.75)
      : vwap + (atr * 0.75);
    reasonCode = 'trail_vwap';
  } else {
    stop = side === 'long'
      ? close - (atr * atrMul)
      : close + (atr * atrMul);
    reasonCode = 'trail_atr';
  }

  if (close > 0) {
    const maxGap = close * 0.2;
    stop = side === 'long'
      ? clamp(stop, close - maxGap, close)
      : clamp(stop, close, close + maxGap);
  }

  const proposedStop = stop;
  if (previousStopPrice > 0) {
    stop = side === 'long'
      ? Math.max(previousStopPrice, proposedStop)
      : Math.min(previousStopPrice, proposedStop);
  }
  const breached = enabled
    && previousStopPrice > 0
    && close > 0
    && (
      side === 'long'
        ? close <= previousStopPrice
        : close >= previousStopPrice
    );

  return {
    enabled,
    shadowMode,
    method,
    side,
    close: round(close),
    atr: round(atr),
    stopPrice: round(stop),
    proposedStopPrice: round(proposedStop),
    previousStopPrice: previousStopPrice > 0 ? round(previousStopPrice) : null,
    breached,
    breachReasonCode: breached ? 'dynamic_trail_stop_breached' : null,
    reasonCode,
    inputs: {
      highestHigh: round(highestHigh),
      lowestLow: round(lowestLow),
      vwap: round(vwap),
      sar: round(sar),
      atrMultiplier: round(atrMul, 4),
      chandelierMultiplier: round(chandelierMul, 4),
    },
  };
}

export default {
  computeDynamicTrail,
};
