#!/usr/bin/env node
// @ts-nocheck

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveHubRoutingPlan } from '../shared/agent-llm-routing.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const ALL_LUNA_AGENTS = [
  'adaptive-risk',
  'argos',
  'aria',
  'athena',
  'budget',
  'chronos',
  'hanul',
  'hephaestos',
  'hermes',
  'kairos',
  'luna',
  'nemesis',
  'oracle',
  'scout',
  'sentinel',
  'sophia',
  'stock-flow',
  'sweeper',
  'zeus',
];

const ROUTE_SCENARIOS = [
  { agent: 'luna', market: 'crypto', task: 'final_decision' },
  { agent: 'luna', market: 'domestic', task: 'final_decision' },
  { agent: 'luna', market: 'overseas', task: 'final_decision' },
  { agent: 'nemesis', market: 'any', task: 'risk_eval' },
  { agent: 'aria', market: 'any', task: 'technical_analysis' },
  { agent: 'sophia', market: 'crypto', task: 'sentiment' },
  { agent: 'sophia', market: 'domestic', task: 'sentiment' },
  { agent: 'sophia', market: 'overseas', task: 'sentiment' },
  { agent: 'argos', market: 'any', task: 'screening' },
  { agent: 'hermes', market: 'any', task: 'sentiment' },
  { agent: 'oracle', market: 'crypto', task: 'onchain' },
  { agent: 'chronos', market: 'any', task: 'backtest' },
  { agent: 'zeus', market: 'any', task: 'debate_bull' },
  { agent: 'athena', market: 'any', task: 'debate_bear' },
  { agent: 'sentinel', market: 'any', task: 'anomaly_detect' },
  { agent: 'adaptive-risk', market: 'any', task: 'default' },
  { agent: 'hephaestos', market: 'any', task: 'execution' },
  { agent: 'hanul', market: 'any', task: 'execution' },
  { agent: 'budget', market: 'any', task: 'capital' },
  { agent: 'scout', market: 'any', task: 'default' },
  { agent: 'kairos', market: 'any', task: 'prediction' },
  { agent: 'stock-flow', market: 'any', task: 'flow' },
  { agent: 'sweeper', market: 'any', task: 'operations' },
];

function parseArgs(argv = process.argv.slice(2)) {
  const get = (name, fallback = '') => {
    const match = argv.find((arg) => arg.startsWith(`--${name}=`));
    return match ? match.split('=').slice(1).join('=') : fallback;
  };
  return {
    json: argv.includes('--json'),
    allowFailures: argv.includes('--allow-failures'),
    writeReport: argv.includes('--write-report'),
    hubBaseUrl: String(get('hub-base-url', process.env.HUB_BASE_URL || process.env.HUB_URL || 'http://127.0.0.1:7788')).replace(/\/+$/, ''),
    timeoutMs: Math.max(10_000, Number(get('timeout-ms', process.env.LUNA_AGENT_LLM_DRILL_TIMEOUT_MS || '60000')) || 60_000),
    maxTokens: Math.max(1, Number(get('max-tokens', process.env.LUNA_AGENT_LLM_DRILL_MAX_TOKENS || '8')) || 8),
    output: get('output', ''),
  };
}

function getLaunchctlEnv(name) {
  try {
    return execFileSync('launchctl', ['getenv', name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
  } catch {
    return '';
  }
}

function getHubToken() {
  return String(process.env.HUB_AUTH_TOKEN || getLaunchctlEnv('HUB_AUTH_TOKEN') || '').trim();
}

function routeKey(entry) {
  return `${entry.provider}/${entry.model}`;
}

function expectedProvider(entry) {
  if (entry.provider === 'claude-code') return 'claude-code-oauth';
  if (entry.provider === 'openai') return 'openai-oauth';
  return entry.provider;
}

function roleForIndex(index) {
  return index === 0 ? 'primary' : `fallback_${index}`;
}

function buildAgentRouteCoverage({ maxTokens }) {
  const previousRouting = process.env.LUNA_AGENT_LLM_ROUTING_ENABLED;
  process.env.LUNA_AGENT_LLM_ROUTING_ENABLED = 'true';
  try {
    const coverage = [];
    const uniqueRoutes = new Map();
    const routedAgents = new Set();

    for (const scenario of ROUTE_SCENARIOS) {
      routedAgents.add(scenario.agent);
      const plan = resolveHubRoutingPlan(scenario.agent, scenario.market, scenario.task, maxTokens);
      const chain = Array.isArray(plan.chain) ? plan.chain : [];
      const noLLM = plan.route?.noLLM === true;

      coverage.push({
        ...scenario,
        enabled: plan.enabled,
        noLLM,
        primary: plan.route?.primary || null,
        fallbacks: Array.isArray(plan.route?.fallbacks) ? plan.route.fallbacks : [],
        chain: noLLM ? [] : chain.map((entry, index) => ({
          role: roleForIndex(index),
          provider: entry.provider,
          model: entry.model,
          key: routeKey(entry),
        })),
        skippedReason: noLLM ? 'rule_based_no_llm' : null,
      });

      if (noLLM) continue;
      chain.forEach((entry, index) => {
        const key = routeKey(entry);
        if (!uniqueRoutes.has(key)) {
          uniqueRoutes.set(key, {
            ...entry,
            key,
            expectedProvider: expectedProvider(entry),
            firstSeenAs: {
              agent: scenario.agent,
              market: scenario.market,
              task: scenario.task,
              role: roleForIndex(index),
            },
          });
        }
      });
    }

    const missingAgents = ALL_LUNA_AGENTS.filter((agent) => !routedAgents.has(agent));
    return {
      coverage,
      uniqueRoutes: Array.from(uniqueRoutes.values()),
      missingAgents,
    };
  } finally {
    if (previousRouting == null) delete process.env.LUNA_AGENT_LLM_ROUTING_ENABLED;
    else process.env.LUNA_AGENT_LLM_ROUTING_ENABLED = previousRouting;
  }
}

async function callSingleRoute(route, args, token) {
  const started = Date.now();
  try {
    const response = await fetch(`${args.hubBaseUrl}/hub/llm/call`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Hub-Team': 'luna',
        'X-Hub-Agent': `llm-drill-${route.firstSeenAs.agent}`,
        'X-Hub-Priority': 'low',
      },
      body: JSON.stringify({
        prompt: 'Reply exactly: ok',
        systemPrompt: 'You are a route canary. Keep the answer to one token.',
        abstractModel: route.model.includes('sonnet') ? 'anthropic_sonnet' : 'anthropic_haiku',
        timeoutMs: args.timeoutMs,
        maxTokens: args.maxTokens,
        callerTeam: 'luna',
        agent: route.firstSeenAs.agent,
        taskType: `llm_drill_${route.firstSeenAs.task}`,
        urgency: 'low',
        selectorKey: 'investment.agent_policy',
        chain: [{
          provider: route.provider,
          model: route.model,
          maxTokens: args.maxTokens,
          timeoutMs: args.timeoutMs,
        }],
        cacheEnabled: false,
      }),
      signal: AbortSignal.timeout(args.timeoutMs + 5000),
    });
    const payload = await response.json().catch(() => ({}));
    const provider = String(payload?.provider || '');
    const providerOk = provider === route.expectedProvider;
    return {
      key: route.key,
      provider: route.provider,
      model: route.model,
      expectedProvider: route.expectedProvider,
      ok: response.ok && payload?.ok !== false && providerOk,
      httpStatus: response.status,
      selectedProvider: provider || null,
      selectedRoute: payload?.selected_route || null,
      durationMs: Number(payload?.durationMs || 0) || (Date.now() - started),
      fallbackCount: payload?.fallbackCount ?? null,
      traceIdPresent: Boolean(payload?.traceId),
      error: payload?.error || (providerOk ? null : `unexpected_provider:${provider || 'missing'}`),
      firstSeenAs: route.firstSeenAs,
    };
  } catch (error) {
    return {
      key: route.key,
      provider: route.provider,
      model: route.model,
      expectedProvider: route.expectedProvider,
      ok: false,
      httpStatus: null,
      selectedProvider: null,
      selectedRoute: null,
      durationMs: Date.now() - started,
      fallbackCount: null,
      traceIdPresent: false,
      error: error?.name === 'TimeoutError' ? 'timeout' : String(error?.message || error),
      firstSeenAs: route.firstSeenAs,
    };
  }
}

async function fetchCircuit(args, token) {
  try {
    const response = await fetch(`${args.hubBaseUrl}/hub/llm/circuit`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await response.json().catch(() => ({}));
    return {
      ok: response.ok && payload?.ok !== false,
      status: response.status,
      providers: payload?.providers || payload?.circuits || null,
      cooldowns: payload?.cooldowns || payload?.provider_cooldowns || null,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      error: String(error?.message || error),
    };
  }
}

function outputPath(args) {
  if (args.output) return path.resolve(args.output);
  return path.resolve(process.cwd(), 'output', 'ops', 'luna-agent-llm-primary-fallback-call-drill.json');
}

async function runDrill(args = parseArgs()) {
  const token = getHubToken();
  if (!token) {
    throw new Error('HUB_AUTH_TOKEN is required via env or launchctl for Luna agent LLM drill');
  }

  const { coverage, uniqueRoutes, missingAgents } = buildAgentRouteCoverage({ maxTokens: args.maxTokens });
  const routeResults = [];
  for (const route of uniqueRoutes) {
    routeResults.push(await callSingleRoute(route, args, token));
  }

  const resultsByKey = new Map(routeResults.map((item) => [item.key, item]));
  const agentResults = coverage.map((scenario) => {
    if (scenario.skippedReason) {
      return {
        ...scenario,
        ok: scenario.skippedReason === 'rule_based_no_llm',
        routeResults: [],
      };
    }
    const scenarioResults = scenario.chain.map((entry) => resultsByKey.get(entry.key)).filter(Boolean);
    return {
      ...scenario,
      ok: scenarioResults.length > 0 && scenarioResults.every((item) => item.ok),
      routeResults: scenarioResults.map((item) => ({
        key: item.key,
        ok: item.ok,
        durationMs: item.durationMs,
        error: item.error,
      })),
    };
  });

  const failedRoutes = routeResults.filter((item) => !item.ok);
  const routingGaps = agentResults.filter((item) => item.skippedReason === 'no_explicit_luna_llm_route');
  const unexpectedMissingAgents = missingAgents;
  const report = {
    ok: failedRoutes.length === 0 && unexpectedMissingAgents.length === 0,
    status: failedRoutes.length === 0
      ? 'luna_agent_llm_primary_fallback_drill_ok'
      : 'luna_agent_llm_primary_fallback_drill_failed',
    generatedAt: new Date().toISOString(),
    hubBaseUrl: args.hubBaseUrl,
    agentsTotal: ALL_LUNA_AGENTS.length,
    agentCoverageCount: agentResults.length,
    uniqueRouteCount: uniqueRoutes.length,
    failedRouteCount: failedRoutes.length,
    routingGapCount: routingGaps.length,
    unexpectedMissingAgents,
    routeResults,
    agentResults,
    circuit: await fetchCircuit(args, token),
  };

  if (args.writeReport) {
    const out = outputPath(args);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    report.outputPath = out;
  }

  if (!report.ok && !args.allowFailures) {
    const failed = failedRoutes.map((item) => `${item.key}:${item.error || 'failed'}`).join(', ');
    const gaps = unexpectedMissingAgents.length ? ` missing=${unexpectedMissingAgents.join(',')}` : '';
    throw new Error(`Luna agent LLM drill failed: ${failed}${gaps}`);
  }
  return report;
}

async function main() {
  const args = parseArgs();
  const report = await runDrill(args);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`${report.status} agents=${report.agentCoverageCount}/${report.agentsTotal} routes=${report.uniqueRouteCount} failed=${report.failedRouteCount} gaps=${report.routingGapCount}`);
    for (const route of report.routeResults) {
      console.log(`- ${route.ok ? 'OK' : 'FAIL'} ${route.key} ${route.durationMs}ms${route.error ? ` error=${route.error}` : ''}`);
    }
    if (report.routingGapCount) {
      console.log(`routing_gaps=${report.agentResults.filter((item) => item.skippedReason === 'no_explicit_luna_llm_route').map((item) => item.agent).join(',')}`);
    }
  }
  return report;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna-agent-llm-primary-fallback-call-drill 실패:',
  });
}

export {
  buildAgentRouteCoverage,
  runDrill,
};
