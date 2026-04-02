'use strict';

function buildObservabilityPlan(input = {}) {
  const system = String(input.system || 'unknown');
  const failureModes = Array.isArray(input.failure_modes) ? input.failure_modes : [];

  const metrics = ['latency', 'error_rate', 'throughput'];
  const alerts = [];
  const dashboards = [`${system}-health`, `${system}-quality`];
  const gaps = [];

  if (failureModes.includes('data_stale')) {
    metrics.push('freshness');
    alerts.push('freshness threshold breach');
  } else {
    gaps.push('freshness metric not specified');
  }

  if (failureModes.includes('cost_spike')) {
    metrics.push('cost_per_run');
    alerts.push('cost spike');
  }

  if (failureModes.includes('quality_drop')) {
    metrics.push('quality_score');
    alerts.push('quality drop');
  } else {
    gaps.push('quality guardrail not specified');
  }

  return {
    metrics: [...new Set(metrics)],
    alerts: [...new Set(alerts)],
    dashboards,
    gaps,
  };
}

module.exports = {
  buildObservabilityPlan,
};

