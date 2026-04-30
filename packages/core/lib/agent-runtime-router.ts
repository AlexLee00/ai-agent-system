// @ts-nocheck

const DEFAULT_RUNTIME_ORDER = ['typescript', 'elixir_shadow', 'elixir_parallel'];

export function normalizeRuntime(runtime = 'typescript') {
  const value = String(runtime || 'typescript').trim().toLowerCase();
  if (['ts', 'node', 'typescript'].includes(value)) return 'typescript';
  if (['elixir', 'elixir_shadow', 'shadow'].includes(value)) return 'elixir_shadow';
  if (['elixir_parallel', 'parallel'].includes(value)) return 'elixir_parallel';
  return value;
}

export function resolveAgentRuntime(agent = {}, env = process.env) {
  const requested = normalizeRuntime(agent.runtime || 'typescript');
  const elixirEnabled = String(env.LUNA_ELIXIR_AGENTS_ENABLED ?? 'true').toLowerCase() !== 'false';
  const parallelTs = String(env.LUNA_ELIXIR_AGENTS_PARALLEL_TS ?? 'true').toLowerCase() !== 'false';
  if (!elixirEnabled && requested.startsWith('elixir')) {
    return {
      agent: agent.name,
      runtime: 'typescript',
      shadow: false,
      parallel: false,
      reason: 'elixir_agents_disabled',
    };
  }
  if (requested === 'elixir_parallel') {
    return {
      agent: agent.name,
      runtime: 'elixir',
      shadow: true,
      parallel: parallelTs,
      tsFallback: true,
      reason: parallelTs ? 'parallel_shadow_enabled' : 'parallel_ts_disabled',
    };
  }
  if (requested === 'elixir_shadow') {
    return {
      agent: agent.name,
      runtime: 'elixir',
      shadow: true,
      parallel: false,
      tsFallback: true,
      reason: 'shadow_only',
    };
  }
  return {
    agent: agent.name,
    runtime: requested,
    shadow: false,
    parallel: false,
    tsFallback: DEFAULT_RUNTIME_ORDER.includes(requested),
    reason: 'runtime_selected',
  };
}

export function buildRuntimePlan(agents = [], env = process.env) {
  const routes = agents.map((agent) => resolveAgentRuntime(agent, env));
  return {
    ok: true,
    totalAgents: routes.length,
    elixirShadow: routes.filter((route) => route.runtime === 'elixir' && route.shadow).length,
    parallel: routes.filter((route) => route.parallel).length,
    routes,
  };
}

export default {
  normalizeRuntime,
  resolveAgentRuntime,
  buildRuntimePlan,
};
