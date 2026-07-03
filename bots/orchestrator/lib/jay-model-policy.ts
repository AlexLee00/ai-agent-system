'use strict';

const env = require('../../../packages/core/lib/env') as {
  PROJECT_ROOT: string;
};
const path = require('path') as typeof import('node:path');
const { getJayModelConfig, getLLMSelectorOverrides } = require(
  path.join(env.PROJECT_ROOT, 'bots/orchestrator/lib/runtime-config.js')
) as {
  getJayModelConfig: () => Record<string, any>;
  getLLMSelectorOverrides: () => Record<string, any>;
};
const { selectLLMPolicy, selectLLMChain } = require('../../../packages/core/lib/llm-model-selector') as {
  selectLLMPolicy: (key: string, options: Record<string, any>) => Record<string, any>;
  selectLLMChain: (key: string, options: Record<string, any>) => Array<Record<string, any>>;
};
const hubClient = require('../../../packages/core/lib/hub-client.ts') as {
  fetchHubLlmSelector?: (request: Record<string, any>) => Promise<Record<string, any> | null>;
};

function hubPolicyViaHubEnabled(envObj: Record<string, any> = process.env): boolean {
  return String(envObj.ORCH_LLM_POLICY_VIA_HUB || '').trim().toLowerCase() === 'true';
}

function normalizeChain(chain: Array<Record<string, any>> = []): Array<Record<string, any>> {
  return (Array.isArray(chain) ? chain : []).map((entry) => ({
    provider: entry.provider || null,
    model: entry.model || null,
    maxTokens: entry.maxTokens || null,
    temperature: entry.temperature ?? null,
    timeoutMs: entry.timeoutMs || null,
  }));
}

function chainsMatch(a: Array<Record<string, any>> = [], b: Array<Record<string, any>> = []): boolean {
  return JSON.stringify(normalizeChain(a)) === JSON.stringify(normalizeChain(b));
}

async function fetchHubSelector(selectorKey: string, options: Record<string, any> = {}, deps: Record<string, any> = {}) {
  const fetcher = deps.fetchHubLlmSelector || hubClient.fetchHubLlmSelector;
  if (typeof fetcher !== 'function') throw new Error('hub_selector_fetcher_missing');
  return fetcher({
    key: selectorKey,
    selectorKey,
    callerTeam: options.callerTeam || options.team || 'orchestrator',
    team: options.team || options.callerTeam || 'orchestrator',
    agent: options.agent || options.agentName || 'jay',
    agentName: options.agentName || options.agent || 'jay',
    taskType: options.taskType || options.task_type || 'policy_check',
    runtimePurpose: options.runtimePurpose || options.runtime_purpose || 'policy_check',
    selectorVersion: options.selectorVersion || 'v3.0_oauth_4',
    rolloutPercent: options.rolloutPercent ?? 100,
    rolloutKey: options.rolloutKey || `orchestrator-jay-policy:${selectorKey}`,
    timeoutMs: options.timeoutMs || 5000,
  });
}

function maybeLogHubSelectorDiff(selectorKey: string, localChain: Array<Record<string, any>>, options: Record<string, any> = {}) {
  if (!hubPolicyViaHubEnabled()) return;
  fetchHubSelector(selectorKey, options).then((hubResult: any) => {
    const hubChain = hubResult?.chain || [];
    if (!chainsMatch(localChain, hubChain)) {
      console.warn(JSON.stringify({
        event: 'orch_llm_policy_hub_selector_diff',
        selectorKey,
        localChain: normalizeChain(localChain),
        hubChain: normalizeChain(hubChain),
      }));
    }
  }).catch((error: any) => {
    console.warn(JSON.stringify({
      event: 'orch_llm_policy_hub_selector_unavailable',
      selectorKey,
      error: String(error?.message || error).slice(0, 160),
    }));
  });
}

function getGatewayPrimaryModel(): string {
  return getJayModelConfig().gatewayPrimary || 'openai-oauth/gpt-5.4-mini';
}

function buildIntentParsePolicy(): Record<string, any> {
  const config = getJayModelConfig();
  const selectorOverrides = getLLMSelectorOverrides();
  const legacyOverride = {
    primary: { provider: 'openai-oauth', model: config.intentPrimary || 'gpt-5.4' },
    fallback: { provider: 'openai-oauth', model: config.intentFallback || 'gpt-5.4-mini' },
  };
  const policy = selectLLMPolicy('orchestrator.jay.intent', {
    policyOverride: selectorOverrides['orchestrator.jay.intent'] || legacyOverride,
  });
  maybeLogHubSelectorDiff('orchestrator.jay.intent', policy.chain || [policy.primary, policy.fallback].filter(Boolean), {
    taskType: 'intent_parse',
  });
  return policy;
}

function buildJayChatFallbackChain(): Array<Record<string, any>> {
  const config = getJayModelConfig();
  const selectorOverrides = getLLMSelectorOverrides();
  const chain = selectLLMChain('orchestrator.jay.chat_fallback', {
    policyOverride: selectorOverrides['orchestrator.jay.chat_fallback'] || { chain: config.chatFallbackChain },
  });
  maybeLogHubSelectorDiff('orchestrator.jay.chat_fallback', chain, {
    taskType: 'chat_fallback',
  });
  return chain;
}

async function buildHubSelectorDiffReport(deps: Record<string, any> = {}): Promise<Record<string, any>> {
  const config = getJayModelConfig();
  const selectorOverrides = getLLMSelectorOverrides();
  const intentLocal = selectLLMChain('orchestrator.jay.intent', {
    policyOverride: selectorOverrides['orchestrator.jay.intent'] || {
      primary: { provider: 'openai-oauth', model: config.intentPrimary || 'gpt-5.4' },
      fallback: { provider: 'openai-oauth', model: config.intentFallback || 'gpt-5.4-mini' },
    },
  });
  const chatLocal = selectLLMChain('orchestrator.jay.chat_fallback', {
    policyOverride: selectorOverrides['orchestrator.jay.chat_fallback'] || { chain: config.chatFallbackChain },
  });
  const enabled = deps.enabled ?? hubPolicyViaHubEnabled(deps.env || process.env);
  const rows = [
    { selectorKey: 'orchestrator.jay.intent', localChain: intentLocal, taskType: 'intent_parse' },
    { selectorKey: 'orchestrator.jay.chat_fallback', localChain: chatLocal, taskType: 'chat_fallback' },
  ];
  if (!enabled) {
    return {
      enabled: false,
      mode: 'off_local_only',
      diffs: rows.map((row) => ({
        selectorKey: row.selectorKey,
        match: null,
        localChain: normalizeChain(row.localChain),
        hubChain: [],
        skipped: true,
      })),
    };
  }

  const diffs = [];
  for (const row of rows) {
    try {
      const hubResult: any = await fetchHubSelector(row.selectorKey, { taskType: row.taskType }, deps);
      const hubChain = hubResult?.chain || [];
      diffs.push({
        selectorKey: row.selectorKey,
        match: chainsMatch(row.localChain, hubChain),
        localChain: normalizeChain(row.localChain),
        hubChain: normalizeChain(hubChain),
        hubStatus: hubResult?.ok !== false ? 'ok' : 'not_ok',
      });
    } catch (error: any) {
      diffs.push({
        selectorKey: row.selectorKey,
        match: false,
        localChain: normalizeChain(row.localChain),
        hubChain: [],
        hubStatus: 'error',
        error: String(error?.message || error).slice(0, 160),
      });
    }
  }
  return {
    enabled: true,
    mode: 'hub_dual_read',
    diffs,
  };
}

module.exports = {
  getGatewayPrimaryModel,
  buildIntentParsePolicy,
  buildJayChatFallbackChain,
  buildHubSelectorDiffReport,
  hubPolicyViaHubEnabled,
  normalizeChain,
};
