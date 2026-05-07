// @ts-nocheck

export const DEFAULT_COLLECT_NODE_SETS = Object.freeze({
  binance: ['L06', 'L02', 'L03', 'L05'],
  kis: ['L06', 'L02', 'L03', 'L04'],
  kis_overseas: ['L06', 'L02', 'L03', 'L04'],
});

export const DEFAULT_COLLECT_CONCURRENCY_LIMIT = Object.freeze({
  binance: 6,
  kis: 5,
  kis_overseas: 5,
});

const SUPPORTED_COLLECT_NODES_BY_MARKET = Object.freeze({
  binance: new Set(['L06', 'L02', 'L03', 'L05']),
  kis: new Set(['L06', 'L02', 'L03', 'L04']),
  kis_overseas: new Set(['L06', 'L02', 'L03', 'L04']),
});

const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 8;

function normalizeNodeIds(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,\s]+/g)
      : [];
  const seen = new Set();
  const normalized = [];
  for (const item of raw) {
    const nodeId = String(item || '').trim().toUpperCase();
    if (!/^L\d{2}$/u.test(nodeId) || seen.has(nodeId)) continue;
    seen.add(nodeId);
    normalized.push(nodeId);
  }
  return normalized;
}

function findFirstDefined(candidates = []) {
  for (const candidate of candidates) {
    if (candidate != null) return candidate;
  }
  return undefined;
}

function extractCollectNodeOverride(meta = {}) {
  return findFirstDefined([
    meta?.agentPlan?.collectNodeIds,
    meta?.agentPlan?.collect?.nodeIds,
    meta?.agentPlan?.collect?.nodes,
    meta?.agent_plan?.collect_node_ids,
    meta?.agent_plan?.collect?.node_ids,
    meta?.agent_plan?.collect?.nodes,
    meta?.collectNodeIds,
    meta?.collect_node_ids,
  ]);
}

function extractConcurrencyOverride(meta = {}) {
  return findFirstDefined([
    meta?.agentPlan?.collectConcurrencyLimit,
    meta?.agentPlan?.collect?.concurrencyLimit,
    meta?.agent_plan?.collect_concurrency_limit,
    meta?.agent_plan?.collect?.concurrency_limit,
    meta?.collectConcurrencyLimit,
    meta?.collect_concurrency_limit,
  ]);
}

function normalizeConcurrencyLimit({ market, meta = {}, warnings = [] } = {}) {
  const defaultLimit = DEFAULT_COLLECT_CONCURRENCY_LIMIT[market] || 4;
  const override = extractConcurrencyOverride(meta);
  if (override == null || override === '') return defaultLimit;
  const parsed = Number(override);
  if (!Number.isFinite(parsed)) {
    warnings.push('invalid_collect_concurrency_limit');
    return defaultLimit;
  }
  const clamped = Math.max(MIN_CONCURRENCY, Math.min(MAX_CONCURRENCY, Math.floor(parsed)));
  if (clamped !== parsed) warnings.push('collect_concurrency_limit_clamped');
  return clamped;
}

export function buildPerSymbolCollectBatches(market, perSymbolNodes = []) {
  if (market === 'kis' || market === 'kis_overseas') {
    const preFlow = perSymbolNodes.filter((nodeId) => nodeId !== 'L04');
    const flow = perSymbolNodes.filter((nodeId) => nodeId === 'L04');
    return [preFlow, flow].filter((batch) => batch.length > 0);
  }
  return [perSymbolNodes];
}

export function buildCollectAgentPlan({ market, meta = {} } = {}) {
  const defaults = DEFAULT_COLLECT_NODE_SETS[market];
  if (!defaults) throw new Error(`지원하지 않는 market: ${market}`);

  const warnings = [];
  const supported = SUPPORTED_COLLECT_NODES_BY_MARKET[market] || new Set(defaults);
  const rawOverride = extractCollectNodeOverride(meta);
  const overrideRequested = rawOverride != null;
  let nodeIds = defaults;
  let source = 'default_market_plan';

  if (overrideRequested) {
    const requested = normalizeNodeIds(rawOverride);
    const unsupported = requested.filter((nodeId) => !supported.has(nodeId));
    const accepted = requested.filter((nodeId) => supported.has(nodeId));
    if (unsupported.length > 0) warnings.push(`unsupported_collect_nodes:${unsupported.join(',')}`);
    if (accepted.length > 0) {
      nodeIds = accepted;
      source = 'runtime_agent_plan';
    } else {
      warnings.push('agent_plan_empty_after_validation');
    }
  }

  const portfolioNodeId = nodeIds.includes('L06') ? 'L06' : null;
  const perSymbolNodeIds = nodeIds.filter((nodeId) => nodeId !== 'L06');
  const perSymbolBatches = buildPerSymbolCollectBatches(market, perSymbolNodeIds);
  const concurrencyLimit = normalizeConcurrencyLimit({ market, meta, warnings });

  return {
    market,
    source,
    overrideRequested,
    nodeIds,
    portfolioNodeId,
    perSymbolNodeIds,
    perSymbolBatches,
    concurrencyLimit,
    warnings,
  };
}

export default {
  DEFAULT_COLLECT_NODE_SETS,
  DEFAULT_COLLECT_CONCURRENCY_LIMIT,
  buildPerSymbolCollectBatches,
  buildCollectAgentPlan,
};
