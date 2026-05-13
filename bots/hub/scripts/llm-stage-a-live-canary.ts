#!/usr/bin/env tsx
// @ts-nocheck

import { execFileSync } from 'node:child_process';

const PLACEHOLDER_RE = /(__SET_|CHANGE_ME|REPLACE_ME|TODO|PLACEHOLDER|changeme)/i;

function argValue(name: string, fallback = ''): string {
  const prefix = `${name}=`;
  const found = process.argv.slice(2).find((arg) => arg === name || arg.startsWith(prefix));
  if (!found) return fallback;
  if (found === name) return 'true';
  return found.slice(prefix.length);
}

function usableSecret(value: string): boolean {
  const text = String(value || '').trim();
  return text.length >= 12 && !PLACEHOLDER_RE.test(text);
}

function launchctlGetenv(name: string): string {
  try {
    return execFileSync('launchctl', ['getenv', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function baseUrl(): string {
  return String(process.env.HUB_BASE_URL || process.env.HUB_URL || 'http://127.0.0.1:7788').replace(/\/+$/, '');
}

function flag(name: string): boolean {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(argValue(name, process.env[name.replace(/^--/, '').replace(/-/g, '_').toUpperCase()] || '')).trim().toLowerCase());
}

function maxCostUsd(): number {
  return Math.max(0.01, Number(argValue('--max-cost-usd', process.env.HUB_STAGE_A_LIVE_CANARY_MAX_COST_USD || '0.25')) || 0.25);
}

function timeoutMs(): number {
  return Math.max(5000, Number(process.env.HUB_STAGE_A_LIVE_CANARY_TIMEOUT_MS || 45_000) || 45_000);
}

function logFlushMs(): number {
  return Math.max(0, Number(process.env.HUB_STAGE_A_LIVE_CANARY_LOG_FLUSH_MS || 1000) || 1000);
}

const SCENARIOS = [
  {
    name: 'openai_oauth_smoke',
    callerTeam: 'hub',
    agent: 'unified-oauth-openai-smoke',
    selectorKey: 'hub.unified.oauth.openai.smoke',
    expectedProvider: 'openai-oauth',
    maxBudgetUsd: 0.06,
  },
  {
    name: 'groq_luna_oracle',
    callerTeam: 'luna',
    agent: 'oracle',
    selectorKey: 'investment.oracle',
    expectedProvider: 'groq',
    maxBudgetUsd: 0.03,
  },
  {
    name: 'gemini_cli_readiness',
    callerTeam: 'hub',
    agent: 'gemini-cli-readiness',
    selectorKey: 'hub.gemini.cli.readiness.live',
    expectedProvider: 'gemini-cli-oauth',
    maxBudgetUsd: 0.06,
  },
  {
    name: 'seed_agent_blog_pos',
    callerTeam: 'blog',
    agent: 'pos',
    selectorKey: 'blog.pos.writer',
    expectedProvider: 'any',
    maxBudgetUsd: 0.06,
  },
];

async function callScenario(scenario: any, token: string, targetBaseUrl: string): Promise<any> {
  const response = await fetch(`${targetBaseUrl}/hub/llm/call`, {
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
      systemPrompt: 'You are a low-cost routing canary. Return exactly: ok',
      abstractModel: 'anthropic_haiku',
      callerTeam: scenario.callerTeam,
      agent: scenario.agent,
      selectorKey: scenario.selectorKey,
      taskType: 'hub_stage_a_live_canary',
      urgency: 'low',
      maxTokens: 24,
      timeoutMs: timeoutMs(),
      maxBudgetUsd: scenario.maxBudgetUsd,
      estimatedCostUsd: Math.min(0.01, scenario.maxBudgetUsd),
      cacheEnabled: false,
    }),
    signal: AbortSignal.timeout(timeoutMs() + 5000),
  });
  const payload = await response.json().catch(() => ({}));
  const provider = payload?.provider || null;
  const providerMatches = scenario.expectedProvider === 'any' || provider === scenario.expectedProvider;
  return {
    name: scenario.name,
    ok: response.ok && payload?.ok !== false && providerMatches,
    status: response.status,
    expectedProvider: scenario.expectedProvider,
    provider,
    selectorKey: payload?.selectorKey || scenario.selectorKey,
    selectedRoute: payload?.selected_route || null,
    budgetGuardStatus: payload?.budgetGuardStatus || null,
    providerTiers: payload?.providerTiers || [],
    traceId: payload?.traceId || null,
    error: payload?.error || null,
  };
}

async function main() {
  const confirm = argValue('--confirm');
  const maxCost = maxCostUsd();
  const totalBudget = SCENARIOS.reduce((sum, scenario) => sum + scenario.maxBudgetUsd, 0);
  if (confirm !== 'hub-stage-a-live-canary') {
    console.log(JSON.stringify({
      ok: false,
      mode: 'dry_run',
      error: 'confirm_required',
      required_confirm: '--confirm=hub-stage-a-live-canary',
      scenarios: SCENARIOS.map(({ name, callerTeam, agent, selectorKey, expectedProvider, maxBudgetUsd }) => ({
        name,
        callerTeam,
        agent,
        selectorKey,
        expectedProvider,
        maxBudgetUsd,
      })),
      max_cost_usd: maxCost,
      local_app_supported: true,
    }, null, 2));
    process.exit(1);
  }
  if (totalBudget > maxCost) {
    throw new Error(`scenario budget ${totalBudget.toFixed(2)} exceeds max-cost-usd ${maxCost.toFixed(2)}`);
  }

  const useLocalApp = flag('--local-app');
  let token = process.env.HUB_AUTH_TOKEN || launchctlGetenv('HUB_AUTH_TOKEN');
  if (useLocalApp && !usableSecret(token)) {
    token = 'hub-stage-a-live-canary-local-token';
    process.env.HUB_AUTH_TOKEN = token;
  }
  if (!usableSecret(token)) throw new Error('HUB_AUTH_TOKEN is required for live canary');

  let server: any = null;
  let targetBaseUrl = baseUrl();
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

  const checks = [];
  try {
    for (const scenario of SCENARIOS) {
      checks.push(await callScenario(scenario, token, targetBaseUrl));
    }
    await new Promise((resolve) => setTimeout(resolve, logFlushMs()));
  } finally {
    if (server) await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
  const failed = checks.filter((check) => !check.ok);
  console.log(JSON.stringify({
    ok: failed.length === 0,
    mode: 'live',
    app_mode: useLocalApp ? 'local_ephemeral_app' : 'running_hub',
    base_url: targetBaseUrl,
    checked: checks.length,
    failed: failed.length,
    max_cost_usd: maxCost,
    checks,
  }, null, 2));
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error('[llm-stage-a-live-canary] failed:', error?.message || error);
  process.exit(1);
});
