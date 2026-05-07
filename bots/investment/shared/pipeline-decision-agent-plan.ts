// @ts-nocheck

export const DEFAULT_DECISION_NODE_PLAN = Object.freeze({
  analysisNodeIds: ['L10', 'L13', 'L14'],
  debateNodeIds: ['L11', 'L12'],
  immutableSafetyNodeIds: ['L21', 'L30', 'L31', 'L34'],
  auxiliaryExecutionNodeIds: ['L33', 'L32'],
});

const AUXILIARY_EXECUTION_NODES = new Set(['L32', 'L33']);
const IMMUTABLE_DECISION_NODES = new Set(['L10', 'L13', 'L14']);
const IMMUTABLE_SAFETY_NODES = new Set(['L21', 'L30', 'L31', 'L34']);
const SAFETY_GATES = new Set(['predictive_validation', 'entry_trigger']);

function findFirstDefined(candidates = []) {
  for (const candidate of candidates) {
    if (candidate != null) return candidate;
  }
  return undefined;
}

function extractDecisionPlan(meta = {}, params = {}) {
  return findFirstDefined([
    meta?.agentPlan?.decision,
    meta?.agent_plan?.decision,
    meta?.decisionAgentPlan,
    meta?.decision_agent_plan,
    params?.agentPlan?.decision,
    params?.agent_plan?.decision,
    params?.decisionAgentPlan,
    params?.decision_agent_plan,
  ]) || {};
}

function normalizeBool(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(text)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(text)) return false;
  return fallback;
}

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

function normalizeLimit(value, fallback, warnings = []) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    warnings.push('invalid_debate_limit');
    return fallback;
  }
  const clamped = Math.max(0, Math.min(20, Math.floor(parsed)));
  if (clamped !== parsed) warnings.push('debate_limit_clamped');
  return clamped;
}

function normalizeAuxiliaryExecutionNodes(plan = {}, warnings = []) {
  const raw = findFirstDefined([
    plan?.execution?.auxiliaryNodeIds,
    plan?.execution?.auxiliary_nodes,
    plan?.executionAuxiliaryNodeIds,
    plan?.execution_auxiliary_node_ids,
  ]);
  if (raw == null) return DEFAULT_DECISION_NODE_PLAN.auxiliaryExecutionNodeIds;

  const requested = normalizeNodeIds(raw);
  const supported = requested.filter((nodeId) => AUXILIARY_EXECUTION_NODES.has(nodeId));
  const immutable = requested.filter((nodeId) => IMMUTABLE_SAFETY_NODES.has(nodeId) || IMMUTABLE_DECISION_NODES.has(nodeId));
  const unsupported = requested.filter((nodeId) => !AUXILIARY_EXECUTION_NODES.has(nodeId) && !immutable.includes(nodeId));
  if (immutable.length > 0) warnings.push(`immutable_nodes_ignored:${immutable.join(',')}`);
  if (unsupported.length > 0) warnings.push(`unsupported_execution_aux_nodes:${unsupported.join(',')}`);
  return supported;
}

function rejectSafetyBypass(plan = {}, warnings = []) {
  const requested = [];
  if (normalizeBool(plan?.predictiveValidationEnabled ?? plan?.predictive_validation_enabled, true) === false) {
    requested.push('predictive_validation');
  }
  if (normalizeBool(plan?.entryTriggerEnabled ?? plan?.entry_trigger_enabled, true) === false) {
    requested.push('entry_trigger');
  }
  for (const gate of requested) {
    if (SAFETY_GATES.has(gate)) warnings.push(`immutable_safety_gate:${gate}`);
  }
}

export function shouldRunExecutionAuxiliaryNode(plan = {}, nodeId) {
  const node = String(nodeId || '').trim().toUpperCase();
  const nodes = Array.isArray(plan?.auxiliaryExecutionNodeIds)
    ? plan.auxiliaryExecutionNodeIds
    : DEFAULT_DECISION_NODE_PLAN.auxiliaryExecutionNodeIds;
  return nodes.includes(node);
}

export function buildDecisionAgentPlan({
  exchange = 'binance',
  meta = {},
  params = {},
  defaultDebateLimit = 0,
  runtimeFlags = {},
} = {}) {
  const rawPlan = extractDecisionPlan(meta, params);
  const overrideRequested = Object.keys(rawPlan || {}).length > 0;
  const warnings = [];
  const debateRaw = rawPlan?.debate || {};
  const debateEnabled = normalizeBool(
    findFirstDefined([
      debateRaw?.enabled,
      rawPlan?.debateEnabled,
      rawPlan?.debate_enabled,
      rawPlan?.runDebate,
      rawPlan?.run_debate,
    ]),
    true,
  );
  const debateLimit = debateEnabled
    ? normalizeLimit(
      findFirstDefined([
        debateRaw?.limit,
        rawPlan?.debateLimit,
        rawPlan?.debate_limit,
      ]),
      defaultDebateLimit,
      warnings,
    )
    : 0;

  const portfolioRequested = normalizeBool(
    findFirstDefined([
      rawPlan?.portfolio?.enabled,
      rawPlan?.portfolioEnabled,
      rawPlan?.portfolio_enabled,
    ]),
    true,
  );
  if (!portfolioRequested) warnings.push('immutable_decision_node:L14');

  rejectSafetyBypass(rawPlan, warnings);
  const auxiliaryExecutionNodeIds = normalizeAuxiliaryExecutionNodes(rawPlan, warnings);

  return {
    exchange,
    source: overrideRequested ? 'runtime_agent_plan' : 'default_decision_plan',
    overrideRequested,
    analysisNodeIds: DEFAULT_DECISION_NODE_PLAN.analysisNodeIds,
    debateNodeIds: debateEnabled ? DEFAULT_DECISION_NODE_PLAN.debateNodeIds : [],
    debateEnabled,
    debateLimit,
    portfolioEnabled: true,
    predictiveValidationEnabled: runtimeFlags?.phases?.predictiveValidationEnabled === true,
    entryTriggerEnabled: runtimeFlags?.phases?.entryTriggerEnabled === true,
    immutableSafetyNodeIds: DEFAULT_DECISION_NODE_PLAN.immutableSafetyNodeIds,
    auxiliaryExecutionNodeIds,
    warnings,
  };
}

export default {
  DEFAULT_DECISION_NODE_PLAN,
  buildDecisionAgentPlan,
  shouldRunExecutionAuxiliaryNode,
};
