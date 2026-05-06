// @ts-nocheck

function boolEnv(name, fallback = false) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function strEnv(name, fallback = '') {
  const raw = String(process.env[name] ?? '').trim();
  return raw || fallback;
}

function numEnv(name, fallback = 0) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? raw : fallback;
}

function listEnv(name, fallback = []) {
  const raw = String(process.env[name] ?? '').trim();
  if (!raw) return fallback;
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

export function getLunaIntelligentDiscoveryFlags() {
  const mode = strEnv('LUNA_INTELLIGENT_DISCOVERY_MODE', 'shadow').toLowerCase();
  const phases = {
    discoveryOrchestratorEnabled: boolEnv('LUNA_DISCOVERY_ORCHESTRATOR_ENABLED', false),
    newsSymbolMappingEnabled: boolEnv('LUNA_NEWS_SYMBOL_MAPPING_ENABLED', false),
    communitySentimentEnabled: boolEnv('LUNA_COMMUNITY_SENTIMENT_ENABLED', false),
    wyckoffDetectionEnabled: boolEnv('LUNA_WYCKOFF_DETECTION_ENABLED', false),
    vsaClassificationEnabled: boolEnv('LUNA_VSA_BAR_CLASSIFICATION', false),
    mtfAnalyzerEnabled: boolEnv('LUNA_MTF_ANALYZER_ENABLED', false),
    entryTriggerEnabled: boolEnv('LUNA_ENTRY_TRIGGER_ENGINE_ENABLED', false),
    scoreFusionEnabled: boolEnv('LUNA_DISCOVERY_SCORE_FUSION_ENABLED', false),
    reflectionEnabled: boolEnv('LUNA_DISCOVERY_REFLECTION_ENABLED', false),
    predictiveValidationEnabled: boolEnv('LUNA_PREDICTIVE_VALIDATION_ENABLED', false),
  };

  const gateMode = strEnv('LUNA_PREDICTIVE_VALIDATION_MODE', 'advisory').toLowerCase();
  const hardGate = gateMode === 'hard_gate' || gateMode === 'hard';
  const supervised = mode === 'supervised_l4' || mode === 'supervised';
  const autonomous = mode === 'autonomous_l5' || mode === 'autonomous';
  const shadow = mode === 'shadow';
  const liveFireEnabled = boolEnv('LUNA_LIVE_FIRE_ENABLED', false);
  const maxSymbols = Math.max(1, Math.round(numEnv('LUNA_INTELLIGENT_DISCOVERY_MAX_SYMBOLS', 60)));
  const discoveryTopDomestic = Math.max(1, Math.round(numEnv('LUNA_DISCOVERY_TOP_DOMESTIC', 100)));
  const discoveryTopOverseas = Math.max(1, Math.round(numEnv('LUNA_DISCOVERY_TOP_OVERSEAS', 100)));
  const discoveryTopCrypto   = Math.max(1, Math.round(numEnv('LUNA_DISCOVERY_TOP_CRYPTO', 50)));

  return {
    mode,
    shadow,
    supervised,
    autonomous,
    liveFireEnabled,
    phases,
    sourceSwitches: {
      discovery: {
        toss: boolEnv('LUNA_DISCOVERY_TOSS', true),
        dart: boolEnv('LUNA_DISCOVERY_DART', false),
        sec: boolEnv('LUNA_DISCOVERY_SEC', false),
        yahoo: boolEnv('LUNA_DISCOVERY_YAHOO', false),
        coingecko: boolEnv('LUNA_DISCOVERY_COINGECKO', true),
        xCashtag: boolEnv('LUNA_DISCOVERY_X_CASHTAG', false),
        reddit: boolEnv('LUNA_DISCOVERY_REDDIT', false),
        googleTrend: boolEnv('LUNA_DISCOVERY_GOOGLE_TREND', false),
      },
      community: {
        naverForum: boolEnv('LUNA_COMMUNITY_NAVER_FORUM', false),
        xCashtag: boolEnv('LUNA_COMMUNITY_X_CASHTAG', false),
        redditWsb: boolEnv('LUNA_COMMUNITY_REDDIT_WSB', false),
      },
    },
    predictive: {
      mode: shadow ? 'advisory' : hardGate ? 'hard_gate' : 'advisory',
      threshold: Math.max(0, Math.min(1, numEnv('LUNA_PREDICTIVE_VALIDATION_THRESHOLD', 0.55))),
      holdThreshold: Math.max(0, Math.min(1, numEnv('LUNA_PREDICTIVE_SCORE_HOLD_THRESHOLD', 0.40))),
      discardThreshold: Math.max(0, Math.min(1, numEnv('LUNA_PREDICTIVE_SCORE_DISCARD_THRESHOLD', 0.40))),
      observationLaneEnabled: boolEnv('LUNA_PREDICTIVE_OBSERVATION_LANE_ENABLED', true),
      observationThreshold: Math.max(0, Math.min(1, numEnv('LUNA_PREDICTIVE_OBSERVATION_THRESHOLD', numEnv('LUNA_PREDICTIVE_SCORE_HOLD_THRESHOLD', 0.40)))),
      observationSizeRatio: Math.max(0.05, Math.min(1, numEnv('LUNA_PREDICTIVE_OBSERVATION_SIZE_RATIO', 0.35))),
      requireComponents: boolEnv('LUNA_PREDICTIVE_REQUIRE_COMPONENTS', false),
      weights: {
        backtest: Math.max(0, numEnv('LUNA_PREDICTIVE_WEIGHT_BACKTEST', 0.30)),
        prediction: Math.max(0, numEnv('LUNA_PREDICTIVE_WEIGHT_PREDICTION', 0.30)),
        analyst: Math.max(0, numEnv('LUNA_PREDICTIVE_WEIGHT_ANALYST_ACCURACY', 0.20)),
        setupOutcome: Math.max(0, numEnv('LUNA_PREDICTIVE_WEIGHT_SETUP_OUTCOME', 0.20)),
      },
    },
    entryTrigger: {
      ttlMinutes: Math.max(5, Math.round(numEnv('LUNA_ENTRY_TRIGGER_TTL_MINUTES', 180))),
      minConfidence: Math.max(0, Math.min(1, numEnv('LUNA_ENTRY_TRIGGER_MIN_CONFIDENCE', 0.48))),
      fireCooldownMinutes: Math.max(1, Math.round(numEnv('LUNA_ENTRY_TRIGGER_FIRE_COOLDOWN_MINUTES', 10))),
      liveRiskGateEnabled: boolEnv('LUNA_ENTRY_TRIGGER_LIVE_RISK_GATE_ENABLED', true),
      requireLiveRiskContext: boolEnv('LUNA_ENTRY_TRIGGER_REQUIRE_LIVE_RISK_CONTEXT', true),
      requireCapitalActive: boolEnv('LUNA_ENTRY_TRIGGER_REQUIRE_CAPITAL_ACTIVE', true),
      minLiveConfidence: Math.max(0, Math.min(1, numEnv('LUNA_ENTRY_TRIGGER_MIN_LIVE_CONFIDENCE', 0.68))),
      minLivePredictiveScore: Math.max(0, Math.min(1, numEnv('LUNA_ENTRY_TRIGGER_MIN_LIVE_PREDICTIVE_SCORE', 0))),
      requirePredictiveScore: boolEnv('LUNA_ENTRY_TRIGGER_REQUIRE_PREDICTIVE_SCORE', false),
      minLiveAmountUsdt: Math.max(0, numEnv('LUNA_ENTRY_TRIGGER_MIN_LIVE_AMOUNT_USDT', 0)),
      fireInShadow: boolEnv('LUNA_ENTRY_TRIGGER_FIRE_IN_SHADOW', false),
      fireInSupervised: boolEnv('LUNA_ENTRY_TRIGGER_FIRE_IN_SUPERVISED', true),
      fireInAutonomous: boolEnv('LUNA_ENTRY_TRIGGER_FIRE_IN_AUTONOMOUS', true),
      mutateInShadow: boolEnv('LUNA_ENTRY_TRIGGER_SHADOW_BLOCKS_BUY', false),
      triggerTypes: listEnv('LUNA_ENTRY_TRIGGER_TYPES', [
        'breakout_confirmation',
        'pullback_to_support',
        'volume_burst',
        'mtf_alignment',
        'news_momentum',
      ]),
    },
    mtf: {
      timeframes: listEnv('LUNA_MTF_TIMEFRAMES', ['1m', '5m', '15m', '1h', '4h', '1d']),
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
