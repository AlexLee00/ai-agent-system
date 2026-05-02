#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { publishAlert } from '../shared/alert-publisher.ts';
import { getAllCurriculumStates } from '../shared/agent-curriculum-tracker.ts';
import { resolveAgentMemoryRuntimeFlags } from '../shared/agent-memory-runtime.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const daysRaw = argv.find((arg) => arg.startsWith('--days='))?.split('=')[1];
  const market = argv.find((arg) => arg.startsWith('--market='))?.split('=')[1] || 'all';
  return {
    days: Math.max(1, Number(daysRaw || 7) || 7),
    market: String(market || 'all').trim().toLowerCase() || 'all',
    dryRun: argv.includes('--dry-run'),
    json: argv.includes('--json'),
  };
}

export function buildAgentMemoryDashboardReadiness(report = {}) {
  const summary = report?.summary || {};
  const warnings = [];
  const blockers = [];
  const routeCalls = Number(summary.route_calls || 0);
  const routeFailures = Number(summary.route_failures || 0);
  const contextCalls = Number(summary.context_calls || 0);
  const staleBusMessages = Number(summary.stale_bus_messages || 0);

  if (contextCalls === 0) warnings.push('agent_context_log_empty');
  if (routeCalls === 0) warnings.push('llm_route_log_empty');
  if (Number(summary.curriculum_agents || 0) === 0) warnings.push('curriculum_state_empty');
  if (Number(summary.skill_groups || 0) === 0) warnings.push('posttrade_skill_groups_empty');
  if (staleBusMessages > 0) warnings.push(`stale_bus_messages_${staleBusMessages}`);
  if (routeCalls > 0 && routeFailures / routeCalls >= 0.3) {
    warnings.push(`llm_route_failure_rate_${Math.round((routeFailures / routeCalls) * 100)}pct`);
  }

  return {
    ok: blockers.length === 0,
    status: blockers.length > 0
      ? 'agent_memory_dashboard_blocked'
      : warnings.length > 0
        ? 'agent_memory_dashboard_attention'
        : 'agent_memory_dashboard_ready',
    phase: 'memory_phase_h_dashboard',
    blockers,
    warnings,
    metrics: {
      contextCalls,
      routeCalls,
      routeFailures,
      routeFallbacks: Number(summary.route_fallbacks || 0),
      staleBusMessages,
      curriculumAgents: Number(summary.curriculum_agents || 0),
      skillGroups: Number(summary.skill_groups || 0),
      failureRows: Number(summary.failure_rows || 0),
    },
  };
}

export async function buildAgentMemoryDashboard({ days = 7, market = 'all' } = {}) {
  await db.initSchema();
  const normalizedMarket = String(market || 'all').trim().toLowerCase() || 'all';
  const dayWindow = Math.max(1, Number(days || 7) || 7);
  const flags = resolveAgentMemoryRuntimeFlags();

  const contextRows = await db.query(
    `SELECT
       agent_name,
       market,
       task_type,
       COUNT(*) AS calls,
       SUM(CASE WHEN working_state_used THEN 1 ELSE 0 END) AS working_used,
       AVG(total_prefix_chars) AS avg_prefix_chars
     FROM investment.agent_context_log
     WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
       AND ($2::text = 'all' OR market = $2 OR market IS NULL)
     GROUP BY agent_name, market, task_type
     ORDER BY calls DESC, avg_prefix_chars DESC
     LIMIT 100`,
    [dayWindow, normalizedMarket],
  ).catch(() => []);

  const messageBusRows = await db.query(
    `SELECT
       from_agent,
       to_agent,
       COUNT(*) AS message_count,
       SUM(CASE WHEN responded_at IS NOT NULL THEN 1 ELSE 0 END) AS responded_count
     FROM investment.agent_messages
     WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
     GROUP BY from_agent, to_agent
     ORDER BY message_count DESC
     LIMIT 100`,
    [dayWindow],
  ).catch(() => []);

  const failureRows = await db.query(
    `SELECT agent_name, provider, error_type, failure_count, last_failed_at
       FROM investment.llm_failure_reflexions
      WHERE last_failed_at >= NOW() - ($1::int * INTERVAL '1 day')
      ORDER BY failure_count DESC, last_failed_at DESC
      LIMIT 50`,
    [dayWindow],
  ).catch(() => []);

  const skillRows = await db.query(
    `SELECT market, agent_name, skill_type, COUNT(*) AS skill_count, MAX(updated_at) AS last_updated_at
       FROM investment.luna_posttrade_skills
      WHERE ($1::text = 'all' OR market = $1 OR market = 'all')
      GROUP BY market, agent_name, skill_type
      ORDER BY skill_count DESC, last_updated_at DESC
      LIMIT 100`,
    [normalizedMarket],
  ).catch(() => []);

  const routeRows = await db.query(
    `SELECT
       agent_name,
       COALESCE(market, 'any') AS market,
       COALESCE(task_type, 'default') AS task_type,
       COALESCE(provider, 'unknown') AS provider,
       COUNT(*) AS calls,
       SUM(CASE WHEN response_ok IS TRUE THEN 1 ELSE 0 END) AS ok_calls,
       SUM(CASE WHEN response_ok IS FALSE THEN 1 ELSE 0 END) AS failed_calls,
       SUM(CASE WHEN fallback_used THEN 1 ELSE 0 END) AS fallback_calls,
       AVG(latency_ms) AS avg_latency_ms,
       SUM(COALESCE(cost_usd, 0)) AS cost_usd
     FROM investment.llm_routing_log
     WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
       AND ($2::text = 'all' OR market = $2 OR market IS NULL)
     GROUP BY agent_name, market, task_type, provider
     ORDER BY calls DESC, failed_calls DESC, fallback_calls DESC
     LIMIT 100`,
    [dayWindow, normalizedMarket],
  ).catch(() => []);

  const layerCoverageRows = await db.query(
    `SELECT
       agent_name,
       COUNT(*) AS calls,
       SUM(CASE WHEN persona_loaded THEN 1 ELSE 0 END) AS persona_calls,
       SUM(CASE WHEN constitution_loaded THEN 1 ELSE 0 END) AS constitution_calls,
       SUM(CASE WHEN rag_docs_count > 0 THEN 1 ELSE 0 END) AS rag_hit_calls,
       SUM(CASE WHEN short_term_found > 0 THEN 1 ELSE 0 END) AS short_term_hit_calls,
       SUM(CASE WHEN skills_found > 0 THEN 1 ELSE 0 END) AS skill_hit_calls,
       SUM(CASE WHEN entity_facts_found > 0 THEN 1 ELSE 0 END) AS entity_hit_calls,
       SUM(CASE WHEN failures_found > 0 THEN 1 ELSE 0 END) AS failure_hit_calls,
       SUM(CASE WHEN working_state_used THEN 1 ELSE 0 END) AS working_state_calls
     FROM investment.agent_context_log
     WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
       AND ($2::text = 'all' OR market = $2 OR market IS NULL)
     GROUP BY agent_name
     ORDER BY calls DESC
     LIMIT 100`,
    [dayWindow, normalizedMarket],
  ).catch(() => []);

  const busHygieneRows = await db.query(
    `SELECT
       to_agent,
       COUNT(*) AS stale_unanswered,
       MIN(created_at) AS oldest_created_at
     FROM investment.agent_messages
     WHERE responded_at IS NULL
       AND message_type IN ('query', 'broadcast')
       AND created_at < NOW() - INTERVAL '6 hours'
     GROUP BY to_agent
     ORDER BY stale_unanswered DESC
     LIMIT 50`,
  ).catch(() => []);

  const curriculumRows = await getAllCurriculumStates(
    normalizedMarket === 'all' ? undefined : normalizedMarket,
    { includeDisabledState: true },
  )
    .catch(() => []);

  const routeCallCount = routeRows.reduce((sum, row) => sum + Number(row.calls || 0), 0);
  const routeFailureCount = routeRows.reduce((sum, row) => sum + Number(row.failed_calls || 0), 0);
  const routeFallbackCount = routeRows.reduce((sum, row) => sum + Number(row.fallback_calls || 0), 0);
  const staleMessageCount = busHygieneRows.reduce((sum, row) => sum + Number(row.stale_unanswered || 0), 0);

  const report = {
    ok: true,
    event_type: 'agent_memory_dashboard_report',
    generated_at: new Date().toISOString(),
    days: dayWindow,
    market: normalizedMarket,
    runtime_flags: flags,
    summary: {
      context_calls: contextRows.reduce((sum, row) => sum + Number(row.calls || 0), 0),
      curriculum_agents: curriculumRows.length,
      message_bus_edges: messageBusRows.length,
      failure_rows: failureRows.length,
      skill_groups: skillRows.length,
      route_calls: routeCallCount,
      route_failures: routeFailureCount,
      route_fallbacks: routeFallbackCount,
      stale_bus_messages: staleMessageCount,
    },
    context_log: contextRows,
    layer_coverage: layerCoverageRows,
    curriculum: curriculumRows,
    message_bus: messageBusRows,
    message_bus_hygiene: busHygieneRows,
    llm_failures: failureRows,
    llm_routes: routeRows,
    skills: skillRows,
  };
  const readiness = buildAgentMemoryDashboardReadiness(report);
  return {
    ...report,
    status: readiness.status,
    readiness,
    memory_phase_h_acceptance: readiness,
  };
}

export async function recordAgentMemoryDashboard(report, { dryRun = false } = {}) {
  if (dryRun) return { ok: true, recorded: false, dryRun: true };
  const summary = report?.summary || {};
  const msg = [
    `🧠 Agent Memory Dashboard (${report?.market || 'all'}, ${report?.days || 7}d)`,
    `context_calls=${summary.context_calls || 0}, curriculum_agents=${summary.curriculum_agents || 0}`,
    `bus_edges=${summary.message_bus_edges || 0}, failures=${summary.failure_rows || 0}, skills=${summary.skill_groups || 0}`,
    `llm_routes=${summary.route_calls || 0}, fallback=${summary.route_fallbacks || 0}, stale_bus=${summary.stale_bus_messages || 0}`,
  ].join('\n');
  const delivered = await publishAlert({
    from_bot: 'luna',
    event_type: 'agent_memory_dashboard_report',
    alert_level: 1,
    message: msg,
    payload: report,
  }).catch(() => false);
  return { ok: true, recorded: delivered === true };
}

async function main() {
  const args = parseArgs();
  const report = await buildAgentMemoryDashboard({ days: args.days, market: args.market });
  const record = await recordAgentMemoryDashboard(report, { dryRun: args.dryRun });
  const result = { ...report, record };
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`agent memory dashboard ok (recorded=${record.recorded})`);
  return result;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-agent-memory-dashboard 실패:',
  });
}
