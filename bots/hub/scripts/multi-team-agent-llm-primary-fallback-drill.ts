#!/usr/bin/env tsx
// @ts-nocheck

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  describeAgentModel,
  listAgentModelTargets,
} = require('../../../packages/core/lib/llm-model-selector.ts');

const TARGET_TEAMS = ['orchestrator', 'blog', 'claude', 'sigma', 'darwin'];
const TEAM_LABELS = {
  orchestrator: 'team-jay',
  blog: 'blog',
  claude: 'claude',
  sigma: 'sigma',
  darwin: 'darwin',
};

const PLACEHOLDER_RE = /(__SET_|CHANGE_ME|REPLACE_ME|TODO|PLACEHOLDER|changeme)/i;
const TOKEN_RE = /([A-Za-z0-9_\-]{12})[A-Za-z0-9_\-.]{12,}/g;

function flag(name) {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(process.env[name] || '').trim().toLowerCase());
}

function argFlag(name) {
  return process.argv.slice(2).includes(name);
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

function reportOutputPath(live) {
  const raw = String(process.env.HUB_MULTI_AGENT_LLM_DRILL_OUTPUT || '').trim();
  if (/^(none|false|0|-)$/.test(raw)) return null;
  if (raw) return path.resolve(raw);
  if (!live && !flag('HUB_MULTI_AGENT_LLM_DRILL_WRITE_REPORT')) return null;
  return path.resolve(__dirname, '..', 'output', 'multi-team-agent-llm-drill-live.json');
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
    return `gemini-oauth/${model.replace(/^gemini-oauth\//, '').replace(/^gemini\//, '')}`;
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
  if (normalized.startsWith('gemini-oauth/') || normalized.startsWith('gemini/')) return 'gemini-oauth';
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
  const agents = TARGET_TEAMS.flatMap((team) =>
    listAgentModelTargets(team).map((target) => ({ ...target, label: TEAM_LABELS[team] || team }))
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
  return plans.flatMap((plan) => plan.slots.map((slot) => ({
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

async function callCheck(check, token) {
  const started = Date.now();
  try {
    const response = await fetch(`${baseUrl()}/hub/llm/call`, {
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
        selectorKey: check.selectorKey || undefined,
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

async function main() {
  const live = flag('HUB_MULTI_AGENT_LLM_DRILL_LIVE') || argFlag('--live');
  const allowFailures = flag('HUB_MULTI_AGENT_LLM_DRILL_ALLOW_FAILURES') || argFlag('--allow-failures');
  const plans = buildPlans();
  const checks = buildChecks(plans);
  const token = hubToken(live);
  const restoreFetch = live ? null : setupMockFetch(checks);

  try {
    const results = await mapConcurrent(checks, live ? concurrency() : 8, (check) => callCheck(check, token));
    const skippedAgents = plans.filter((plan) => !plan.selected).map((plan) => ({
      team: plan.team,
      label: plan.label,
      agent: plan.agent,
      selectorKey: plan.selectorKey,
      reason: plan.skippedReason,
    }));
    const failed = results.filter((result) => !result.ok);
    const byTeam = {};
    for (const team of TARGET_TEAMS) {
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
      ok: failed.length === 0,
      mode: live ? 'live' : 'mock',
      baseUrl: live ? baseUrl() : 'mock',
      generatedAt: new Date().toISOString(),
      teams: TARGET_TEAMS,
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
    process.exit(failed.length === 0 || allowFailures ? 0 : 1);
  } finally {
    restoreFetch?.();
  }
}

main().catch((error) => {
  console.error('[multi-team-agent-llm-primary-fallback-drill] failed:', redact(error?.message || error));
  process.exit(1);
});
