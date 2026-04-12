// @ts-nocheck
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_RESEARCH_DEPTH = {
  default: 2,
  by_regime: {
    trending_bull: 2,
    trending_bear: 2,
    ranging: 1,
    volatile: 3,
  },
  volatility_thresholds: {
    low_atr_ratio: 0.015,
    high_atr_ratio: 0.04,
  },
  overrides: {
    high_conviction: 3,
    capital_guard: 1,
    validation: 2,
  },
};

function loadResearchDepthConfig() {
  try {
    const raw = yaml.load(readFileSync(join(__dirname, '..', 'config.yaml'), 'utf8'));
    return raw?.research_depth || {};
  } catch {
    return {};
  }
}

function normalizeDepth(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.min(3, Math.round(numeric)));
}

export function getResearchDepthConfig() {
  const config = loadResearchDepthConfig();
  return {
    default: normalizeDepth(config.default, DEFAULT_RESEARCH_DEPTH.default),
    by_regime: {
      trending_bull: normalizeDepth(config.by_regime?.trending_bull, DEFAULT_RESEARCH_DEPTH.by_regime.trending_bull),
      trending_bear: normalizeDepth(config.by_regime?.trending_bear, DEFAULT_RESEARCH_DEPTH.by_regime.trending_bear),
      ranging: normalizeDepth(config.by_regime?.ranging, DEFAULT_RESEARCH_DEPTH.by_regime.ranging),
      volatile: normalizeDepth(config.by_regime?.volatile, DEFAULT_RESEARCH_DEPTH.by_regime.volatile),
    },
    volatility_thresholds: {
      low_atr_ratio: Number(config.volatility_thresholds?.low_atr_ratio ?? DEFAULT_RESEARCH_DEPTH.volatility_thresholds.low_atr_ratio),
      high_atr_ratio: Number(config.volatility_thresholds?.high_atr_ratio ?? DEFAULT_RESEARCH_DEPTH.volatility_thresholds.high_atr_ratio),
    },
    overrides: {
      high_conviction: normalizeDepth(config.overrides?.high_conviction, DEFAULT_RESEARCH_DEPTH.overrides.high_conviction),
      capital_guard: normalizeDepth(config.overrides?.capital_guard, DEFAULT_RESEARCH_DEPTH.overrides.capital_guard),
      validation: normalizeDepth(config.overrides?.validation, DEFAULT_RESEARCH_DEPTH.overrides.validation),
    },
  };
}

export function resolveResearchDepth({
  regime = null,
  atrRatio = null,
  tradeMode = 'normal',
  highConviction = false,
  capitalGuardTight = false,
} = {}) {
  const config = getResearchDepthConfig();

  if (capitalGuardTight) return config.overrides.capital_guard;
  if (highConviction) return config.overrides.high_conviction;
  if (String(tradeMode || '').toLowerCase() === 'validation') return config.overrides.validation;

  const numericAtrRatio =
    atrRatio === null || atrRatio === undefined || atrRatio === ''
      ? Number.NaN
      : Number(atrRatio);
  if (Number.isFinite(numericAtrRatio)) {
    if (numericAtrRatio >= config.volatility_thresholds.high_atr_ratio) {
      return config.by_regime.volatile;
    }
    if (numericAtrRatio <= config.volatility_thresholds.low_atr_ratio) {
      return config.by_regime.ranging;
    }
  }

  const regimeKey = String(regime || '').toLowerCase();
  return config.by_regime[regimeKey] || config.default;
}
