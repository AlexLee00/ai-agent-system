#!/usr/bin/env tsx
// @ts-nocheck

const fs = require('node:fs');
const path = require('node:path');
const { PROFILES } = require('../lib/runtime-profiles.ts');

const PLACEHOLDER_RE = /(__SET_|CHANGE_ME|REPLACE_ME|TODO|PLACEHOLDER|changeme)/i;
const UNSUITABLE_AGENT_RE = /(image|gemma|stt|whisper|local)/i;

function flag(name) {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(process.env[name] || '').trim().toLowerCase());
}

function usableSecret(value) {
  const text = String(value || '').trim();
  return text.length >= 12 && !PLACEHOLDER_RE.test(text);
}

function baseUrl() {
  return String(process.env.HUB_BASE_URL || process.env.HUB_URL || 'http://127.0.0.1:7788').replace(/\/+$/, '');
}

function timeoutMs() {
  return Math.max(5000, Number(process.env.HUB_TEAM_LLM_DRILL_TIMEOUT_MS || 45_000) || 45_000);
}

function reportOutputPath(live) {
  const raw = String(process.env.HUB_TEAM_LLM_DRILL_OUTPUT || '').trim();
  if (/^(none|false|0|-)$/.test(raw)) return null;
  if (raw) return path.resolve(raw);
  if (!live && !flag('HUB_TEAM_LLM_DRILL_WRITE_REPORT')) return null;
  return path.resolve(__dirname, '..', 'output', 'team-llm-route-drill-live.json');
}

function scenarios() {
  const raw = String(process.env.HUB_TEAM_LLM_DRILL_SCENARIOS || '').trim();
  if (raw) {
    return raw.split(',').map((item) => {
      const [callerTeam, agent = 'default', expectedProvider = 'any', maxBudgetUsd = '0.05'] = item.split(':').map((part) => part.trim());
      return {
        name: `${callerTeam}_${agent}`,
        callerTeam,
        agent,
        expectedProvider,
        maxBudgetUsd: Number(maxBudgetUsd) || 0.05,
      };
    }).filter((item) => item.callerTeam);
  }
  return defaultProfileScenarios();
}

function routeToProvider(route) {
  const normalized = String(route || '').trim();
  if (normalized.startsWith('claude-code/')) return 'claude-code-oauth';
  if (normalized.startsWith('openai-oauth/')) return 'openai-oauth';
  if (normalized.startsWith('gemini-cli-oauth/')) return 'gemini-cli-oauth';
  if (normalized.startsWith('gemini-oauth/')) return 'gemini-oauth';
  if (normalized.startsWith('groq/')) return 'groq';
  if (normalized.startsWith('openai/')) return 'openai';
  if (normalized.startsWith('google-gemini-cli/') || normalized.startsWith('gemini/')) return 'gemini';
  if (normalized.startsWith('local/')) return 'local';
  return '';
}

function firstSupportedRoute(profile) {
  return [
    ...(profile?.primary_routes || []),
    ...(profile?.fallback_routes || []),
  ].find((route) => routeToProvider(route));
}

function isOauthProvider(provider) {
  return provider === 'openai-oauth'
    || provider === 'claude-code-oauth'
    || provider === 'gemini-cli-oauth'
    || provider === 'gemini-oauth';
}

function defaultBudgetForProvider(provider) {
  if (provider === 'claude-code-oauth') return 0.10;
  if (provider === 'openai-oauth') return 0.02;
  if (provider === 'gemini-cli-oauth') return 0.04;
  return 0.05;
}

function defaultProfileScenarios() {
  return Object.entries(PROFILES || {})
    .flatMap(([callerTeam, profiles]) => {
      const entries = Object.entries(profiles || {})
        .filter(([agent, profile]) => !UNSUITABLE_AGENT_RE.test(agent) && firstSupportedRoute(profile));
      const oauthFirst = entries.find(([, profile]) => isOauthProvider(routeToProvider(firstSupportedRoute(profile))));
      const geminiPrimary = entries.find(([, profile]) => {
        const provider = routeToProvider(firstSupportedRoute(profile));
        return provider === 'gemini-cli-oauth' || provider === 'gemini-oauth';
      });
      const defaultEntry = entries.find(([agent]) => agent === 'default');
      const selected = oauthFirst || defaultEntry || entries[0];
      if (!selected) return [];
      const selectedEntries = [selected];
      if (geminiPrimary && geminiPrimary[0] !== selected[0]) selectedEntries.push(geminiPrimary);
      return selectedEntries.map(([agent, profile]) => {
      const route = firstSupportedRoute(profile);
      const expectedProvider = routeToProvider(route) || 'any';
      return {
        name: `${callerTeam}_${agent}_${expectedProvider.replace(/[^a-z0-9]+/gi, '_')}`,
        callerTeam,
        agent,
        expectedProvider,
        selectedRoute: route,
        maxBudgetUsd: defaultBudgetForProvider(expectedProvider),
      };
      });
    })
    .sort((a, b) => a.callerTeam.localeCompare(b.callerTeam));
}

function setupMockFetch(expected) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body || '{}'));
    const scenario = expected.find((item) => item.callerTeam === body.callerTeam && item.agent === body.agent);
    if (url.pathname !== '/hub/llm/call' || !scenario) {
      return Response.json({ ok: false, error: 'unexpected_team_llm_drill_call' }, { status: 404 });
    }
    if (!String(init?.headers?.Authorization || '').startsWith('Bearer ')) {
      return Response.json({ ok: false, error: 'authorization_missing' }, { status: 401 });
    }
    return Response.json({
      ok: true,
      provider: scenario.expectedProvider,
      result: 'ok',
      durationMs: 12,
      fallbackCount: 0,
      traceId: 'mock-team-llm-route-drill',
    });
  });
  return () => {
    globalThis.fetch = originalFetch;
  };
}

async function callScenario(scenario, token) {
  try {
    const response = await fetch(`${baseUrl()}/hub/llm/call`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Hub-Team': scenario.callerTeam,
        'X-Hub-Agent': scenario.agent,
        'X-Hub-Priority': 'low',
      },
      body: JSON.stringify({
        prompt: 'Return exactly: ok',
        abstractModel: 'anthropic_sonnet',
        callerTeam: scenario.callerTeam,
        agent: scenario.agent,
        taskType: 'team_llm_route_drill',
        urgency: 'low',
        timeoutMs: timeoutMs(),
        maxBudgetUsd: scenario.maxBudgetUsd,
        cacheEnabled: false,
      }),
      signal: AbortSignal.timeout(timeoutMs() + 5000),
    });
    const payload = await response.json().catch(() => ({}));
    const provider = String(payload?.provider || '');
    const providerOk = scenario.expectedProvider === 'any' || provider === scenario.expectedProvider;
    return {
      name: scenario.name,
      ok: response.ok && payload?.ok !== false && providerOk,
      provider: provider || null,
      status: response.status,
      details: {
        expected_provider: scenario.expectedProvider,
        selected_route: scenario.selectedRoute || null,
        max_budget_usd: scenario.maxBudgetUsd,
        fallback_count: payload?.fallbackCount ?? null,
        attempted_providers: payload?.attempted_providers || null,
        primary_error_present: Boolean(payload?.primaryError),
        admission_queued: payload?.admission?.queued ?? null,
        trace_id_present: Boolean(payload?.traceId),
        error: payload?.error || null,
      },
    };
  } catch (error) {
    return {
      name: scenario.name,
      ok: false,
      status: null,
      details: {
        expected_provider: scenario.expectedProvider,
        selected_route: scenario.selectedRoute || null,
        max_budget_usd: scenario.maxBudgetUsd,
        error: error?.name === 'TimeoutError' ? 'timeout' : String(error?.message || error),
      },
    };
  }
}

async function main() {
  const live = flag('HUB_TEAM_LLM_DRILL_LIVE');
  const scenarioList = scenarios();
  const token = process.env.HUB_AUTH_TOKEN || (live ? '' : 'hub-team-llm-drill-mock-token');
  if (!usableSecret(token)) {
    throw new Error('HUB_AUTH_TOKEN is required for live team LLM drill');
  }

  const restoreFetch = live ? null : setupMockFetch(scenarioList);
  try {
    const checks = [];
    for (const scenario of scenarioList) {
      checks.push(await callScenario(scenario, token));
    }
    const failed = checks.filter((check) => !check.ok);
    const outputJson = reportOutputPath(live);
    const report = {
      ok: failed.length === 0,
      mode: live ? 'live' : 'mock',
      base_url: live ? baseUrl() : 'mock',
      generated_at: new Date().toISOString(),
      checked: checks.length,
      failed: failed.length,
      oauth_primary_checks: checks.filter((check) => ['openai-oauth', 'claude-code-oauth', 'gemini-cli-oauth', 'gemini-oauth'].includes(check.details?.expected_provider)).length,
      non_oauth_primary_checks: checks.filter((check) => !['openai-oauth', 'claude-code-oauth', 'gemini-cli-oauth', 'gemini-oauth'].includes(check.details?.expected_provider)).length,
      checks,
      output_json: outputJson,
    };
    if (outputJson) {
      fs.mkdirSync(path.dirname(outputJson), { recursive: true });
      fs.writeFileSync(outputJson, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
    console.log(JSON.stringify(report, null, 2));
    process.exit(failed.length === 0 ? 0 : 1);
  } finally {
    restoreFetch?.();
  }
}

main().catch((error) => {
  console.error('[team-llm-route-drill] failed:', error?.message || error);
  process.exit(1);
});
