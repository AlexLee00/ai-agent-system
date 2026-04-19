'use strict';

// Prometheus-compatible metrics (no prom-client dep — text/JSON format)

const pgPool = require('../../../../packages/core/lib/pg-pool');
const { getProviderStats } = require('../llm/provider-registry');

function gauge(name, labels, value) {
  const lblStr = Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',');
  return `${name}{${lblStr}} ${value}`;
}

async function fetchProviderRows() {
  try {
    return await pgPool.query('public', `
      SELECT
        provider,
        COUNT(*)::int AS total_calls,
        COUNT(*) FILTER (WHERE success = false)::int AS total_failures,
        ROUND(AVG(duration_ms))::int AS avg_latency_ms
      FROM llm_routing_log
      WHERE created_at > NOW() - INTERVAL '24 hours'
      GROUP BY provider
      ORDER BY total_calls DESC
    `);
  } catch {
    return [];
  }
}

async function fetchCostByTeam() {
  try {
    return await pgPool.query('public', `
      SELECT caller_team, ROUND(SUM(cost_usd)::numeric, 4) AS daily_cost_usd
      FROM llm_routing_log
      WHERE created_at > NOW() - INTERVAL '24 hours'
      GROUP BY caller_team
    `);
  } catch {
    return [];
  }
}

function mergeProviderStats(runtimeStats, providerRows) {
  const merged = {};

  for (const row of providerRows) {
    const provider = row.provider;
    const totalCalls = Number(row.total_calls || 0);
    const totalFailures = Number(row.total_failures || 0);
    const failureRate = totalCalls > 0 ? totalFailures / totalCalls : 0;
    merged[provider] = {
      state: 'UNKNOWN',
      total_calls: totalCalls,
      total_failures: totalFailures,
      failure_rate: failureRate,
      avg_latency_ms: Number(row.avg_latency_ms || 0),
      p99_latency_ms: 0,
    };
  }

  for (const [provider, stats] of Object.entries(runtimeStats || {})) {
    merged[provider] = {
      ...(merged[provider] || {}),
      ...stats,
    };
  }

  return merged;
}

async function metricsRoute(_req, res) {
  const runtimeStats = getProviderStats();
  const providerRows = await fetchProviderRows();
  const stats = mergeProviderStats(runtimeStats, providerRows);
  const lines = [];

  lines.push('# HELP llm_circuit_state Circuit Breaker state (0=CLOSED, 1=HALF_OPEN, 2=OPEN)');
  lines.push('# TYPE llm_circuit_state gauge');
  for (const [provider, s] of Object.entries(stats)) {
    const stateVal = s.state === 'OPEN' ? 2 : s.state === 'HALF_OPEN' ? 1 : 0;
    lines.push(gauge('llm_circuit_state', { provider }, stateVal));
  }

  lines.push('# HELP llm_failure_rate Provider failure rate (0.0-1.0)');
  lines.push('# TYPE llm_failure_rate gauge');
  for (const [provider, s] of Object.entries(stats)) {
    lines.push(gauge('llm_failure_rate', { provider }, s.failure_rate || 0));
  }

  lines.push('# HELP llm_avg_latency_ms Provider average latency in ms');
  lines.push('# TYPE llm_avg_latency_ms gauge');
  for (const [provider, s] of Object.entries(stats)) {
    lines.push(gauge('llm_avg_latency_ms', { provider }, s.avg_latency_ms || 0));
  }

  const costRows = await fetchCostByTeam();
  lines.push('# HELP llm_daily_cost_usd Daily LLM cost in USD per team');
  lines.push('# TYPE llm_daily_cost_usd gauge');
  for (const row of costRows) {
    lines.push(gauge('llm_daily_cost_usd', { team: row.caller_team || 'unknown' }, Number(row.daily_cost_usd)));
  }

  res.set('Content-Type', 'text/plain; version=0.0.4');
  res.end(lines.join('\n') + '\n');
}

async function metricsJsonRoute(_req, res) {
  const runtimeStats = getProviderStats();
  const providerRows = await fetchProviderRows();
  const stats = mergeProviderStats(runtimeStats, providerRows);
  let costByTeam = {};
  const costRows = await fetchCostByTeam();
  for (const row of costRows) {
    costByTeam[row.caller_team || 'unknown'] = Number(row.daily_cost_usd);
  }

  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    providers: stats,
    daily_cost_by_team: costByTeam,
    summary: {
      healthy: Object.values(stats).filter(s => s.state === 'CLOSED').length,
      degraded: Object.values(stats).filter(s => s.state === 'HALF_OPEN').length,
      down: Object.values(stats).filter(s => s.state === 'OPEN').length,
      unknown: Object.values(stats).filter(s => s.state === 'UNKNOWN').length,
    },
  });
}

module.exports = { metricsRoute, metricsJsonRoute };
