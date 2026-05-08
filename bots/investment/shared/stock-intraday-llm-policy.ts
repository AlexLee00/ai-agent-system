// @ts-nocheck

import { evaluateConservativeRelaxation } from './luna-conservative-relaxation-policy.ts';

export const STOCK_INTRADAY_LIGHT_COLLECT_NODES = Object.freeze(['L06', 'L02', 'L04']);
export const CRYPTO_INTRADAY_LIGHT_COLLECT_NODES = Object.freeze(['L06', 'L02']);
const DEFAULT_DECISION_PREFILTER_CONFIDENCE = 0.55;
const DEFAULT_STOCK_TA_PREFILTER_CONFIDENCE = 0.35;
const DEFAULT_STOCK_FLOW_PREFILTER_CONFIDENCE = 0.35;
const DEFAULT_STOCK_NARRATIVE_PREFILTER_CONFIDENCE = 0.6;
const DEFAULT_CRYPTO_TA_PREFILTER_CONFIDENCE = 0.3;
const DEFAULT_CRYPTO_FLOW_PREFILTER_CONFIDENCE = 0.55;

function envFlag(env, key, fallback = false) {
  const value = env?.[key];
  if (value == null || value === '') return fallback;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(text)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(text)) return false;
  return fallback;
}

export function isStockMarket(market) {
  return market === 'kis' || market === 'kis_overseas';
}

export function isCryptoMarket(market) {
  return market === 'binance' || market === 'crypto';
}

export function isStockIntradayEnrichmentEnabled(env = process.env) {
  return envFlag(env, 'LUNA_STOCK_INTRADAY_ENRICHMENT_ENABLED', false);
}

export function isCryptoIntradayEnrichmentEnabled(env = process.env) {
  return envFlag(env, 'LUNA_CRYPTO_INTRADAY_ENRICHMENT_ENABLED', false);
}

export function isStockIntradayDebateEnabled(env = process.env) {
  return envFlag(env, 'LUNA_STOCK_INTRADAY_DEBATE_ENABLED', false);
}

export function isStockIntradayDecisionPrefilterEnabled(env = process.env) {
  return envFlag(env, 'LUNA_STOCK_INTRADAY_DECISION_PREFILTER_ENABLED', true);
}

export function isCryptoIntradayDecisionPrefilterEnabled(env = process.env) {
  return envFlag(env, 'LUNA_CRYPTO_INTRADAY_DECISION_PREFILTER_ENABLED', true);
}

export function getStockIntradayDecisionPrefilterConfidence(env = process.env) {
  const raw = Number(env?.LUNA_STOCK_INTRADAY_DECISION_PREFILTER_CONFIDENCE);
  if (Number.isFinite(raw) && raw > 0 && raw <= 1) return raw;
  return DEFAULT_DECISION_PREFILTER_CONFIDENCE;
}

export function getStockTaDecisionPrefilterConfidence(env = process.env) {
  const raw = Number(env?.LUNA_STOCK_TA_DECISION_PREFILTER_CONFIDENCE);
  if (Number.isFinite(raw) && raw > 0 && raw <= 1) return raw;
  return DEFAULT_STOCK_TA_PREFILTER_CONFIDENCE;
}

export function getStockFlowDecisionPrefilterConfidence(env = process.env) {
  const raw = Number(env?.LUNA_STOCK_FLOW_DECISION_PREFILTER_CONFIDENCE);
  if (Number.isFinite(raw) && raw > 0 && raw <= 1) return raw;
  return DEFAULT_STOCK_FLOW_PREFILTER_CONFIDENCE;
}

export function getStockNarrativeDecisionPrefilterConfidence(env = process.env) {
  const raw = Number(env?.LUNA_STOCK_NARRATIVE_DECISION_PREFILTER_CONFIDENCE);
  if (Number.isFinite(raw) && raw > 0 && raw <= 1) return raw;
  return DEFAULT_STOCK_NARRATIVE_PREFILTER_CONFIDENCE;
}

export function getCryptoTaDecisionPrefilterConfidence(env = process.env) {
  const raw = Number(env?.LUNA_CRYPTO_TA_DECISION_PREFILTER_CONFIDENCE);
  if (Number.isFinite(raw) && raw > 0 && raw <= 1) return raw;
  return DEFAULT_CRYPTO_TA_PREFILTER_CONFIDENCE;
}

export function getCryptoFlowDecisionPrefilterConfidence(env = process.env) {
  const raw = Number(env?.LUNA_CRYPTO_FLOW_DECISION_PREFILTER_CONFIDENCE);
  if (Number.isFinite(raw) && raw > 0 && raw <= 1) return raw;
  return DEFAULT_CRYPTO_FLOW_PREFILTER_CONFIDENCE;
}

function normalizeAnalystName(value) {
  return String(value || '').trim().toLowerCase();
}

function isActionableSignal(row) {
  const signal = String(row?.signal || '').trim().toUpperCase();
  return signal === 'BUY' || signal === 'SELL';
}

function stockAnalystRole(row) {
  const analyst = normalizeAnalystName(row?.analyst || row?.metadata?.analyst || row?.source);
  if (['ta', 'ta_mtf', 'technical', 'multi_timeframe', 'mtf'].some((key) => analyst.includes(key))) return 'technical';
  if (['market_flow', 'flow', 'orderbook', 'momentum'].some((key) => analyst.includes(key))) return 'flow';
  if (['sentiment', 'news', 'sentinel', 'hermes', 'sophia'].some((key) => analyst.includes(key))) return 'narrative';
  return 'other';
}

function cryptoAnalystRole(row) {
  const analyst = normalizeAnalystName(row?.analyst || row?.metadata?.analyst || row?.source);
  if (['ta', 'ta_mtf', 'technical', 'multi_timeframe', 'mtf'].some((key) => analyst.includes(key))) return 'technical';
  if (['onchain', 'market_flow', 'flow', 'orderbook', 'funding'].some((key) => analyst.includes(key))) return 'flow';
  if (['sentiment', 'news', 'hermes', 'sophia'].some((key) => analyst.includes(key))) return 'narrative';
  return 'other';
}

function findCryptoActionablePresignal(analyses = [], env = process.env) {
  const taThreshold = getCryptoTaDecisionPrefilterConfidence(env);
  const flowThreshold = getCryptoFlowDecisionPrefilterConfidence(env);
  const technical = [];
  const flow = [];

  for (const row of analyses || []) {
    if (!isActionableSignal(row)) continue;
    const confidence = Number(row?.confidence || 0);
    const role = cryptoAnalystRole(row);
    if (role === 'technical' && confidence >= taThreshold) {
      technical.push({ row, confidence });
    } else if (role === 'flow' && confidence >= flowThreshold) {
      flow.push({ row, confidence });
    }
  }

  technical.sort((a, b) => b.confidence - a.confidence);
  flow.sort((a, b) => b.confidence - a.confidence);
  const bestTechnical = technical[0] || null;
  const bestFlow = flow[0] || null;
  if (!bestTechnical) return { run: false, reason: 'crypto_intraday_no_technical_presignal', taThreshold, flowThreshold };
  if (!bestFlow) return { run: false, reason: 'crypto_intraday_no_flow_presignal', taThreshold, flowThreshold };

  return {
    run: true,
    reason: 'crypto_actionable_ta_flow_presignal',
    taThreshold,
    flowThreshold,
    technical: {
      analyst: bestTechnical.row?.analyst || null,
      signal: bestTechnical.row?.signal || null,
      confidence: bestTechnical.confidence,
    },
    flow: {
      analyst: bestFlow.row?.analyst || null,
      signal: bestFlow.row?.signal || null,
      confidence: bestFlow.confidence,
    },
  };
}

function findRelaxedPresignal(market, analyses = [], env = process.env) {
  const relaxation = evaluateConservativeRelaxation({
    exchange: market,
    analyses,
    env,
  });
  if (!relaxation.ok) return null;
  return {
    run: true,
    reason: relaxation.reason,
    threshold: null,
    relaxation,
  };
}

function findStockActionablePresignal(analyses = [], env = process.env) {
  const taThreshold = getStockTaDecisionPrefilterConfidence(env);
  const flowThreshold = getStockFlowDecisionPrefilterConfidence(env);
  const narrativeThreshold = getStockNarrativeDecisionPrefilterConfidence(env);
  const technical = [];
  const support = [];
  const sellConflicts = [];

  for (const row of analyses || []) {
    if (!isActionableSignal(row)) continue;
    const signal = String(row?.signal || '').trim().toUpperCase();
    const confidence = Number(row?.confidence || 0);
    const role = stockAnalystRole(row);
    if (signal === 'SELL' && (role === 'technical' || role === 'flow')) {
      sellConflicts.push({ row, confidence, role });
      continue;
    }
    if (signal !== 'BUY') continue;
    if (role === 'technical' && confidence >= taThreshold) {
      technical.push({ row, confidence, role });
    } else if (role === 'flow' && confidence >= flowThreshold) {
      support.push({ row, confidence, role });
    } else if (role === 'narrative' && confidence >= narrativeThreshold) {
      support.push({ row, confidence, role });
    }
  }

  technical.sort((a, b) => b.confidence - a.confidence);
  support.sort((a, b) => b.confidence - a.confidence);
  const bestTechnical = technical[0] || null;
  const bestSupport = support[0] || null;
  if (sellConflicts.length > 0) {
    return { run: false, reason: 'stock_intraday_sell_conflict', taThreshold, flowThreshold, narrativeThreshold };
  }
  if (!bestTechnical || !bestSupport) {
    return { run: false, reason: 'stock_intraday_no_actionable_presignal', taThreshold, flowThreshold, narrativeThreshold };
  }

  return {
    run: true,
    reason: 'actionable_presignal',
    taThreshold,
    flowThreshold,
    narrativeThreshold,
    technical: {
      analyst: bestTechnical.row?.analyst || null,
      signal: bestTechnical.row?.signal || null,
      confidence: bestTechnical.confidence,
    },
    support: {
      analyst: bestSupport.row?.analyst || null,
      signal: bestSupport.row?.signal || null,
      confidence: bestSupport.confidence,
      role: bestSupport.role,
    },
  };
}

export function shouldRunStockIntradayDecisionLlm({
  market,
  symbol = null,
  analyses = [],
  meta = {},
  liveHeldSymbols = null,
  env = process.env,
} = {}) {
  if (isCryptoMarket(market)) {
    if (!isCryptoIntradayDecisionPrefilterEnabled(env)) return { run: true, reason: 'crypto_prefilter_disabled' };
    if (liveHeldSymbols?.has?.(String(symbol || '').trim())) return { run: true, reason: 'held_symbol' };
    const strictCrypto = findCryptoActionablePresignal(analyses, env);
    return strictCrypto.run ? strictCrypto : (findRelaxedPresignal(market, analyses, env) || strictCrypto);
  }
  if (!isStockMarket(market)) return { run: true, reason: 'non_stock_market' };
  if (!isStockIntradayDecisionPrefilterEnabled(env)) return { run: true, reason: 'prefilter_disabled' };
  if (meta?.llm_call_policy?.source_enrichment === 'intraday_enabled') return { run: true, reason: 'full_intraday_llm_enabled' };
  if (liveHeldSymbols?.has?.(String(symbol || '').trim())) return { run: true, reason: 'held_symbol' };

  const threshold = getStockIntradayDecisionPrefilterConfidence(env);
  const actionable = (analyses || []).find((row) => {
    const signal = String(row?.signal || '').trim().toUpperCase();
    const confidence = Number(row?.confidence || 0);
    return confidence >= threshold && (signal === 'BUY' || signal === 'SELL');
  });

  if (actionable) {
    return {
      run: true,
      reason: 'actionable_presignal',
      threshold,
      analyst: actionable.analyst || null,
      signal: actionable.signal || null,
      confidence: Number(actionable.confidence || 0),
    };
  }

  const composite = findStockActionablePresignal(analyses, env);
  if (composite.run) {
    return {
      ...composite,
      threshold,
    };
  }

  const relaxed = findRelaxedPresignal(market, analyses, env);
  if (relaxed) {
    return {
      ...relaxed,
      threshold,
    };
  }

  return {
    run: false,
    reason: composite.reason || 'stock_intraday_no_actionable_presignal',
    threshold,
  };
}

export function buildStockIntradayLlmPolicyMeta({
  market,
  marketScript,
  collectMode = 'screening_with_maintenance',
  lightCollectMode = 'intraday_monitoring_light',
  env = process.env,
  extraMeta = {},
} = {}) {
  if (isCryptoMarket(market)) {
    const enrichmentEnabled = isCryptoIntradayEnrichmentEnabled(env);
    return {
      ...(extraMeta || {}),
      market_script: marketScript || extraMeta?.market_script || null,
      collect_mode: enrichmentEnabled ? collectMode : lightCollectMode,
      agentPlan: {
        ...(extraMeta?.agentPlan || {}),
        ...(!enrichmentEnabled ? {
          collect: {
            ...(extraMeta?.agentPlan?.collect || {}),
            nodeIds: [...CRYPTO_INTRADAY_LIGHT_COLLECT_NODES],
          },
        } : {}),
      },
      llm_call_policy: {
        ...(extraMeta?.llm_call_policy || {}),
        source_enrichment: enrichmentEnabled ? 'intraday_enabled' : 'technical_first_only',
        light_collect_nodes: enrichmentEnabled ? null : [...CRYPTO_INTRADAY_LIGHT_COLLECT_NODES],
      },
    };
  }

  if (!isStockMarket(market)) {
    return {
      ...(extraMeta || {}),
      market_script: marketScript || extraMeta?.market_script || null,
      collect_mode: collectMode,
    };
  }

  const enrichmentEnabled = isStockIntradayEnrichmentEnabled(env);
  const debateEnabled = isStockIntradayDebateEnabled(env);
  const agentPlan = {
    ...(extraMeta?.agentPlan || {}),
    ...(!enrichmentEnabled ? {
      collect: {
        ...(extraMeta?.agentPlan?.collect || {}),
        nodeIds: [...STOCK_INTRADAY_LIGHT_COLLECT_NODES],
      },
    } : {}),
    ...(!debateEnabled ? {
      decision: {
        ...(extraMeta?.agentPlan?.decision || {}),
        debate: {
          ...(extraMeta?.agentPlan?.decision?.debate || {}),
          enabled: false,
          limit: 0,
        },
      },
    } : {}),
  };

  return {
    ...(extraMeta || {}),
    market_script: marketScript || extraMeta?.market_script || null,
    collect_mode: enrichmentEnabled ? collectMode : lightCollectMode,
    agentPlan,
    llm_call_policy: {
      ...(extraMeta?.llm_call_policy || {}),
      source_enrichment: enrichmentEnabled ? 'intraday_enabled' : 'pre_market_or_research_only',
      debate: debateEnabled ? 'intraday_enabled' : 'pre_market_or_research_only',
      light_collect_nodes: enrichmentEnabled ? null : [...STOCK_INTRADAY_LIGHT_COLLECT_NODES],
    },
  };
}

export function buildStockResearchLlmPolicyMeta({
  market,
  marketScript,
  env = process.env,
  extraMeta = {},
} = {}) {
  return buildStockIntradayLlmPolicyMeta({
    market,
    marketScript,
    collectMode: 'off_hours_research_full',
    lightCollectMode: 'off_hours_research_light',
    env,
    extraMeta: {
      research_only: true,
      ...(extraMeta || {}),
    },
  });
}

export default {
  STOCK_INTRADAY_LIGHT_COLLECT_NODES,
  CRYPTO_INTRADAY_LIGHT_COLLECT_NODES,
  isStockMarket,
  isCryptoMarket,
  isStockIntradayEnrichmentEnabled,
  isCryptoIntradayEnrichmentEnabled,
  isStockIntradayDebateEnabled,
  isStockIntradayDecisionPrefilterEnabled,
  isCryptoIntradayDecisionPrefilterEnabled,
  getStockIntradayDecisionPrefilterConfidence,
  getStockTaDecisionPrefilterConfidence,
  getStockFlowDecisionPrefilterConfidence,
  getStockNarrativeDecisionPrefilterConfidence,
  getCryptoTaDecisionPrefilterConfidence,
  getCryptoFlowDecisionPrefilterConfidence,
  shouldRunStockIntradayDecisionLlm,
  buildStockIntradayLlmPolicyMeta,
  buildStockResearchLlmPolicyMeta,
};
