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

  const curriculumRows = await getAllCurriculumStates(normalizedMarket === 'all' ? undefined : normalizedMarket)
    .catch(() => []);

  return {
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
    },
    context_log: contextRows,
    curriculum: curriculumRows,
    message_bus: messageBusRows,
    llm_failures: failureRows,
    skills: skillRows,
  };
}

export async function recordAgentMemoryDashboard(report, { dryRun = false } = {}) {
  if (dryRun) return { ok: true, recorded: false, dryRun: true };
  const summary = report?.summary || {};
  const msg = [
    `🧠 Agent Memory Dashboard (${report?.market || 'all'}, ${report?.days || 7}d)`,
    `context_calls=${summary.context_calls || 0}, curriculum_agents=${summary.curriculum_agents || 0}`,
    `bus_edges=${summary.message_bus_edges || 0}, failures=${summary.failure_rows || 0}, skills=${summary.skill_groups || 0}`,
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

