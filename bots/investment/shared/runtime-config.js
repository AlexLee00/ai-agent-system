import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_RUNTIME_CONFIG = {
  dynamicTpSlEnabled: true,
  luna: {
    minConfidence: {
      live: { binance: 0.50, kis: 0.30, kis_overseas: 0.30 },
      paper: { binance: 0.45, kis: 0.22, kis_overseas: 0.22 },
    },
    maxPosCount: 6,
    maxDebateSymbols: 2,
    debateThresholds: {
      stocksPaper: { minAverageConfidence: 0.55, minAbsScore: 0.35 },
      stocksLive: { minAverageConfidence: 0.62, minAbsScore: 0.40 },
      crypto: { minAverageConfidence: 0.64, minAbsScore: 0.32 },
    },
    fastPathThresholds: {
      minAverageConfidence: 0.42,
      minAbsScore: 0.25,
      minStockConfidence: 0.30,
    },
    stockOrderDefaults: {
      kis: { buyDefault: 300000, sellDefault: 300000, min: 100000, max: 1000000, currency: 'KRW' },
      kis_overseas: { buyDefault: 200, sellDefault: 200, min: 50, max: 1000, currency: 'USD' },
    },
  },
  nemesis: {
    crypto: {
      maxSinglePositionPct: 0.22,
      maxDailyLossPct: 0.05,
      maxOpenPositions: 6,
      stopLossPct: 0.03,
      minOrderUsdt: 10,
      maxOrderUsdt: 1200,
    },
    stockDomestic: {
      maxSinglePositionPct: 0.30,
      maxDailyLossPct: 0.10,
      maxOpenPositions: 6,
      stopLossPct: 0.05,
      minOrderUsdt: 100000,
      maxOrderUsdt: 1000000,
    },
    stockOverseas: {
      maxSinglePositionPct: 0.30,
      maxDailyLossPct: 0.10,
      maxOpenPositions: 6,
      stopLossPct: 0.05,
      minOrderUsdt: 50,
      maxOrderUsdt: 1000,
    },
    thresholds: {
      cryptoRejectConfidence: 0.50,
      stockRejectConfidence: 0.20,
      cryptoAdjustPct: 0.06,
      stockAutoApproveDomestic: 300000,
      stockAutoApproveOverseas: 300,
    },
  },
  timeMode: {
    ACTIVE: {
      maxPositionPct: 0.18,
      maxOpenPositions: 4,
      minSignalScore: 0.54,
      cycleSec: 1800,
      emergencyTrigger: true,
    },
    SLOWDOWN: {
      maxPositionPct: 0.10,
      maxOpenPositions: 3,
      minSignalScore: 0.66,
      cycleSec: 3600,
      emergencyTrigger: true,
    },
    NIGHT_AUTO: {
      maxPositionPct: 0.06,
      maxOpenPositions: 1,
      minSignalScore: 0.74,
      cycleSec: 3600,
      emergencyTrigger: false,
    },
  },
};

let cachedConfig = null;

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isObject(base) || !isObject(override)) return override ?? base;
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = isObject(value) && isObject(base[key])
      ? deepMerge(base[key], value)
      : value;
  }
  return merged;
}

function loadRuntimeConfig() {
  if (cachedConfig) return cachedConfig;
  try {
    const raw = yaml.load(readFileSync(join(__dirname, '..', 'config.yaml'), 'utf8')) || {};
    cachedConfig = deepMerge(DEFAULT_RUNTIME_CONFIG, raw.runtime_config || {});
    return cachedConfig;
  } catch {
    cachedConfig = { ...DEFAULT_RUNTIME_CONFIG };
    return cachedConfig;
  }
}

export function getInvestmentRuntimeConfig() {
  return loadRuntimeConfig();
}

export function isDynamicTpSlEnabled() {
  return loadRuntimeConfig().dynamicTpSlEnabled === true;
}

export function getLunaRuntimeConfig() {
  return loadRuntimeConfig().luna;
}

export function getNemesisRuntimeConfig() {
  return loadRuntimeConfig().nemesis;
}

export function getTimeModeRuntimeConfig() {
  return loadRuntimeConfig().timeMode;
}
