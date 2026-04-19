'use strict';

// Prometheus-compatible metrics (no prom-client dep — text/JSON format)

const pgPool = require('../../../../packages/core/lib/pg-pool');
const { getProviderStats } = require('../llm/provider-registry');

function gauge(name, labels, value) {
  const lblStr = Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',');
  return `${name}{${lblStr}} ${value}`;
}

async function metricsRoute(_req, res) {
  const stats = getProviderStats();
  const lines = [];

  lines.push('# HELP llm_circuit_state Circuit Breaker state (0=CLOSED, 1=HALF_OPEN, 2=OPEN)');
  lines.push('# TYPE llm_circuit_state gauge');
  for (const [provider, s] of Object.entries(stats)) {
    const stateVal = s.state === 'CLOSED' ? 0 : s.state === 'HALF_OPEN' ? 1 : 2;
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

  try {
    const result = await pgPool.query(`
      SELECT caller_team, ROUND(SUM(cost_usd)::numeric, 4) AS daily_cost_usd
      FROM llm_routing_log
      WHERE created_at > NOW() - INTERVAL '24 hours'
      GROUP BY caller_team
    `);
    lines.push('# HELP llm_daily_cost_usd Daily LLM cost in USD per team');
    lines.push('# TYPE llm_daily_cost_usd gauge');
    for (const row of result.rows) {
      lines.push(gauge('llm_daily_cost_usd', { team: row.caller_team || 'unknown' }, Number(row.daily_cost_usd)));
    }
  } catch {}

  res.set('Content-Type', 'text/plain; version=0.0.4');
  res.end(lines.join('\n') + '\n');
}

async function metricsJsonRoute(_req, res) {
  const stats = getProviderStats();
  let costByTeam = {};
  try {
    const result = await pgPool.query(`
      SELECT caller_team, ROUND(SUM(cost_usd)::numeric, 4) AS daily_cost_usd
      FROM llm_routing_log
      WHERE created_at > NOW() - INTERVAL '24 hours'
      GROUP BY caller_team
    `);
    for (const row of result.rows) {
      costByTeam[row.caller_team || 'unknown'] = Number(row.daily_cost_usd);
    }
  } catch {}

  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    providers: stats,
    daily_cost_by_team: costByTeam,
    summary: {
      healthy: Object.values(stats).filter(s => s.state === 'CLOSED').length,
      degraded: Object.values(stats).filter(s => s.state === 'HALF_OPEN').length,
      down: Object.values(stats).filter(s => s.state === 'OPEN').length,
    },
  });
}

module.exports = { metricsRoute, metricsJsonRoute };
