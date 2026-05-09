// @ts-nocheck

import { execFileSync } from 'node:child_process';

function readLaunchctlEnv(name) {
  try {
    return execFileSync('launchctl', ['getenv', name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    }).trim();
  } catch {
    return '';
  }
}

function buildRuntimeEnvReader(env = process.env) {
  const launchctlCache = new Map();
  const useLaunchctl = env === process.env;
  const processMode = String(env?.LUNA_INTELLIGENT_DISCOVERY_MODE ?? '').trim();
  const preferProcessEnv = env !== process.env
    || String(env?.LUNA_RUNTIME_ENV_SOURCE ?? '').trim().toLowerCase() === 'process'
    || Boolean(processMode);
  return (name) => {
    const processValue = String(env?.[name] ?? '').trim();
    if (preferProcessEnv) return processValue;
    if (useLaunchctl) {
      if (!launchctlCache.has(name)) launchctlCache.set(name, readLaunchctlEnv(name));
      const launchctlValue = launchctlCache.get(name) || '';
      if (launchctlValue) return launchctlValue;
    }
    return processValue;
  };
}

function boolEnv(name, fallback = false, readEnv = buildRuntimeEnvReader()) {
  const raw = String(readEnv(name) ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function strEnv(name, fallback = '', readEnv = buildRuntimeEnvReader()) {
  const raw = String(readEnv(name) ?? '').trim();
  return raw || fallback;
}

function numEnv(name, fallback = 0, readEnv = buildRuntimeEnvReader()) {
  const value = String(readEnv(name) ?? '').trim();
  if (!value) return fallback;
  const raw = Number(value);
  return Number.isFinite(raw) ? raw : fallback;
}

function listEnv(name, fallback = [], readEnv = buildRuntimeEnvReader()) {
  const raw = String(readEnv(name) ?? '').trim();
  if (!raw) return fallback;
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

export function getLunaIntelligentDiscoveryFlags({ env = process.env } = {}) {
  const readEnv = buildRuntimeEnvReader(env);
  const mode = strEnv('LUNA_INTELLIGENT_DISCOVERY_MODE', 'shadow', readEnv).toLowerCase();
  const phases = {
    discoveryOrchestratorEnabled: boolEnv('LUNA_DISCOVERY_ORCHESTRATOR_ENABLED', false, readEnv),
    newsSymbolMappingEnabled: boolEnv('LUNA_NEWS_SYMBOL_MAPPING_ENABLED', false, readEnv),
    communitySentimentEnabled: boolEnv('LUNA_COMMUNITY_SENTIMENT_ENABLED', false, readEnv),
    wyckoffDetectionEnabled: boolEnv('LUNA_WYCKOFF_DETECTION_ENABLED', false, readEnv),
    vsaClassificationEnabled: boolEnv('LUNA_VSA_BAR_CLASSIFICATION', false, readEnv),
    mtfAnalyzerEnabled: boolEnv('LUNA_MTF_ANALYZER_ENABLED', false, readEnv),
    entryTriggerEnabled: boolEnv('LUNA_ENTRY_TRIGGER_ENGINE_ENABLED', false, readEnv),
    scoreFusionEnabled: boolEnv('LUNA_DISCOVERY_SCORE_FUSION_ENABLED', false, readEnv),
    reflectionEnabled: boolEnv('LUNA_DISCOVERY_REFLECTION_ENABLED', false, readEnv),
    predictiveValidationEnabled: boolEnv('LUNA_PREDICTIVE_VALIDATION_ENABLED', false, readEnv),
  };

  const gateMode = strEnv('LUNA_PREDICTIVE_VALIDATION_MODE', 'advisory', readEnv).toLowerCase();
  const hardGate = gateMode === 'hard_gate' || gateMode === 'hard';
  const supervised = mode === 'supervised_l4' || mode === 'supervised';
  const autonomous = mode === 'autonomous_l5' || mode === 'autonomous';
  const shadow = mode === 'shadow';
  const liveFireEnabled = boolEnv('LUNA_LIVE_FIRE_ENABLED', false, readEnv);
  const maxSymbols = Math.max(1, Math.round(numEnv('LUNA_INTELLIGENT_DISCOVERY_MAX_SYMBOLS', 60, readEnv)));
  const discoveryTopDomestic = Math.max(1, Math.round(numEnv('LUNA_DISCOVERY_TOP_DOMESTIC', 100, readEnv)));
  const discoveryTopOverseas = Math.max(1, Math.round(numEnv('LUNA_DISCOVERY_TOP_OVERSEAS', 100, readEnv)));
  const discoveryTopCrypto   = Math.max(1, Math.round(numEnv('LUNA_DISCOVERY_TOP_CRYPTO', 50, readEnv)));

  return {
    mode,
    shadow,
    supervised,
    autonomous,
    liveFireEnabled,
    phases,
    sourceSwitches: {
      discovery: {
        toss: boolEnv('LUNA_DISCOVERY_TOSS', true, readEnv),
        dart: boolEnv('LUNA_DISCOVERY_DART', false, readEnv),
        sec: boolEnv('LUNA_DISCOVERY_SEC', false, readEnv),
        yahoo: boolEnv('LUNA_DISCOVERY_YAHOO', false, readEnv),
        coingecko: boolEnv('LUNA_DISCOVERY_COINGECKO', true, readEnv),
        xCashtag: boolEnv('LUNA_DISCOVERY_X_CASHTAG', false, readEnv),
        reddit: boolEnv('LUNA_DISCOVERY_REDDIT', false, readEnv),
        googleTrend: boolEnv('LUNA_DISCOVERY_GOOGLE_TREND', false, readEnv),
      },
      community: {
        naverForum: boolEnv('LUNA_COMMUNITY_NAVER_FORUM', false, readEnv),
        xCashtag: boolEnv('LUNA_COMMUNITY_X_CASHTAG', false, readEnv),
        redditWsb: boolEnv('LUNA_COMMUNITY_REDDIT_WSB', false, readEnv),
      },
    },
    predictive: {
      mode: shadow ? 'advisory' : hardGate ? 'hard_gate' : 'advisory',
      threshold: Math.max(0, Math.min(1, numEnv('LUNA_PREDICTIVE_VALIDATION_THRESHOLD', 0.55, readEnv))),
      holdThreshold: Math.max(0, Math.min(1, numEnv('LUNA_PREDICTIVE_SCORE_HOLD_THRESHOLD', 0.40, readEnv))),
      discardThreshold: Math.max(0, Math.min(1, numEnv('LUNA_PREDICTIVE_SCORE_DISCARD_THRESHOLD', 0.40, readEnv))),
      observationLaneEnabled: boolEnv('LUNA_PREDICTIVE_OBSERVATION_LANE_ENABLED', true, readEnv),
      observationThreshold: Math.max(0, Math.min(1, numEnv('LUNA_PREDICTIVE_OBSERVATION_THRESHOLD', numEnv('LUNA_PREDICTIVE_SCORE_HOLD_THRESHOLD', 0.40, readEnv), readEnv))),
      observationSizeRatio: Math.max(0.05, Math.min(1, numEnv('LUNA_PREDICTIVE_OBSERVATION_SIZE_RATIO', 0.35, readEnv))),
      requireComponents: boolEnv('LUNA_PREDICTIVE_REQUIRE_COMPONENTS', false, readEnv),
      weights: {
        backtest: Math.max(0, numEnv('LUNA_PREDICTIVE_WEIGHT_BACKTEST', 0.30, readEnv)),
        prediction: Math.max(0, numEnv('LUNA_PREDICTIVE_WEIGHT_PREDICTION', 0.30, readEnv)),
        analyst: Math.max(0, numEnv('LUNA_PREDICTIVE_WEIGHT_ANALYST_ACCURACY', 0.20, readEnv)),
        setupOutcome: Math.max(0, numEnv('LUNA_PREDICTIVE_WEIGHT_SETUP_OUTCOME', 0.20, readEnv)),
      },
    },
    entryTrigger: {
      ttlMinutes: Math.max(5, Math.round(numEnv('LUNA_ENTRY_TRIGGER_TTL_MINUTES', 180, readEnv))),
      minConfidence: Math.max(0, Math.min(1, numEnv('LUNA_ENTRY_TRIGGER_MIN_CONFIDENCE', 0.48, readEnv))),
      fireCooldownMinutes: Math.max(1, Math.round(numEnv('LUNA_ENTRY_TRIGGER_FIRE_COOLDOWN_MINUTES', 10, readEnv))),
      liveRiskGateEnabled: boolEnv('LUNA_ENTRY_TRIGGER_LIVE_RISK_GATE_ENABLED', true, readEnv),
      requireLiveRiskContext: boolEnv('LUNA_ENTRY_TRIGGER_REQUIRE_LIVE_RISK_CONTEXT', true, readEnv),
      requireCapitalActive: boolEnv('LUNA_ENTRY_TRIGGER_REQUIRE_CAPITAL_ACTIVE', true, readEnv),
      minLiveConfidence: Math.max(0, Math.min(1, numEnv('LUNA_ENTRY_TRIGGER_MIN_LIVE_CONFIDENCE', 0.68, readEnv))),
      minLivePredictiveScore: Math.max(0, Math.min(1, numEnv('LUNA_ENTRY_TRIGGER_MIN_LIVE_PREDICTIVE_SCORE', 0, readEnv))),
      requirePredictiveScore: boolEnv('LUNA_ENTRY_TRIGGER_REQUIRE_PREDICTIVE_SCORE', false, readEnv),
      minLiveAmountUsdt: Math.max(0, numEnv('LUNA_ENTRY_TRIGGER_MIN_LIVE_AMOUNT_USDT', 0, readEnv)),
      fireInShadow: boolEnv('LUNA_ENTRY_TRIGGER_FIRE_IN_SHADOW', false, readEnv),
      fireInSupervised: boolEnv('LUNA_ENTRY_TRIGGER_FIRE_IN_SUPERVISED', true, readEnv),
      fireInAutonomous: boolEnv('LUNA_ENTRY_TRIGGER_FIRE_IN_AUTONOMOUS', true, readEnv),
      mutateInShadow: boolEnv('LUNA_ENTRY_TRIGGER_SHADOW_BLOCKS_BUY', false, readEnv),
      triggerTypes: listEnv('LUNA_ENTRY_TRIGGER_TYPES', [
        'breakout_confirmation',
        'pullback_to_support',
        'volume_burst',
        'mtf_alignment',
        'news_momentum',
      ], readEnv),
    },
    mtf: {
      timeframes: listEnv('LUNA_MTF_TIMEFRAMES', ['1m', '5m', '15m', '1h', '4h', '1d'], readEnv),
    },
    discovery: {
      maxSymbols,
      topDomestic: discoveryTopDomestic,
      topOverseas: discoveryTopOverseas,
      topCrypto:   discoveryTopCrypto,
    },
    shouldAllowLiveEntryFire() {
      if (!phases.entryTriggerEnabled) return false;
      if (!liveFireEnabled) return false;
      if (autonomous) return this.entryTrigger.fireInAutonomous;
      if (supervised) return this.entryTrigger.fireInSupervised;
      return this.entryTrigger.fireInShadow;
    },
    shouldApplyDecisionMutation() {
      return !shadow;
    },
    shouldApplyScoreFusion() {
      return phases.scoreFusionEnabled && !shadow;
    },
    shouldEntryTriggerMutate() {
      return phases.entryTriggerEnabled && (!shadow || this.entryTrigger.mutateInShadow);
    },
  };
}

export default getLunaIntelligentDiscoveryFlags;
