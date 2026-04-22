// @ts-nocheck
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import yaml from 'js-yaml';
import { getInvestmentTradeMode, isPaperMode } from './secrets.ts';
import { getMarketOrderRule } from './order-rules.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { createRuntimeConfigLoader, deepMerge } = require('../../../packages/core/lib/runtime-config-loader');

const KIS_ORDER_RULE = getMarketOrderRule('kis');
const KIS_OVERSEAS_ORDER_RULE = getMarketOrderRule('kis_overseas');
const BINANCE_ORDER_RULE = getMarketOrderRule('binance');

function loadCapitalManagementConfig() {
  try {
    const raw = yaml.load(readFileSync(join(__dirname, '..', 'config.yaml'), 'utf8'));
    return raw?.capital_management || {};
  } catch {
    return {};
  }
}

function loadRuntimeOverlayConfig() {
  try {
    const raw = yaml.load(readFileSync(join(__dirname, '..', 'config.yaml'), 'utf8')) || {};
    return deepMerge(
      {},
      raw?.capital_management?.runtime_config || {},
      raw?.runtime_config || {},
    );
  } catch {
    return {};
  }
}

function mergeRuntimeOverrideObjects(...sources) {
  const isPlainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
  const result = {};
  for (const source of sources) {
    if (!isPlainObject(source)) continue;
    for (const [key, value] of Object.entries(source)) {
      if (isPlainObject(value) && isPlainObject(result[key])) {
        result[key] = mergeRuntimeOverrideObjects(result[key], value);
      } else if (isPlainObject(value)) {
        result[key] = mergeRuntimeOverrideObjects({}, value);
      } else if (Array.isArray(value)) {
        result[key] = value.slice();
      } else {
        result[key] = value;
      }
    }
  }
  return result;
}

function getDefaultLunaMaxPosCount() {
  const capitalManagement = loadCapitalManagementConfig();
  const binanceMax = Number(capitalManagement.by_exchange?.binance?.max_concurrent_positions);
  if (Number.isFinite(binanceMax) && binanceMax > 0) return Math.round(binanceMax);
  const globalMax = Number(capitalManagement.max_concurrent_positions);
  if (Number.isFinite(globalMax) && globalMax > 0) return Math.round(globalMax);
  return 6;
}

export function getTimeProfiles() {
  const capitalManagement = loadCapitalManagementConfig();
  const tp = capitalManagement.time_profiles || {};

  return {
    ACTIVE: {
      maxPositionPct: Number(tp.active?.max_position_pct ?? 0.12),
      maxOpenPositions: Number(tp.active?.max_open_positions ?? 4),
      minSignalScore: Number(tp.active?.min_signal_score ?? 0.54),
      cycleSec: 1800,
      emergencyTrigger: true,
    },
    SLOWDOWN: {
      maxPositionPct: Number(tp.slowdown?.max_position_pct ?? 0.10),
      maxOpenPositions: Number(tp.slowdown?.max_open_positions ?? 3),
      minSignalScore: Number(tp.slowdown?.min_signal_score ?? 0.66),
      cycleSec: 3600,
      emergencyTrigger: true,
    },
    NIGHT_AUTO: {
      maxPositionPct: Number(tp.night?.max_position_pct ?? 0.06),
      maxOpenPositions: Number(tp.night?.max_open_positions ?? 1),
      minSignalScore: Number(tp.night?.min_signal_score ?? 0.74),
      cycleSec: 3600,
      emergencyTrigger: false,
    },
  };
}

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
    maxPosCount: getDefaultLunaMaxPosCount(),
    maxDebateSymbols: 2,
    dynamicDebateLimits: {
      cryptoLive: [
        { minSymbols: 20, limit: 4 },
        { minSymbols: 32, limit: 5 },
        { minSymbols: 48, limit: 6 },
      ],
    },
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
      kis: {
        buyDefault: 500000,
        sellDefault: 500000,
        min: KIS_ORDER_RULE?.minOrderAmount ?? 200000,
        max: KIS_ORDER_RULE?.maxOrderAmount ?? 1200000,
        currency: KIS_ORDER_RULE?.currency ?? 'KRW',
      },
      kis_overseas: {
        buyDefault: 400,
        sellDefault: 400,
        min: KIS_OVERSEAS_ORDER_RULE?.minOrderAmount ?? 200,
        max: KIS_OVERSEAS_ORDER_RULE?.maxOrderAmount ?? 1200,
        currency: KIS_OVERSEAS_ORDER_RULE?.currency ?? 'USD',
      },
    },
  },
  aria: {
    signalThresholds: {
      binance: 1.15,
      kis: 1.5,
      kis_overseas: 2.0,
    },
  },
  tools: {
    chartVision: {
      maxDailyCalls: 5,
    },
    argos: {
      intelCache: {
        ttlMs: 6 * 3600 * 1000,
        maxEntries: 500,
        externalWarnTtlMs: 6 * 3600 * 1000,
        redditCooldownTtlMs: 10 * 60 * 1000,
      },
    },
  },
  rag: {
    nodeArtifactSearch: {
      threshold: 0.65,
      defaultLimit: 5,
    },
    dailyFeedbackMemory: {
      episodicThreshold: 0.33,
      semanticThreshold: 0.28,
    },
    lunaTradeContext: {
      threshold: 0.7,
      limit: 3,
    },
    sweeperMemory: {
      episodicThreshold: 0.33,
      semanticThreshold: 0.28,
    },
    argosCandidateSearch: {
      threshold: 0.72,
      limit: 2,
    },
  },
  alerts: {
    marketAlertMemory: {
      episodicThreshold: 0.33,
      semanticThreshold: 0.28,
    },
  },
  liveEvidenceBaseline: {
    byExchange: {
      binance: '2026-04-17T06:08:43+09:00',
      kis: '2026-04-17T09:09:09+09:00',
      kis_overseas: '2026-04-17T09:09:09+09:00',
    },
  },
  reevaluation: {
    tradingViewFrames: {
      byExchange: {
        binance: ['1h', '4h', '1d'],
        kis: ['1h', '1d'],
        kis_overseas: ['1h', '4h', '1d'],
      },
      weightsByExchange: {
        binance: { '1h': 0.2, '4h': 0.35, '1d': 0.45 },
        kis: { '1h': 0.35, '1d': 0.65 },
        kis_overseas: { '1h': 0.2, '4h': 0.35, '1d': 0.45 },
      },
      thresholdsByExchange: {
        binance: { buy: 0.25, sell: -0.25 },
        kis: { buy: 0.2, sell: -0.2 },
        kis_overseas: { buy: 0.25, sell: -0.25 },
      },
    },
  },
  health: {
    tradeLaneNearLimitRatio: 0.8,
    cryptoValidationNearSoftCapRatio: 0.8,
  },
  sync: {
    cryptoMinNotionalUsdt: 10,
  },
  execution: {
    pendingQueue: {
      stalePendingMinutes: 30,
    },
    signalSafetySoftening: {
      enabled: false,
      byExchange: {},
    },
    cryptoGuardSoftening: {
      enabled: true,
      byExchange: {
        binance: {
          tradeModes: {
            normal: {
              enabled: true,
              circuitBreaker: {
                enabled: true,
                allowedTypes: ['loss_streak'],
                maxRemainingCooldownMinutes: 180,
                reductionMultiplier: 0.60,
              },
              correlationGuard: {
                enabled: true,
                allowOverflowSlots: 1,
                reductionMultiplier: 0.70,
              },
              validationFallback: {
                enabled: true,
                reductionMultiplier: 0.30,
                allowedGuardKinds: ['max_positions', 'daily_trade_limit'],
              },
            },
          },
        },
      },
    },
  },
  nemesis: {
    crypto: {
      maxSinglePositionPct: 0.12,
      maxDailyLossPct: 0.05,
      maxOpenPositions: 6,
      stopLossPct: 0.03,
      minOrderUsdt: BINANCE_ORDER_RULE?.minOrderAmount ?? 10,
      maxOrderUsdt: 1200,
    },
    stockDomestic: {
      maxSinglePositionPct: 0.12,
      maxDailyLossPct: 0.05,
      maxOpenPositions: 6,
      stopLossPct: 0.05,
      minOrderUsdt: KIS_ORDER_RULE?.minOrderAmount ?? 200000,
      maxOrderUsdt: 1200000,
    },
    stockOverseas: {
      maxSinglePositionPct: 0.12,
      maxDailyLossPct: 0.05,
      maxOpenPositions: 6,
      stopLossPct: 0.05,
      minOrderUsdt: KIS_OVERSEAS_ORDER_RULE?.minOrderAmount ?? 200,
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
  timeMode: getTimeProfiles(),
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
    return deepMerge(
      {},
      legacyCapitalRuntime || {},
      config.capital_management?.runtime_config || {},
      config.runtime_config || {},
    );
  },
}));

const { loadRuntimeConfig } = runtimeConfigLoader;

export function getInvestmentRuntimeConfig() {
  const runtimeConfig = deepMerge({}, loadRuntimeConfig(), loadRuntimeOverlayConfig());
  const lunaMaxPosCount = Number(runtimeConfig?.luna?.maxPosCount);
  if (Number.isFinite(lunaMaxPosCount) && lunaMaxPosCount > 0) return runtimeConfig;
  return deepMerge(runtimeConfig, {
    luna: {
      maxPosCount: getDefaultLunaMaxPosCount(),
    },
  });
}

export function isDynamicTpSlEnabled() {
  return getInvestmentRuntimeConfig().dynamicTpSlEnabled === true;
}

export function getLunaRuntimeConfig() {
  return getInvestmentRuntimeConfig().luna;
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
  return getInvestmentRuntimeConfig().nemesis;
}

export function getTimeModeRuntimeConfig() {
  return getInvestmentRuntimeConfig().timeMode;
}

export function getInvestmentLLMPolicyConfig() {
  return getInvestmentRuntimeConfig().llmPolicies || {};
}

export function getAriaRuntimeConfig() {
  return getInvestmentRuntimeConfig().aria || {};
}

export function getChartVisionRuntimeConfig() {
  return getInvestmentRuntimeConfig().tools?.chartVision || {};
}

export function getArgosRuntimeConfig() {
  const runtimeConfig = getInvestmentRuntimeConfig();
  return {
    rag: runtimeConfig?.rag?.argosCandidateSearch || {},
    intelCache: runtimeConfig?.tools?.argos?.intelCache || {},
  };
}

export function getInvestmentRagRuntimeConfig() {
  return getInvestmentRuntimeConfig().rag || {};
}

export function getInvestmentAlertRuntimeConfig() {
  return getInvestmentRuntimeConfig().alerts || {};
}

export function getExchangeEvidenceBaseline(exchange = '') {
  const raw = getInvestmentRuntimeConfig()?.liveEvidenceBaseline?.byExchange?.[exchange];
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

export function getPositionReevaluationRuntimeConfig() {
  return getInvestmentRuntimeConfig().reevaluation || {};
}

export function getInvestmentHealthRuntimeConfig() {
  return getInvestmentRuntimeConfig().health || {};
}

export function getInvestmentSyncRuntimeConfig() {
  return getInvestmentRuntimeConfig().sync || {};
}

export function getInvestmentExecutionRuntimeConfig() {
  const runtimeExecution = getInvestmentRuntimeConfig().execution || {};
  const overlayExecution = loadRuntimeOverlayConfig()?.execution || {};
  let rawExecution = {};
  try {
    const raw = yaml.load(readFileSync(join(__dirname, '..', 'config.yaml'), 'utf8')) || {};
    rawExecution = raw?.runtime_config?.execution || {};
  } catch {
    rawExecution = {};
  }
  return mergeRuntimeOverrideObjects(runtimeExecution, overlayExecution, rawExecution);
}
