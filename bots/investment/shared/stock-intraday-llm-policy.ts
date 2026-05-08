// @ts-nocheck

export const STOCK_INTRADAY_LIGHT_COLLECT_NODES = Object.freeze(['L06', 'L02', 'L04']);
const DEFAULT_DECISION_PREFILTER_CONFIDENCE = 0.55;

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

export function isStockIntradayEnrichmentEnabled(env = process.env) {
  return envFlag(env, 'LUNA_STOCK_INTRADAY_ENRICHMENT_ENABLED', false);
}

export function isStockIntradayDebateEnabled(env = process.env) {
  return envFlag(env, 'LUNA_STOCK_INTRADAY_DEBATE_ENABLED', false);
}

export function isStockIntradayDecisionPrefilterEnabled(env = process.env) {
  return envFlag(env, 'LUNA_STOCK_INTRADAY_DECISION_PREFILTER_ENABLED', true);
}

export function getStockIntradayDecisionPrefilterConfidence(env = process.env) {
  const raw = Number(env?.LUNA_STOCK_INTRADAY_DECISION_PREFILTER_CONFIDENCE);
  if (Number.isFinite(raw) && raw > 0 && raw <= 1) return raw;
  return DEFAULT_DECISION_PREFILTER_CONFIDENCE;
}

export function shouldRunStockIntradayDecisionLlm({
  market,
  symbol = null,
  analyses = [],
  meta = {},
  liveHeldSymbols = null,
  env = process.env,
} = {}) {
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

  return {
    run: false,
    reason: 'stock_intraday_no_actionable_presignal',
    threshold,
  };
}

export function buildStockIntradayLlmPolicyMeta({
  market,
  marketScript,
  collectMode = 'screening_with_maintenance',
  env = process.env,
  extraMeta = {},
} = {}) {
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
    collect_mode: enrichmentEnabled ? collectMode : 'intraday_monitoring_light',
    agentPlan,
    llm_call_policy: {
      ...(extraMeta?.llm_call_policy || {}),
      source_enrichment: enrichmentEnabled ? 'intraday_enabled' : 'pre_market_or_research_only',
      debate: debateEnabled ? 'intraday_enabled' : 'pre_market_or_research_only',
      light_collect_nodes: enrichmentEnabled ? null : [...STOCK_INTRADAY_LIGHT_COLLECT_NODES],
    },
  };
}

export default {
  STOCK_INTRADAY_LIGHT_COLLECT_NODES,
  isStockMarket,
  isStockIntradayEnrichmentEnabled,
  isStockIntradayDebateEnabled,
  isStockIntradayDecisionPrefilterEnabled,
  getStockIntradayDecisionPrefilterConfidence,
  shouldRunStockIntradayDecisionLlm,
  buildStockIntradayLlmPolicyMeta,
};
