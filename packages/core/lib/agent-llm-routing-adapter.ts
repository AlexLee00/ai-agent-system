// @ts-nocheck
import { resolve } from 'node:path';
import { getAgentDefinition, listAgentDefinitions } from './agent-yaml-loader.ts';

const DEFAULT_INVESTMENT_TEAM_DIR = resolve(__dirname, '../../../bots/investment/team');
const LUNA_YAML_ROUTING_ENV = 'LUNA_YAML_ROUTING_ENABLED';

export const LUNA_YAML_ROUTING_RULE_BASED_PROVIDER = 'rule-based';

function clean(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function parseEnabled(value) {
  const normalized = clean(value).toLowerCase();
  if (!normalized) return true;
  return !['0', 'false', 'no', 'n', 'off'].includes(normalized);
}

function normalizeRouteLabel(label) {
  const text = clean(label);
  if (!text) return null;
  const slash = text.indexOf('/');
  if (slash <= 0) return null;
  const provider = clean(text.slice(0, slash)).toLowerCase();
  const model = clean(text.slice(slash + 1));
  if (!provider || !model) return null;
  return { provider, model };
}

function chainEntryFromRouteLabel(label) {
  const parsed = normalizeRouteLabel(label);
  if (!parsed) return null;
  return {
    provider: parsed.provider,
    model: parsed.model,
  };
}

export function isLunaYamlRoutingEnabled(env = process.env) {
  return parseEnabled(env?.[LUNA_YAML_ROUTING_ENV]);
}

export function routingSourceForSelectorVersion(selectorVersion = '') {
  return String(selectorVersion || '').includes('oauth_4') || String(selectorVersion || '').includes('oauth4')
    ? 'oauth4'
    : 'legacy';
}

export function buildAgentYamlRoutingPolicy(agent = null, options = {}) {
  const agentName = clean(agent?.name || options.agentName).toLowerCase();
  const routing = agent?.llm_routing || null;
  if (!agentName || !routing || typeof routing !== 'object' || Array.isArray(routing)) {
    return null;
  }

  const primaryLabel = clean(routing.primary);
  if (!primaryLabel) return null;

  if (primaryLabel.toLowerCase() === LUNA_YAML_ROUTING_RULE_BASED_PROVIDER) {
    return {
      enabled: false,
      route: LUNA_YAML_ROUTING_RULE_BASED_PROVIDER,
      routingSource: 'yaml',
      agentName,
      primary: null,
      fallbacks: [],
      fallbackChain: [],
    };
  }

  const primary = chainEntryFromRouteLabel(primaryLabel);
  if (!primary) return null;

  const fallbacks = (Array.isArray(routing.fallbacks) ? routing.fallbacks : [])
    .map(chainEntryFromRouteLabel)
    .filter(Boolean);
  const fallbackChain = [primary, ...fallbacks];
  return {
    route: primaryLabel,
    routingSource: 'yaml',
    agentName,
    primary,
    fallbacks,
    fallbackChain,
  };
}

export function resolveInvestmentYamlRoutingPolicy(agentName, options = {}) {
  const teamDir = options.teamDir || DEFAULT_INVESTMENT_TEAM_DIR;
  const normalizedAgentName = clean(agentName).toLowerCase();
  if (!normalizedAgentName) return null;
  try {
    const agent = getAgentDefinition(normalizedAgentName, { teamDir });
    return buildAgentYamlRoutingPolicy(agent, { agentName: normalizedAgentName });
  } catch {
    return null;
  }
}

export function listInvestmentYamlRoutingPolicies(options = {}) {
  const teamDir = options.teamDir || DEFAULT_INVESTMENT_TEAM_DIR;
  return listAgentDefinitions({ teamDir })
    .map((agent) => ({
      agentName: agent.name,
      policy: buildAgentYamlRoutingPolicy(agent, { agentName: agent.name }),
      validation: agent.validation,
      sourcePath: agent.sourcePath,
    }));
}

export const _testOnly = {
  clean,
  normalizeRouteLabel,
  chainEntryFromRouteLabel,
  DEFAULT_INVESTMENT_TEAM_DIR,
};

export default {
  isLunaYamlRoutingEnabled,
  routingSourceForSelectorVersion,
  buildAgentYamlRoutingPolicy,
  resolveInvestmentYamlRoutingPolicy,
  listInvestmentYamlRoutingPolicies,
};
