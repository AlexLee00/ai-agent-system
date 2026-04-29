#!/usr/bin/env node
// @ts-nocheck

import { resolveHubRoutingPlan } from '../shared/agent-llm-routing.ts';
import { reorderChainForRouteHealth } from '../shared/agent-llm-route-health.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const DEFAULT_TASKS = [
  'discovery',
  'validation',
  'final_decision',
  'posttrade_feedback',
];

function parseArgs(argv = process.argv.slice(2)) {
  const get = (name, fallback = '') => argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=') || fallback;
  return {
    market: get('market', 'binance'),
    tasks: get('tasks', DEFAULT_TASKS.join(',')).split(',').map((item) => item.trim()).filter(Boolean),
    avoidProviders: get('avoid', '').split(',').map((item) => item.trim()).filter(Boolean),
    maxTokens: Math.max(1, Number(get('max-tokens', '512')) || 512),
    json: argv.includes('--json'),
  };
}

export function buildLunaLlmRouteDrill({
  market = 'binance',
  tasks = DEFAULT_TASKS,
  avoidProviders = [],
  maxTokens = 512,
} = {}) {
  const routes = [];
  for (const task of tasks) {
    const plan = resolveHubRoutingPlan('luna', market, task, maxTokens);
    const chain = reorderChainForRouteHealth(plan.chain, avoidProviders);
    routes.push({
      agent: 'luna',
      market,
      taskType: task,
      enabled: plan.enabled,
      abstractModel: plan.abstractModel,
      primary: plan.route.primary,
      noLLM: plan.route.noLLM === true,
      chain,
      chainProviders: chain.map((entry) => entry.provider),
      avoidedProvidersMovedToTail: avoidProviders.length > 0
        ? chain.filter((entry) => avoidProviders.includes(entry.provider)).map((entry) => entry.provider)
        : [],
    });
  }
  const blockers = routes.flatMap((route) => {
    if (route.noLLM) return [];
    if (!Array.isArray(route.chain) || route.chain.length === 0) return [`${route.taskType}:empty_chain`];
    return [];
  });
  return {
    ok: blockers.length === 0,
    status: blockers.length ? 'luna_llm_route_drill_blocked' : 'luna_llm_route_drill_ready',
    generatedAt: new Date().toISOString(),
    market,
    avoidProviders,
    routes,
    blockers,
  };
}

async function main() {
  const args = parseArgs();
  const report = buildLunaLlmRouteDrill(args);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(`${report.status} routes=${report.routes.length}`);
  return report;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna-llm-route-drill 실패:',
  });
}
