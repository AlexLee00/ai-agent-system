#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { resolveAgentMemoryRuntimeFlags, isAgentMemoryModeAtLeast } from '../shared/agent-memory-runtime.ts';
import { resolveHubRoutingPlan } from '../shared/agent-llm-routing.ts';
import { getMessageBusHygiene } from '../shared/agent-message-bus.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function parseArgs(argv = process.argv.slice(2)) {
  return {
    json: argv.includes('--json'),
    strict: argv.includes('--strict'),
    market: argv.find((arg) => arg.startsWith('--market='))?.split('=')[1] || 'crypto',
  };
}

async function tableExists(tableName: string) {
  const rows = await db.query(
    `SELECT 1
       FROM information_schema.tables
      WHERE table_schema = 'investment'
        AND table_name = $1
      LIMIT 1`,
    [tableName],
  ).catch(() => []);
  return rows.length > 0;
}

async function countRows(tableName: string) {
  const rows = await db.query(`SELECT COUNT(*) AS count FROM investment.${tableName}`).catch(() => []);
  return Number(rows?.[0]?.count || 0);
}

export async function buildAgentMemoryDoctorReport({ market = 'crypto', strict = false } = {}) {
  await db.initSchema();
  const flags = resolveAgentMemoryRuntimeFlags();
  const requiredTables = [
    'agent_context_log',
    'agent_curriculum_state',
    'agent_messages',
    'agent_short_term_memory',
    'entity_facts',
    'llm_failure_reflexions',
    'llm_routing_log',
    'luna_posttrade_skills',
    'luna_rag_documents',
  ];
  const tables = [];
  for (const tableName of requiredTables) {
    const exists = await tableExists(tableName);
    tables.push({
      tableName,
      exists,
      rowCount: exists ? await countRows(tableName).catch(() => null) : null,
    });
  }

  const sampleRoutes = [
    { agent: 'luna', market, task: 'final_decision' },
    { agent: 'sophia', market, task: 'sentiment' },
    { agent: 'argos', market, task: 'screening' },
    { agent: 'oracle', market, task: 'onchain' },
  ].map((item) => ({
    ...item,
    plan: resolveHubRoutingPlan(item.agent, item.market, item.task, 512),
  }));

  const recentRoutes = await db.query(
    `SELECT
       agent_name,
       provider,
       response_ok,
       fallback_used,
       market,
       task_type,
       latency_ms,
       created_at
     FROM investment.llm_routing_log
     ORDER BY created_at DESC
     LIMIT 20`,
  ).catch(() => []);

  const busHygiene = await getMessageBusHygiene({ staleHours: 6, limit: 20 });

  const blockers = [];
  const warnings = [];
  const missingTables = tables.filter((row) => !row.exists).map((row) => row.tableName);
  if (missingTables.length) blockers.push(`missing_tables:${missingTables.join(',')}`);
  if (isAgentMemoryModeAtLeast('shadow') && !flags.memoryAutoPrefix) warnings.push('memory_mode_active_but_auto_prefix_disabled');
  if (flags.memoryAutoPrefix && (!flags.personaEnabled || !flags.constitutionEnabled)) warnings.push('auto_prefix_without_persona_or_constitution');
  if (flags.llmRoutingEnabled && sampleRoutes.some((row) => !row.plan?.chain?.length && row.plan?.route?.noLLM !== true)) {
    blockers.push('llm_routing_enabled_but_chain_missing');
  }
  if (Number(busHygiene?.staleCount || 0) > 0) warnings.push(`stale_agent_messages:${busHygiene.staleCount}`);
  if (strict && warnings.length) blockers.push(`strict_warnings:${warnings.join(',')}`);

  return {
    ok: blockers.length === 0,
    status: blockers.length ? 'agent_memory_doctor_blocked' : 'agent_memory_doctor_clear',
    generatedAt: new Date().toISOString(),
    strict,
    market,
    runtimeFlags: flags,
    tables,
    sampleRoutes,
    recentRoutes,
    busHygiene,
    warnings,
    blockers,
  };
}

async function main() {
  const args = parseArgs();
  const report = await buildAgentMemoryDoctorReport({ market: args.market, strict: args.strict });
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(`${report.status} warnings=${report.warnings.length} blockers=${report.blockers.length}`);
  if (args.strict && !report.ok) process.exitCode = 1;
  return report;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-agent-memory-doctor 실패:',
  });
}
