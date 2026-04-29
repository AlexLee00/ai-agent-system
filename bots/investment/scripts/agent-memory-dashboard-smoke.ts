#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  buildAgentMemoryDashboard,
  buildAgentMemoryDashboardReadiness,
  recordAgentMemoryDashboard,
} from './runtime-agent-memory-dashboard.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function runSmoke() {
  const report = await buildAgentMemoryDashboard({ days: 3, market: 'all' });
  assert.equal(report?.ok, true, 'dashboard build ok');
  assert.equal(report?.event_type, 'agent_memory_dashboard_report', 'event_type fixed');
  assert.ok(report?.summary?.context_calls >= 0, 'summary context count exists');
  assert.ok(report?.summary?.route_calls >= 0, 'summary route count exists');
  assert.ok(Array.isArray(report?.layer_coverage), 'layer coverage exists');
  assert.ok(Array.isArray(report?.llm_routes), 'llm route rows exists');
  assert.ok(Array.isArray(report?.message_bus_hygiene), 'message bus hygiene exists');
  assert.equal(report?.readiness?.phase, 'memory_phase_h_dashboard', 'memory phase H readiness exists');
  assert.ok(['agent_memory_dashboard_ready', 'agent_memory_dashboard_attention', 'agent_memory_dashboard_blocked'].includes(report?.status), 'dashboard status classified');

  const dry = await recordAgentMemoryDashboard(report, { dryRun: true });
  assert.equal(dry?.ok, true, 'dry record ok');
  assert.equal(dry?.recorded, false, 'dry run must not publish');

  const emptyReadiness = buildAgentMemoryDashboardReadiness({
    summary: {
      context_calls: 0,
      curriculum_agents: 0,
      skill_groups: 0,
      route_calls: 0,
      route_failures: 0,
      stale_bus_messages: 0,
    },
  });
  assert.equal(emptyReadiness.ok, true, 'empty dashboard should warn, not hard fail');
  assert.equal(emptyReadiness.status, 'agent_memory_dashboard_attention');
  assert.equal(emptyReadiness.warnings.includes('agent_context_log_empty'), true);
  assert.equal(emptyReadiness.warnings.includes('llm_route_log_empty'), true);

  const populatedReadiness = buildAgentMemoryDashboardReadiness({
    summary: {
      context_calls: 10,
      curriculum_agents: 2,
      skill_groups: 3,
      route_calls: 10,
      route_failures: 4,
      route_fallbacks: 1,
      stale_bus_messages: 2,
    },
  });
  assert.equal(populatedReadiness.warnings.includes('stale_bus_messages_2'), true);
  assert.equal(populatedReadiness.warnings.includes('llm_route_failure_rate_40pct'), true);

  return {
    ok: true,
    event_type: report.event_type,
    summary: report.summary,
    readiness: report.readiness,
  };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('agent-memory-dashboard-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ agent-memory-dashboard-smoke 실패:',
  });
}
