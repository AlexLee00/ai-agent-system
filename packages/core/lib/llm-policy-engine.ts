// @ts-nocheck

import {
  applyProviderRuntimeGuards,
  routeEntryFromAbstractRoute,
} from './llm-model-selector.ts';
import {
  LLM_POLICY_RULES,
  type PolicyChainEntry,
  type PolicyRule,
} from './llm-policy-table.ts';

export type PolicyEngineContext = {
  team?: string | null;
  callerTeam?: string | null;
  selectorKey?: string | null;
  agent?: string | null;
  agentName?: string | null;
  taskType?: string | null;
  task_type?: string | null;
  runtimePurpose?: string | null;
  runtime_purpose?: string | null;
  [key: string]: unknown;
};

type LLMChainEntry = {
  provider: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
};

const OAUTH4_SELECTOR_VERSION = 'v3_oauth_4';

function clean(value: unknown): string {
  return String(value || '').trim();
}

function normalizeToken(value: unknown): string {
  return clean(value).toLowerCase();
}

function teamFromSelectorKey(selectorKey: string): string {
  return clean(selectorKey).split('.')[0] || '';
}

function normalizeContext(ctx: PolicyEngineContext = {}) {
  const selectorKey = clean(ctx.selectorKey);
  const selectorTeam = teamFromSelectorKey(selectorKey);
  const team = normalizeToken(selectorTeam || ctx.team || ctx.callerTeam);
  const agent = clean(ctx.agentName || ctx.agent);
  const taskType = normalizeToken(ctx.taskType || ctx.task_type || ctx.runtimePurpose || ctx.runtime_purpose);
  return {
    ...ctx,
    selectorKey,
    team,
    agent,
    taskType,
  };
}

function ruleSpecificity(rule: PolicyRule): number {
  let score = 0;
  if (rule.match.agent) score += 8;
  if (rule.match.selectorKey) score += 4;
  if (rule.match.taskType) score += 2;
  if (rule.match.team && rule.match.team !== '*') score += 1;
  return score;
}

function ruleMatches(rule: PolicyRule, ctx: ReturnType<typeof normalizeContext>): boolean {
  const match = rule.match || {};
  if (match.team && match.team !== '*' && normalizeToken(match.team) !== ctx.team) return false;
  if (match.selectorKey && clean(match.selectorKey) !== ctx.selectorKey) return false;
  if (match.agent && clean(match.agent) !== ctx.agent) return false;
  if (match.taskType && normalizeToken(match.taskType) !== ctx.taskType) return false;
  return true;
}

function compareRules(a: PolicyRule, b: PolicyRule): number {
  const specificity = ruleSpecificity(b) - ruleSpecificity(a);
  if (specificity !== 0) return specificity;
  return String(a.id).localeCompare(String(b.id));
}

export function resolvePolicyRule(ctx: PolicyEngineContext = {}): PolicyRule | null {
  const normalized = normalizeContext(ctx);
  const matches = LLM_POLICY_RULES.filter((rule) => ruleMatches(rule, normalized)).sort(compareRules);
  return matches[0] || null;
}

function cloneEntry(entry: LLMChainEntry): LLMChainEntry {
  return JSON.parse(JSON.stringify(entry));
}

function buildChainEntry(entry: PolicyChainEntry): LLMChainEntry | null {
  if (typeof entry === 'string') {
    return routeEntryFromAbstractRoute(entry, OAUTH4_SELECTOR_VERSION);
  }
  if (!entry || typeof entry !== 'object') return null;
  return cloneEntry(entry as LLMChainEntry);
}

function buildChain(entries: PolicyChainEntry[] = []): LLMChainEntry[] {
  return entries.map(buildChainEntry).filter(Boolean);
}

export function normalizePolicyEngineChain(chain: LLMChainEntry[] = []): LLMChainEntry[] {
  return (Array.isArray(chain) ? chain : []).map((entry) => {
    const row: LLMChainEntry = {
      provider: clean(entry.provider),
      model: clean(entry.model),
    };
    const maxTokens = Number(entry.maxTokens);
    const temperature = Number(entry.temperature);
    const timeoutMs = Number(entry.timeoutMs);
    if (Number.isFinite(maxTokens)) row.maxTokens = maxTokens;
    if (Number.isFinite(temperature)) row.temperature = temperature;
    if (Number.isFinite(timeoutMs)) row.timeoutMs = timeoutMs;
    return row;
  });
}

export function resolvePolicyChain(ctx: PolicyEngineContext = {}): LLMChainEntry[] {
  const normalized = normalizeContext(ctx);
  const rule = resolvePolicyRule(normalized);
  if (!rule) return [];
  const chain = buildChain(rule.chain);
  return normalizePolicyEngineChain(applyProviderRuntimeGuards(chain, {
    ...ctx,
    selectorKey: normalized.selectorKey,
    team: normalized.team,
    callerTeam: normalized.team,
    agentName: normalized.agent,
    agent: normalized.agent,
    taskType: normalized.taskType,
    task_type: normalized.taskType,
    runtimePurpose: normalized.taskType,
    runtime_purpose: normalized.taskType,
  }));
}
