import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import yaml from 'js-yaml';
import { getInvestmentTradeMode, isPaperMode } from './secrets.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { createRuntimeConfigLoader, deepMerge } = require('../../../packages/core/lib/runtime-config-loader');

/** @typedef {typeof DEFAULT_RUNTIME_CONFIG} InvestmentRuntimeConfig */

const DEFAULT_RUNTIME_CONFIG = {
  dynamicTpSlEnabled: true,
  luna: {
    signalDedupeWindowMinutes: 180,
    mockUntradableSymbolCooldownMinutes: 1440,
    validationSoftBudget: {
      binance: {
        enabled: true,
        reserveDailyBuySlots: 2,
      },
    },
    sameDaySymbolReentryBlockEnabled: true,
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
      useSharedFallbackEngine: true,
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
        scout: 'groq_scout',
      },
    },
  },
};

const runtimeConfigLoader =
  /** @type {{ loadRuntimeConfig: () => InvestmentRuntimeConfig }} */ (createRuntimeConfigLoader({
  fs: {
    readFileSync:
      /**
       * @param {string} filePath
       * @param {string} _encoding
       */
      (filePath, _encoding) => readFileSync(filePath, 'utf8'),
  },
  defaults: DEFAULT_RUNTIME_CONFIG,
  configPath: join(__dirname, '..', 'config.yaml'),
  format: 'yaml',
  extractRuntimeConfig: (raw) => {
    const config = /** @type {{ runtime_config?: object, capital_management?: any }} */ (raw || {});
    const legacyCapitalRuntime = config.capital_management && (
      config.capital_management.dynamicTpSlEnabled !== undefined ||
      config.capital_management.luna ||
      config.capital_management.nemesis ||
      config.capital_management.timeMode ||
      config.capital_management.llmPolicies
    )
      ? {
          dynamicTpSlEnabled: config.capital_management.dynamicTpSlEnabled,
          luna: config.capital_management.luna,
          nemesis: config.capital_management.nemesis,
          timeMode: config.capital_management.timeMode,
          llmPolicies: config.capital_management.llmPolicies,
        }
      : {};
    return config.runtime_config || config.capital_management?.runtime_config || legacyCapitalRuntime || {};
  },
}));

const { loadRuntimeConfig } = runtimeConfigLoader;

export function getInvestmentRuntimeConfig() {
  return loadRuntimeConfig();
}

export function isDynamicTpSlEnabled() {
  return loadRuntimeConfig().dynamicTpSlEnabled === true;
}

export function getLunaRuntimeConfig() {
  return loadRuntimeConfig().luna;
}

export function getSignalDedupeWindowMinutes() {
  const raw = Number(getLunaRuntimeConfig()?.signalDedupeWindowMinutes);
  if (Number.isFinite(raw) && raw > 0) return Math.round(raw);
  return 180;
}

export function getMockUntradableSymbolCooldownMinutes() {
  const raw = Number(getLunaRuntimeConfig()?.mockUntradableSymbolCooldownMinutes);
  if (Number.isFinite(raw) && raw > 0) return Math.round(raw);
  return 1440;
}

export function getValidationSoftBudgetConfig(exchange = 'binance') {
  const luna = getLunaRuntimeConfig();
  const override = luna?.validationSoftBudget?.[exchange] || {};
  const enabled = override.enabled !== false;
  const reserveDailyBuySlots = Number(override.reserveDailyBuySlots ?? 2);
  return {
    enabled,
    reserveDailyBuySlots: Number.isFinite(reserveDailyBuySlots) && reserveDailyBuySlots > 0
      ? Math.round(reserveDailyBuySlots)
      : 0,
  };
}

export function isSameDaySymbolReentryBlockEnabled() {
  return getLunaRuntimeConfig()?.sameDaySymbolReentryBlockEnabled !== false;
}

export function getLunaStockStrategyProfile() {
  const luna = getLunaRuntimeConfig();
  const mode = /** @type {Record<string, string>} */ (luna.stockStrategyMode || {});
  const profiles = /** @type {Record<string, any>} */ (luna.stockStrategyProfiles || {});
  const selectedKey = (mode[isPaperMode() ? 'paper' : 'live'] || 'aggressive');
  const selectedProfile = profiles[selectedKey] || profiles.aggressive || profiles.balanced || {
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
  const tradeMode = getInvestmentTradeMode();
  const tradeModeOverride = selectedProfile.tradeModes?.[tradeMode] || {};
  return deepMerge(selectedProfile, tradeModeOverride);
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
