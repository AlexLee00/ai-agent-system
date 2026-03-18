import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { isPaperMode } from './secrets.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_RUNTIME_CONFIG = {
  dynamicTpSlEnabled: true,
  luna: {
    minConfidence: {
      live: { binance: 0.50, kis: 0.30, kis_overseas: 0.30 },
      paper: { binance: 0.45, kis: 0.22, kis_overseas: 0.22 },
    },
    stockStrategyMode: {
      live: 'aggressive',
      paper: 'aggressive',
    },
    stockStrategyProfiles: {
      balanced: {
        label: 'balanced',
        promptTag: '균형 모드',
        minConfidence: { live: 0.30, paper: 0.22 },
        debateThresholds: {
          live: { minAverageConfidence: 0.62, minAbsScore: 0.40 },
          paper: { minAverageConfidence: 0.48, minAbsScore: 0.22 },
        },
        fastPathMinConfidence: 0.22,
        portfolioMaxPositionPct: 0.25,
        portfolioDailyLossPct: 0.08,
      },
      aggressive: {
        label: 'aggressive',
        promptTag: '공격적 모드',
        minConfidence: { live: 0.28, paper: 0.20 },
        debateThresholds: {
          live: { minAverageConfidence: 0.58, minAbsScore: 0.34 },
          paper: { minAverageConfidence: 0.44, minAbsScore: 0.18 },
        },
        fastPathMinConfidence: 0.20,
        portfolioMaxPositionPct: 0.30,
        portfolioDailyLossPct: 0.10,
      },
    },
    analystWeights: {
      default: { taMtf: 0.30, onchain: 0.25, sentiment: 0.20, news: 0.15 },
      crypto: { taMtf: 0.18, onchain: 0.34, sentiment: 0.18, news: 0.20 },
      stocksPaper: { taMtf: 0.20, onchain: 0.00, sentiment: 0.12, news: 0.32 },
      stocksLive: { taMtf: 0.26, onchain: 0.00, sentiment: 0.18, news: 0.22 },
    },
    maxPosCount: 6,
    maxDebateSymbols: 2,
    debateThresholds: {
      stocksPaper: { minAverageConfidence: 0.48, minAbsScore: 0.22 },
      stocksLive: { minAverageConfidence: 0.62, minAbsScore: 0.40 },
      crypto: { minAverageConfidence: 0.58, minAbsScore: 0.18 },
    },
    fastPathThresholds: {
      minAverageConfidence: 0.34,
      minAbsScore: 0.16,
      minStockConfidence: 0.22,
      minCryptoConfidence: 0.48,
    },
    stockOrderDefaults: {
      kis: { buyDefault: 500000, sellDefault: 500000, min: 200000, max: 1200000, currency: 'KRW' },
      kis_overseas: { buyDefault: 400, sellDefault: 400, min: 300, max: 1200, currency: 'USD' },
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
      minOrderUsdt: 200000,
      maxOrderUsdt: 1200000,
    },
    stockOverseas: {
      maxSinglePositionPct: 0.30,
      maxDailyLossPct: 0.10,
      maxOpenPositions: 6,
      stopLossPct: 0.05,
      minOrderUsdt: 300,
      maxOrderUsdt: 1200,
    },
    thresholds: {
      cryptoRejectConfidence: 0.50,
      stockRejectConfidence: 0.20,
      cryptoAdjustPct: 0.06,
      stockAutoApproveDomestic: 500000,
      stockAutoApproveOverseas: 400,
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
  llmPolicies: {
    investmentAgentPolicy: {
      openaiPerfModel: 'gpt-4o',
      openaiMiniModel: 'gpt-4o-mini',
      groqScoutModel: 'meta-llama/llama-4-scout-17b-16e-instruct',
      groqCompetitionModels: [
        'openai/gpt-oss-20b',
        'meta-llama/llama-4-scout-17b-16e-instruct',
      ],
      anthropicModel: 'claude-haiku-4-5-20251001',
      agentRoutes: {
        luna: 'openai_perf',
        nemesis: 'dual_groq',
        oracle: 'dual_groq',
        hermes: 'openai_mini',
        sophia: 'openai_mini',
        zeus: 'openai_mini',
        athena: 'openai_mini',
      },
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

export function getLunaStockStrategyProfile() {
  const luna = getLunaRuntimeConfig();
  const mode = luna.stockStrategyMode || {};
  const profiles = luna.stockStrategyProfiles || {};
  const selectedKey = (mode[isPaperMode() ? 'paper' : 'live'] || 'aggressive');
  return profiles[selectedKey] || profiles.aggressive || profiles.balanced || {
    label: 'aggressive',
    promptTag: '공격적 모드',
    minConfidence: { live: 0.30, paper: 0.22 },
    debateThresholds: {
      live: { minAverageConfidence: 0.62, minAbsScore: 0.40 },
      paper: { minAverageConfidence: 0.48, minAbsScore: 0.22 },
    },
    fastPathMinConfidence: 0.22,
    portfolioMaxPositionPct: 0.30,
    portfolioDailyLossPct: 0.10,
  };
}

export function getNemesisRuntimeConfig() {
  return loadRuntimeConfig().nemesis;
}

export function getTimeModeRuntimeConfig() {
  return loadRuntimeConfig().timeMode;
}

export function getInvestmentLLMPolicyConfig() {
  return loadRuntimeConfig().llmPolicies || {};
}
