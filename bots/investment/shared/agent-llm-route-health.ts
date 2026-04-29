// @ts-nocheck
/**
 * Agent LLM route health helpers.
 *
 * This module is intentionally small and side-effect light: it classifies
 * recent route failures, recommends temporary provider avoidance, and reorders
 * Hub chains without removing the last-resort fallback entries.
 */

import * as db from './db.ts';

const DEFAULT_LOOKBACK_MINUTES = 60;
const DEFAULT_MIN_CALLS = 2;
const DEFAULT_FAIL_THRESHOLD = 0.5;

export function classifyRouteFailure(error = '') {
  const text = String(error || '').toLowerCase();
  if (!text) return 'unknown';
  if (/provider_cooldown|cooldown|circuit/.test(text)) return 'cooldown';
  if (/unauthori[sz]ed|forbidden|invalid[_ -]?api|invalid[_ -]?key|oauth|token|permission|권한/.test(text)) return 'auth';
  if (/quota|rate[_ -]?limit|429|billing|insufficient[_ -]?quota/.test(text)) return 'quota';
  if (/timeout|timed out|abort/.test(text)) return 'timeout';
  if (/empty|blank|no[_ -]?content|response_not_ok|bad_response/.test(text)) return 'empty_response';
  return 'unknown';
}

export function normalizeProviderName(value = '') {
  const provider = String(value || '').trim().toLowerCase();
  if (!provider) return '';
  if (provider === 'openai' || provider.startsWith('openai-oauth')) return 'openai-oauth';
  if (provider === 'gemini' || provider.startsWith('gemini-oauth')) return 'gemini-oauth';
  if (provider.startsWith('claude-code')) return 'claude-code';
  if (provider.startsWith('groq')) return 'groq';
  return provider;
}

export function providerFromRouteEntry(entry = {}) {
  return normalizeProviderName(entry?.provider || String(entry || '').split('/')[0]);
}

function parseRouteChain(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function providersFromRouteChain(value) {
  const seen = new Set();
  const providers = [];
  for (const entry of parseRouteChain(value)) {
    const provider = providerFromRouteEntry(entry);
    if (!provider || seen.has(provider)) continue;
    seen.add(provider);
    providers.push(provider);
  }
  return providers;
}

export function summarizeRouteHealth(rows = [], {
  minCalls = DEFAULT_MIN_CALLS,
  failThreshold = DEFAULT_FAIL_THRESHOLD,
} = {}) {
  const summary = new Map();
  for (const row of rows || []) {
    const explicitProvider = normalizeProviderName(row.provider);
    const providers = explicitProvider && explicitProvider !== 'failed' && explicitProvider !== 'hub'
      ? [explicitProvider]
      : providersFromRouteChain(row.route_chain);
    const targets = providers.length > 0 ? providers : [explicitProvider || 'unknown'];
    for (const provider of targets) {
      const current = summary.get(provider) || {
        provider,
        calls: 0,
        failed: 0,
        fallback: 0,
        lastError: null,
        lastFailureKind: 'unknown',
        lastSeenAt: null,
      };
      const calls = Math.max(1, Number(row.calls || 1));
      const failed = Math.max(0, Number(row.failed_calls ?? (row.response_ok === false ? 1 : 0)));
      current.calls += calls;
      current.failed += failed;
      current.fallback += Math.max(0, Number(row.fallback_calls ?? (row.fallback_used ? 1 : 0)));
      const rowSeenAt = row.last_seen_at || row.created_at || null;
      if (!current.lastSeenAt || new Date(rowSeenAt || 0).getTime() >= new Date(current.lastSeenAt || 0).getTime()) {
        current.lastSeenAt = rowSeenAt;
        current.lastError = row.error || current.lastError;
        current.lastFailureKind = classifyRouteFailure(row.error || '');
      }
      summary.set(provider, current);
    }
  }

  return Array.from(summary.values()).map((item) => {
    const failureRate = item.calls > 0 ? item.failed / item.calls : 0;
    return {
      ...item,
      failureRate,
      healthy: item.calls < minCalls || failureRate < failThreshold,
      avoid: item.calls >= minCalls && failureRate >= failThreshold,
    };
  });
}

export function deriveAvoidProvidersFromHealth(health = []) {
  return Array.from(new Set(
    (health || [])
      .filter((item) => item?.avoid)
      .map((item) => normalizeProviderName(item.provider))
      .filter(Boolean),
  ));
}

export function reorderChainForRouteHealth(chain = [], avoidProviders = []) {
  const avoid = new Set((avoidProviders || []).map(normalizeProviderName).filter(Boolean));
  if (!avoid.size) return Array.isArray(chain) ? [...chain] : [];
  const healthy = [];
  const avoided = [];
  for (const entry of chain || []) {
    const provider = normalizeProviderName(entry?.provider);
    if (avoid.has(provider)) avoided.push(entry);
    else healthy.push(entry);
  }
  return [...healthy, ...avoided];
}

export async function loadRouteHealthRows({
  agentName,
  market = 'all',
  taskType = 'default',
  lookbackMinutes = DEFAULT_LOOKBACK_MINUTES,
  limit = 100,
} = {}) {
  const minutes = Math.max(1, Math.round(Number(lookbackMinutes || DEFAULT_LOOKBACK_MINUTES)));
  const normalizedMarket = String(market || 'all').toLowerCase();
  const normalizedTask = String(taskType || 'default').toLowerCase();
  const safeLimit = Math.min(500, Math.max(1, Number(limit || 100)));
  return db.query(
    `SELECT provider, response_ok, fallback_used, error, route_chain, created_at
       FROM investment.llm_routing_log
      WHERE created_at >= NOW() - ($1::int * INTERVAL '1 minute')
        AND ($2::text = '' OR agent_name = $2)
        AND ($3::text = 'all' OR market = $3 OR market IS NULL)
        AND ($4::text = 'default' OR task_type = $4 OR task_type IS NULL)
      ORDER BY created_at DESC
      LIMIT $5`,
    [
      minutes,
      String(agentName || ''),
      normalizedMarket,
      normalizedTask,
      safeLimit,
    ],
  ).catch(() => []);
}

export async function buildRouteHealthAvoidance({
  agentName,
  market,
  taskType,
  lookbackMinutes,
  minCalls = DEFAULT_MIN_CALLS,
  failThreshold = DEFAULT_FAIL_THRESHOLD,
} = {}) {
  const rows = await loadRouteHealthRows({ agentName, market, taskType, lookbackMinutes });
  const health = summarizeRouteHealth(rows, { minCalls, failThreshold });
  const avoidProviders = deriveAvoidProvidersFromHealth(health);
  return {
    enabled: process.env.LUNA_AGENT_LLM_ROUTE_HEALTH_ENABLED !== 'false',
    rowsChecked: rows.length,
    health,
    avoidProviders,
  };
}

export default {
  classifyRouteFailure,
  normalizeProviderName,
  providerFromRouteEntry,
  summarizeRouteHealth,
  deriveAvoidProvidersFromHealth,
  reorderChainForRouteHealth,
  loadRouteHealthRows,
  buildRouteHealthAvoidance,
};
