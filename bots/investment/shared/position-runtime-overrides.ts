// @ts-nocheck

import fs from 'node:fs';
import {
  investmentOpsLegacyFile,
  investmentOpsRuntimeFile,
} from './runtime-ops-path.ts';

export const POSITION_RUNTIME_OVERRIDE_FILENAME = 'position-runtime-overrides.json';
export const LEGACY_POSITION_RUNTIME_OVERRIDE_FILE = investmentOpsLegacyFile(POSITION_RUNTIME_OVERRIDE_FILENAME);
export const POSITION_RUNTIME_OVERRIDE_FILE = investmentOpsRuntimeFile(POSITION_RUNTIME_OVERRIDE_FILENAME);

export function overrideKeyForExchange(exchange) {
  if (exchange === 'binance') return 'position_watch_crypto_realtime_ms';
  if (exchange === 'kis') return 'position_watch_domestic_realtime_ms';
  if (exchange === 'kis_overseas') return 'position_watch_overseas_realtime_ms';
  return null;
}

export function loadPositionRuntimeOverrides() {
  try {
    const readFile = !fs.existsSync(POSITION_RUNTIME_OVERRIDE_FILE) && fs.existsSync(LEGACY_POSITION_RUNTIME_OVERRIDE_FILE)
      ? LEGACY_POSITION_RUNTIME_OVERRIDE_FILE
      : POSITION_RUNTIME_OVERRIDE_FILE;
    if (!fs.existsSync(readFile)) return {};
    return JSON.parse(fs.readFileSync(readFile, 'utf8')) || {};
  } catch {
    return {};
  }
}

export function resolvePositionRuntimeCadenceOverride(exchange, fallback = null) {
  const key = overrideKeyForExchange(exchange);
  if (!key) return fallback;
  const overrides = loadPositionRuntimeOverrides();
  const value = Number(overrides?.[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export default {
  POSITION_RUNTIME_OVERRIDE_FILENAME,
  LEGACY_POSITION_RUNTIME_OVERRIDE_FILE,
  POSITION_RUNTIME_OVERRIDE_FILE,
  loadPositionRuntimeOverrides,
  overrideKeyForExchange,
  resolvePositionRuntimeCadenceOverride,
};
