#!/usr/bin/env tsx
// @ts-nocheck

const PLACEHOLDER_RE = /(__SET_|CHANGE_ME|REPLACE_ME|TODO|PLACEHOLDER|changeme)/i;

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
  return [
    {
      name: 'luna_openai_oauth_primary',
      callerTeam: 'luna',
      agent: 'analyst',
      expectedProvider: 'openai-oauth',
      maxBudgetUsd: 0.02,
    },
    {
      name: 'blog_claude_code_primary',
      callerTeam: 'blog',
      agent: 'writer',
      expectedProvider: 'claude-code-oauth',
      maxBudgetUsd: 0.10,
    },
  ];
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
    console.log(JSON.stringify({
      ok: failed.length === 0,
      mode: live ? 'live' : 'mock',
      base_url: live ? baseUrl() : 'mock',
      checked: checks.length,
      failed: failed.length,
      checks,
    }, null, 2));
    process.exit(failed.length === 0 ? 0 : 1);
  } finally {
    restoreFetch?.();
  }
}

main().catch((error) => {
  console.error('[team-llm-route-drill] failed:', error?.message || error);
  process.exit(1);
});
