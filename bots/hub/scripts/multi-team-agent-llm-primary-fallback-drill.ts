#!/usr/bin/env tsx
// @ts-nocheck

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  describeAgentModel,
  listAgentModelTargets,
} = require('../../../packages/core/lib/llm-model-selector.ts');
const {
  isHubNonLlmTarget,
} = require('../src/llm-selector.ts');

const HUB_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(__dirname, '../../..');

const DEFAULT_TARGET_TEAMS = ['orchestrator', 'blog', 'claude', 'sigma', 'darwin'];
const ALL_TARGET_TEAMS = ['orchestrator', 'blog', 'claude', 'sigma', 'darwin', 'luna', 'investment', 'justin', 'ska'];
const TEAM_LABELS = {
  orchestrator: 'team-jay',
  blog: 'blog',
  claude: 'claude',
  sigma: 'sigma',
  darwin: 'darwin',
  luna: 'luna',
  investment: 'investment',
  justin: 'justin',
  ska: 'ska',
};

const PLACEHOLDER_RE = /(__SET_|CHANGE_ME|REPLACE_ME|TODO|PLACEHOLDER|changeme)/i;
const TOKEN_RE = /([A-Za-z0-9_\-]{12})[A-Za-z0-9_\-.]{12,}/g;

function flag(name) {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(process.env[name] || '').trim().toLowerCase());
}

function argFlag(name) {
  return process.argv.slice(2).includes(name);
}

function argValue(name, fallback = '') {
  const prefix = `${name}=`;
  const found = process.argv.slice(2).find((arg) => arg === name || arg.startsWith(prefix));
  if (!found) return fallback;
  if (found === name) return 'true';
  return found.slice(prefix.length);
}

function baseUrl() {
  return String(process.env.HUB_BASE_URL || process.env.HUB_URL || 'http://127.0.0.1:7788').replace(/\/+$/, '');
}

function timeoutMs() {
  return Math.max(5000, Number(process.env.HUB_MULTI_AGENT_LLM_DRILL_TIMEOUT_MS || 45_000) || 45_000);
}

function maxTokens() {
  return Math.min(64, Math.max(8, Number(process.env.HUB_MULTI_AGENT_LLM_DRILL_MAX_TOKENS || 24) || 24));
}

function concurrency() {
  return Math.min(4, Math.max(1, Number(process.env.HUB_MULTI_AGENT_LLM_DRILL_CONCURRENCY || 2) || 2));
}

function logFlushMs() {
  return Math.max(0, Number(process.env.HUB_MULTI_AGENT_LLM_DRILL_LOG_FLUSH_MS || 1000) || 1000);
}

function delayMs() {
  return Math.max(0, Number(process.env.HUB_MULTI_AGENT_LLM_DRILL_DELAY_MS || 0) || 0);
}

function targetTeams() {
  const raw = String(argValue('--teams', process.env.HUB_MULTI_AGENT_LLM_DRILL_TEAMS || '') || '').trim();
  if (!raw) return DEFAULT_TARGET_TEAMS;
  if (raw.toLowerCase() === 'all') return ALL_TARGET_TEAMS;
  return [...new Set(raw.split(',').map((item) => item.trim()).filter(Boolean))];
}

function targetAgents() {
  const raw = String(argValue('--agents', process.env.HUB_MULTI_AGENT_LLM_DRILL_AGENTS || '') || '').trim();
  if (!raw || raw.toLowerCase() === 'all') return null;
  return new Set(raw.split(',').map((item) => item.trim()).filter(Boolean));
}

function slotFilter() {
  if (argFlag('--primary-only')) return 'primary';
  if (argFlag('--fallbacks-only')) return 'fallbacks';
  return String(process.env.HUB_MULTI_AGENT_LLM_DRILL_SLOT_FILTER || 'all').trim().toLowerCase() || 'all';
}

function usableSecret(value) {
  const text = String(value || '').trim();
  return text.length >= 12 && !PLACEHOLDER_RE.test(text);
}

function launchctlGetenv(name) {
  try {
    return execFileSync('launchctl', ['getenv', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function hubToken(live) {
  const token = process.env.HUB_AUTH_TOKEN || launchctlGetenv('HUB_AUTH_TOKEN');
  if (usableSecret(token)) return token;
  if (!live) return 'hub-multi-agent-llm-drill-mock-token';
  throw new Error('HUB_AUTH_TOKEN is required for live multi-team agent LLM drill');
}

function redact(value) {
  return String(value || '').replace(TOKEN_RE, '$1…redacted');
}

function resolveReportPath(raw) {
  if (path.isAbsolute(raw)) return raw;
  const normalized = String(raw || '').replace(/\\/g, '/');
  if (normalized.startsWith('bots/hub/')) return path.resolve(REPO_ROOT, raw);
  return path.resolve(HUB_ROOT, raw);
}

function reportOutputPath(live) {
  const raw = String(process.env.HUB_MULTI_AGENT_LLM_DRILL_OUTPUT || '').trim();
  if (/^(none|false|0|-)$/.test(raw)) return null;
  if (raw) return resolveReportPath(raw);
  if (!live && !flag('HUB_MULTI_AGENT_LLM_DRILL_WRITE_REPORT')) return null;
  return path.resolve(HUB_ROOT, 'output', 'multi-team-agent-llm-drill-live.json');
}

function routeFromEntry(entry) {
  const provider = String(entry?.provider || '').trim();
  const model = String(entry?.model || '').trim();
  if (!provider || !model) return model || provider;
  if (provider === 'anthropic') {
    const family = model.includes('opus') ? 'opus' : model.includes('sonnet') ? 'sonnet' : 'haiku';
    return `claude-code/${family}`;
  }
  if (provider === 'claude-code') return model.startsWith('claude-code/') ? model : `claude-code/${model}`;
  if (provider === 'groq') return model.startsWith('groq/') ? model : `groq/${model}`;
  if (provider === 'openai-oauth') return model.startsWith('openai-oauth/') ? model : `openai-oauth/${model}`;
  if (provider === 'openai') return `openai-oauth/${model.replace(/^openai\//, '').replace(/^openai-oauth\//, '')}`;
  if (provider === 'gemini-cli-oauth') {
    return model.startsWith('gemini-cli-oauth/')
      ? model
      : `gemini-cli-oauth/${model.replace(/^google-gemini-cli\//, '').replace(/^gemini-oauth\//, '').replace(/^gemini\//, '')}`;
  }
  if (provider === 'gemini-codeassist-oauth' || provider === 'gemini-code-assist-oauth') {
    return model.startsWith('gemini-codeassist-oauth/')
      ? model
      : `gemini-codeassist-oauth/${model.replace(/^gemini-code-assist-oauth\//, '').replace(/^gemini-oauth\//, '')}`;
  }
  if (provider === 'gemini-oauth' || provider === 'gemini') {
    return `gemini-cli-oauth/${model.replace(/^google-gemini-cli\//, '').replace(/^gemini-oauth\//, '').replace(/^gemini\//, '')}`;
  }
  return model.includes('/') ? model : `${provider}/${model}`;
}

function providerFromRoute(route) {
  const normalized = String(route || '');
  if (normalized.startsWith('claude-code/')) return 'claude-code-oauth';
  if (normalized.startsWith('groq/')) return 'groq';
  if (normalized.startsWith('openai-oauth/') || normalized.startsWith('openai/')) return 'openai-oauth';
  if (normalized.startsWith('gemini-codeassist-oauth/')) return 'gemini-codeassist-oauth';
  if (normalized.startsWith('gemini-cli-oauth/')) return 'gemini-cli-oauth';
  if (normalized.startsWith('gemini-oauth/') || normalized.startsWith('gemini/')) return 'gemini-cli-oauth';
  return normalized || 'unknown';
}

function abstractModelFromRoute(route) {
  const normalized = String(route || '');
  if (normalized.includes('opus')) return 'anthropic_opus';
  if (normalized.includes('sonnet')) return 'anthropic_sonnet';
  return 'anthropic_haiku';
}

function entryForCall(entry) {
  return {
    ...entry,
    maxTokens: Math.min(Number(entry?.maxTokens || maxTokens()) || maxTokens(), maxTokens()),
    timeoutMs: Math.min(Number(entry?.timeoutMs || timeoutMs()) || timeoutMs(), timeoutMs()),
    temperature: Number.isFinite(Number(entry?.temperature)) ? Number(entry.temperature) : 0,
  };
}

function budgetForRoute(route) {
  const normalized = String(route || '');
  if (normalized.startsWith('claude-code/')) return 0.25;
  if (normalized.startsWith('openai-oauth/')) return 0.06;
  if (normalized.startsWith('gemini-cli-oauth/')) return 0.06;
  if (normalized.startsWith('gemini-codeassist-oauth/')) return 0.06;
  return 0.03;
}

function buildPlans() {
  const teams = targetTeams();
  const agentsFilter = targetAgents();
  const agents = teams.flatMap((team) =>
    listAgentModelTargets(team)
      .filter((target) => !isHubNonLlmTarget({ callerTeam: team, agent: target.agent, selectorKey: target.selectorKey }))
      .filter((target) => !agentsFilter || agentsFilter.has(target.agent) || agentsFilter.has(`${team}.${target.agent}`))
      .map((target) => ({ ...target, label: TEAM_LABELS[team] || team }))
  );

  return agents.map((agent) => {
    if (!agent.selected) {
      return {
        team: agent.team,
        label: agent.label,
        agent: agent.agent,
        selected: false,
        selectorKey: agent.selectorKey,
        slots: [],
        skippedReason: 'selector_not_configured',
      };
    }

    const description = describeAgentModel(agent.team, agent.agent);
    const chain = Array.isArray(description?.chain) ? description.chain : [];
    return {
      team: agent.team,
      label: agent.label,
      agent: agent.agent,
      selected: chain.length > 0,
      selectorKey: agent.selectorKey,
      slots: chain.map((entry, index) => {
        const callEntry = entryForCall(entry);
        const route = routeFromEntry(callEntry);
        return {
          index,
          role: index === 0 ? 'primary' : `fallback_${index}`,
          entry: callEntry,
          route,
          expectedProvider: providerFromRoute(route),
          abstractModel: abstractModelFromRoute(route),
        };
      }),
      skippedReason: chain.length > 0 ? null : 'empty_chain',
    };
  });
}

function buildChecks(plans) {
  const filter = slotFilter();
  return plans.flatMap((plan) => plan.slots.filter((slot) => {
    if (filter === 'primary') return slot.index === 0;
    if (filter === 'fallbacks' || filter === 'fallback') return slot.index > 0;
    return true;
  }).map((slot) => ({
    team: plan.team,
    label: plan.label,
    agent: plan.agent,
    selectorKey: plan.selectorKey,
    role: slot.role,
    slotIndex: slot.index,
    route: slot.route,
    expectedProvider: slot.expectedProvider,
    abstractModel: slot.abstractModel,
    entry: slot.entry,
  })));
}

function setupMockFetch(checks) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const body = JSON.parse(String(init?.body || '{}'));
    const route = routeFromEntry(body.chain?.[0] || {});
    const check = checks.find((item) =>
      item.team === body.callerTeam
        && item.agent === body.agent
        && item.role === body.taskType?.replace(/^multi_agent_llm_drill_/, '')
        && item.route === route
    );
    if (String(new URL(String(input)).pathname) !== '/hub/llm/call' || !check) {
      return Response.json({ ok: false, error: 'unexpected_multi_agent_llm_drill_call' }, { status: 404 });
    }
    if (!String(init?.headers?.Authorization || '').startsWith('Bearer ')) {
      return Response.json({ ok: false, error: 'authorization_missing' }, { status: 401 });
    }
    return Response.json({
      ok: true,
      provider: check.expectedProvider,
      result: 'ok',
      durationMs: 8,
      fallbackCount: 0,
      traceId: 'mock-multi-team-agent-llm-drill',
    });
  });
  return () => {
    globalThis.fetch = originalFetch;
  };
}

async function callCheck(check, token, targetBaseUrl = baseUrl()) {
  const started = Date.now();
  const forceSlotChain = check.role !== 'primary';
  try {
    const response = await fetch(`${targetBaseUrl}/hub/llm/call`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Hub-Team': check.team,
        'X-Hub-Agent': check.agent,
        'X-Hub-Priority': 'low',
      },
      body: JSON.stringify({
        prompt: 'Reply exactly: ok',
        systemPrompt: 'You are running a routing health check. Reply exactly with ok.',
        abstractModel: check.abstractModel,
        callerTeam: check.team,
        agent: check.agent,
        taskType: `multi_agent_llm_drill_${check.role}`,
        urgency: 'low',
        timeoutMs: timeoutMs(),
        maxBudgetUsd: budgetForRoute(check.route),
        cacheEnabled: false,
        selectorKey: forceSlotChain ? undefined : check.selectorKey || undefined,
        chain: [check.entry],
      }),
      signal: AbortSignal.timeout(timeoutMs() + 5000),
    });
    const payload = await response.json().catch(() => ({}));
    const provider = String(payload?.provider || '');
    const providerOk = provider === check.expectedProvider;
    return {
      ok: response.ok && payload?.ok !== false && providerOk,
      team: check.team,
      label: check.label,
      agent: check.agent,
      selectorKey: check.selectorKey,
      role: check.role,
      route: check.route,
      expectedProvider: check.expectedProvider,
      provider: provider || null,
      status: response.status,
      durationMs: Number(payload?.durationMs || 0) || Date.now() - started,
      fallbackCount: payload?.fallbackCount ?? null,
      attemptedProviders: payload?.attempted_providers || [],
      error: payload?.error ? redact(payload.error) : null,
      traceIdPresent: Boolean(payload?.traceId),
    };
  } catch (error) {
    return {
      ok: false,
      team: check.team,
      label: check.label,
      agent: check.agent,
      selectorKey: check.selectorKey,
      role: check.role,
      route: check.route,
      expectedProvider: check.expectedProvider,
      provider: null,
      status: null,
      durationMs: Date.now() - started,
      fallbackCount: null,
      attemptedProviders: [],
      error: redact(error?.name === 'TimeoutError' ? 'timeout' : String(error?.message || error)),
      traceIdPresent: false,
    };
  }
}

async function mapConcurrent(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const live = flag('HUB_MULTI_AGENT_LLM_DRILL_LIVE') || argFlag('--live');
  const useLocalApp = live && (flag('HUB_MULTI_AGENT_LLM_DRILL_LOCAL_APP') || argFlag('--local-app'));
  const allowFailures = flag('HUB_MULTI_AGENT_LLM_DRILL_ALLOW_FAILURES') || argFlag('--allow-failures');
  const allowSkipped = flag('HUB_MULTI_AGENT_LLM_DRILL_ALLOW_SKIPPED') || argFlag('--allow-skipped');
  const plans = buildPlans();
  const checks = buildChecks(plans);
  if (useLocalApp && !usableSecret(process.env.HUB_AUTH_TOKEN || launchctlGetenv('HUB_AUTH_TOKEN'))) {
    process.env.HUB_AUTH_TOKEN = 'hub-multi-agent-llm-drill-local-token';
  }
  if (useLocalApp && checks.some((check) => check.role !== 'primary')) {
    process.env.HUB_LLM_ALLOW_ADHOC_CHAIN = '1';
  }
  const token = hubToken(live);
  const restoreFetch = live ? null : setupMockFetch(checks);
  let server = null;
  let targetBaseUrl = baseUrl();

  try {
    if (useLocalApp) {
      const { createHubApp } = require('../src/app.ts');
      const app = createHubApp({
        isShuttingDown: () => false,
        isStartupComplete: () => true,
      });
      server = await new Promise((resolve) => {
        const started = app.listen(0, '127.0.0.1', () => resolve(started));
      });
      const address = server.address();
      targetBaseUrl = `http://127.0.0.1:${address.port}`;
    }
    const requestDelayMs = live ? delayMs() : 0;
    const results = await mapConcurrent(checks, live ? concurrency() : 8, async (check) => {
      const result = await callCheck(check, token, targetBaseUrl);
      if (requestDelayMs > 0) await sleep(requestDelayMs);
      return result;
    });
    if (useLocalApp) await new Promise((resolve) => setTimeout(resolve, logFlushMs()));
    const skippedAgents = plans.filter((plan) => !plan.selected).map((plan) => ({
      team: plan.team,
      label: plan.label,
      agent: plan.agent,
      selectorKey: plan.selectorKey,
      reason: plan.skippedReason,
    }));
    const failed = results.filter((result) => !result.ok);
    const byTeam = {};
    for (const team of targetTeams()) {
      const teamResults = results.filter((result) => result.team === team);
      byTeam[team] = {
        agents: plans.filter((plan) => plan.team === team).length,
        selectedAgents: plans.filter((plan) => plan.team === team && plan.selected).length,
        skippedAgents: skippedAgents.filter((agent) => agent.team === team).length,
        checks: teamResults.length,
        failed: teamResults.filter((result) => !result.ok).length,
        providers: [...new Set(teamResults.map((result) => result.expectedProvider))].sort(),
      };
    }

    const report = {
      ok: failed.length === 0 && (allowSkipped || skippedAgents.length === 0),
      mode: live ? 'live' : 'mock',
      baseUrl: live ? targetBaseUrl : 'mock',
      generatedAt: new Date().toISOString(),
      teams: targetTeams(),
      agentFilter: targetAgents() ? [...targetAgents()].sort() : null,
      slotFilter: slotFilter(),
      totals: {
        agents: plans.length,
        selectedAgents: plans.filter((plan) => plan.selected).length,
        skippedAgents: skippedAgents.length,
        checks: results.length,
        failed: failed.length,
      },
      byTeam,
      skippedAgents,
      failures: failed,
      results,
    };

    const outputJson = reportOutputPath(live);
    if (outputJson) {
      fs.mkdirSync(path.dirname(outputJson), { recursive: true });
      fs.writeFileSync(outputJson, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      report.outputJson = outputJson;
    }

    console.log(JSON.stringify(report, null, 2));
    process.exit((failed.length === 0 || allowFailures) && (allowSkipped || skippedAgents.length === 0) ? 0 : 1);
  } finally {
    if (server) await new Promise((resolve) => server.close(() => resolve(undefined)));
    restoreFetch?.();
  }
}

main().catch((error) => {
  console.error('[multi-team-agent-llm-primary-fallback-drill] failed:', redact(error?.message || error));
  process.exit(1);
});
