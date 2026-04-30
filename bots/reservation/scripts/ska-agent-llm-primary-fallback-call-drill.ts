#!/usr/bin/env node
// @ts-nocheck

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeAgentModel } from '../../../packages/core/lib/llm-model-selector.ts';
import { PROFILES } from '../../hub/lib/runtime-profiles.ts';

type ChainEntry = {
  provider: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
};

type Scenario = {
  agent: string;
  source: string;
  selectorKey?: string | null;
  profileName?: string | null;
  chain: ChainEntry[];
};

const SKA_AGENT_SCENARIOS = [
  'andy',
  'jimmy',
  'rebecca',
  'eve',
  'parsing-guard',
  'selector-generator',
  'error-classifier',
  'ska-reflexion-engine',
  'ska-roundtable-jay',
  'ska-roundtable-claude',
  'ska-roundtable-commander',
];

const SKA_RUNTIME_PROFILES = ['default', 'monitoring', 'reporting'];

function argValue(name: string, fallback = ''): string {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function hubBaseUrl(): string {
  return String(process.env.HUB_BASE_URL || 'http://localhost:7788').replace(/\/+$/, '');
}

function launchctlGetenv(name: string): string {
  try {
    return execFileSync('launchctl', ['getenv', name], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function hubAuthToken(): string {
  return String(process.env.HUB_AUTH_TOKEN || launchctlGetenv('HUB_AUTH_TOKEN') || '').trim();
}

function routeKey(entry: ChainEntry): string {
  const provider = String(entry.provider || '').trim();
  const model = String(entry.model || '').trim();
  if (!provider || !model) return model || provider;
  if (provider === 'claude-code') return model.startsWith('claude-code/') ? model : `claude-code/${model}`;
  if (provider === 'groq') return model.startsWith('groq/') ? model : `groq/${model}`;
  if (provider === 'openai-oauth') return model.startsWith('openai-oauth/') ? model : `openai-oauth/${model}`;
  if (provider === 'gemini-cli-oauth') return model.startsWith('gemini-cli-oauth/') ? model : `gemini-cli-oauth/${model}`;
  return `${provider}/${model}`;
}

function expectedProvider(entry: ChainEntry): string {
  const provider = String(entry.provider || '').trim();
  if (provider === 'claude-code') return 'claude-code-oauth';
  if (provider === 'openai') return 'openai-oauth';
  return provider;
}

function compactEntry(entry: ChainEntry, maxTokens: number): ChainEntry {
  return {
    provider: entry.provider,
    model: entry.model,
    maxTokens: Math.max(1, Math.min(Number(entry.maxTokens || maxTokens) || maxTokens, maxTokens)),
    temperature: Number.isFinite(Number(entry.temperature)) ? Number(entry.temperature) : 0,
    timeoutMs: Number(entry.timeoutMs || 0) > 0 ? Number(entry.timeoutMs) : undefined,
  };
}

function maxBudgetUsd(entry: ChainEntry): number {
  const key = routeKey(entry);
  if (key === 'claude-code/opus') return 0.15;
  if (key.startsWith('claude-code/')) return 0.08;
  return 0.05;
}

function profileChain(profileName: string): ChainEntry[] {
  const profile = PROFILES?.ska?.[profileName];
  const routes = [
    ...(Array.isArray(profile?.primary_routes) ? profile.primary_routes : []),
    ...(Array.isArray(profile?.fallback_routes) ? profile.fallback_routes : []),
  ];
  return routes.map((route) => {
    const [provider, ...rest] = String(route).split('/');
    return { provider, model: rest.join('/') };
  }).filter((entry) => entry.provider && entry.model);
}

export function buildScenarios(): Scenario[] {
  const agentScenarios = SKA_AGENT_SCENARIOS.map((agent) => {
    const described = describeAgentModel('ska', agent);
    return {
      agent,
      source: 'agent-selector',
      selectorKey: described.selectorKey,
      chain: Array.isArray(described.chain) ? described.chain : [],
    };
  });

  const profileScenarios = SKA_RUNTIME_PROFILES.map((profileName) => ({
    agent: `ska-profile-${profileName}`,
    source: 'runtime-profile',
    profileName,
    chain: profileChain(profileName),
  }));

  return [...agentScenarios, ...profileScenarios];
}

async function callRoute(entry: ChainEntry, firstSeenAs: Record<string, unknown>, token: string, options: {
  timeoutMs: number;
  maxTokens: number;
}) {
  const normalized = compactEntry(entry, options.maxTokens);
  const key = routeKey(normalized);
  const started = Date.now();
  try {
    const response = await fetch(`${hubBaseUrl()}/hub/llm/call`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Hub-Team': 'ska',
        'X-Hub-Agent': String(firstSeenAs.agent || 'ska-agent-llm-drill'),
        'X-Hub-Priority': 'low',
      },
      body: JSON.stringify({
        callerTeam: 'ska',
        agent: String(firstSeenAs.agent || 'ska-agent-llm-drill'),
        taskType: 'ska_agent_llm_route_drill',
        prompt: 'Reply exactly: ok',
        systemPrompt: 'You are a SKA team LLM route drill. Keep the answer tiny.',
        abstractModel: 'anthropic_haiku',
        maxTokens: options.maxTokens,
        timeoutMs: Math.max(options.timeoutMs, Number(normalized.timeoutMs || 0) || 0),
        maxBudgetUsd: maxBudgetUsd(normalized),
        cacheEnabled: false,
        chain: [normalized],
      }),
      signal: AbortSignal.timeout(options.timeoutMs + 5000),
    });
    const body = await response.json().catch(() => ({}));
    const providerOk = expectedProvider(normalized) === String(body.provider || '');
    return {
      key,
      provider: normalized.provider,
      model: normalized.model,
      expectedProvider: expectedProvider(normalized),
      ok: response.ok && body?.ok !== false && providerOk,
      httpStatus: response.status,
      selectedProvider: body.provider || null,
      selectedRoute: body.selected_route || body.model || null,
      durationMs: Date.now() - started,
      fallbackCount: Number(body.fallbackCount || 0),
      traceIdPresent: Boolean(body.traceId),
      error: body.error || (providerOk ? null : `unexpected_provider:${body.provider || 'missing'}`),
      firstSeenAs,
    };
  } catch (error) {
    return {
      key,
      provider: normalized.provider,
      model: normalized.model,
      expectedProvider: expectedProvider(normalized),
      ok: false,
      httpStatus: null,
      selectedProvider: null,
      selectedRoute: null,
      durationMs: Date.now() - started,
      fallbackCount: 0,
      traceIdPresent: false,
      error: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : String(error?.message || error),
      firstSeenAs,
    };
  }
}

async function main() {
  const token = hubAuthToken();
  if (!token) throw new Error('HUB_AUTH_TOKEN missing');

  const timeoutMs = Math.max(5000, Number(argValue('timeout-ms', '60000')) || 60000);
  const maxTokens = Math.max(4, Number(argValue('max-tokens', '16')) || 16);
  const allowFailures = hasFlag('allow-failures');
  const scenarios = buildScenarios();
  const routeMap = new Map<string, { entry: ChainEntry; firstSeenAs: Record<string, unknown> }>();
  const routingGaps = [];

  for (const scenario of scenarios) {
    if (!scenario.chain.length) {
      routingGaps.push({
        agent: scenario.agent,
        source: scenario.source,
        selectorKey: scenario.selectorKey || null,
        profileName: scenario.profileName || null,
        reason: 'empty_chain',
      });
      continue;
    }
    scenario.chain.forEach((entry, index) => {
      const key = routeKey(entry);
      if (!routeMap.has(key)) {
        routeMap.set(key, {
          entry,
          firstSeenAs: {
            agent: scenario.agent,
            source: scenario.source,
            selectorKey: scenario.selectorKey || null,
            profileName: scenario.profileName || null,
            role: index === 0 ? 'primary' : `fallback_${index}`,
          },
        });
      }
    });
  }

  const routeResults = [];
  for (const item of routeMap.values()) {
    routeResults.push(await callRoute(item.entry, item.firstSeenAs, token, { timeoutMs, maxTokens }));
  }
  const routeResultMap = new Map(routeResults.map((result) => [result.key, result]));

  const agentResults = scenarios.map((scenario) => {
    const chain = scenario.chain.map((entry, index) => ({
      role: index === 0 ? 'primary' : `fallback_${index}`,
      key: routeKey(entry),
      provider: entry.provider,
      model: entry.model,
    }));
    const checks = chain.map((entry) => {
      const result = routeResultMap.get(entry.key);
      return {
        key: entry.key,
        ok: Boolean(result?.ok),
        durationMs: result?.durationMs ?? null,
        error: result?.error || null,
      };
    });
    return {
      agent: scenario.agent,
      source: scenario.source,
      selectorKey: scenario.selectorKey || null,
      profileName: scenario.profileName || null,
      primary: chain[0]?.key || null,
      fallbacks: chain.slice(1).map((entry) => entry.key),
      ok: scenario.chain.length > 0 && checks.every((check) => check.ok),
      chain,
      routeResults: checks,
    };
  });

  const failedRoutes = routeResults.filter((result) => !result.ok);
  const failedAgents = agentResults.filter((result) => !result.ok);
  const report = {
    ok: failedRoutes.length === 0 && routingGaps.length === 0 && failedAgents.length === 0,
    status: failedRoutes.length === 0 && routingGaps.length === 0 && failedAgents.length === 0
      ? 'ska_agent_llm_primary_fallback_drill_ok'
      : 'ska_agent_llm_primary_fallback_drill_failed',
    generatedAt: new Date().toISOString(),
    hubBaseUrl: hubBaseUrl(),
    agentsTotal: scenarios.length,
    uniqueRouteCount: routeResults.length,
    failedRouteCount: failedRoutes.length,
    routingGapCount: routingGaps.length,
    failedAgents: failedAgents.map((item) => item.agent),
    routingGaps,
    routeResults,
    agentResults,
  };

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok && !allowFailures) process.exit(1);
}

function isDirectExecution(): boolean {
  return path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  main().catch((error) => {
    console.error(`❌ ska-agent-llm-primary-fallback-call-drill 실패: ${error?.message || error}`);
    process.exit(1);
  });
}
