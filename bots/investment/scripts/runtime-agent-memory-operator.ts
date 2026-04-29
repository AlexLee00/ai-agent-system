#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { publishAlert } from '../shared/alert-publisher.ts';
import { buildAgentMemoryActivationPlan, buildAgentLlmRouteQualityReport } from '../shared/agent-memory-operational-policy.ts';
import { resolveAgentMemoryRuntimeFlags } from '../shared/agent-memory-runtime.ts';
import { expireStaleAgentMessages, getMessageBusHygiene } from '../shared/agent-message-bus.ts';
import { buildAgentMemoryDashboard, recordAgentMemoryDashboard } from './runtime-agent-memory-dashboard.ts';
import { buildAgentMemoryDoctorReport } from './runtime-agent-memory-doctor.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function parseArgs(argv = process.argv.slice(2)) {
  return {
    days: Math.max(1, Number(argv.find((arg) => arg.startsWith('--days='))?.split('=')[1] || 3) || 3),
    market: argv.find((arg) => arg.startsWith('--market='))?.split('=')[1] || 'all',
    staleHours: Math.max(1, Number(argv.find((arg) => arg.startsWith('--stale-hours='))?.split('=')[1] || 24) || 24),
    applyBusHygiene: argv.includes('--apply-bus-hygiene'),
    writeSuggestions: argv.includes('--write-suggestions'),
    dryRun: argv.includes('--dry-run') || (!argv.includes('--publish') && !argv.includes('--write-suggestions')),
    publish: argv.includes('--publish'),
    strict: argv.includes('--strict'),
    json: argv.includes('--json'),
  };
}

function buildOperatorSuggestions({ activationPlan, routeQuality, busHygiene }) {
  const suggestions = [];
  if (activationPlan.nextPhase) {
    suggestions.push({
      type: 'agent_memory_activation_next_phase',
      key: `runtime_config.luna.agentMemory.${activationPlan.nextPhase}`,
      recommendedEnvPatch: activationPlan.recommendedEnvPatch,
      reason: activationPlan.nextDescription,
    });
  }
  for (const item of routeQuality.suggestions || []) {
    suggestions.push({
      type: item.type,
      key: `runtime_config.luna.agentLlmRoutes.${item.agent}.${item.market}.${item.taskType}`,
      provider: item.provider,
      severity: item.severity,
      reason: item.recommendation,
      metrics: {
        calls: item.calls,
        failureRate: item.failureRate,
        fallbackRate: item.fallbackRate,
      },
    });
  }
  if (Number(busHygiene?.staleCount || 0) > 0) {
    suggestions.push({
      type: 'agent_message_bus_hygiene',
      key: 'runtime_config.luna.agentMessageBus.staleHours',
      reason: `응답되지 않은 stale agent message ${busHygiene.staleCount}건이 있습니다.`,
      action: 'runtime:agent-message-bus-hygiene --apply 후보',
    });
  }
  return suggestions;
}

export async function runAgentMemoryOperator(input = {}) {
  const args = {
    days: input.days ?? 3,
    market: input.market || 'all',
    staleHours: input.staleHours ?? 24,
    applyBusHygiene: input.applyBusHygiene === true,
    writeSuggestions: input.writeSuggestions === true,
    dryRun: input.dryRun !== false,
    publish: input.publish === true,
    strict: input.strict === true,
  };
  await db.initSchema();

  const flags = resolveAgentMemoryRuntimeFlags();
  const activationPlan = buildAgentMemoryActivationPlan(flags);
  const doctor = await buildAgentMemoryDoctorReport({
    market: args.market === 'all' ? 'crypto' : args.market,
    strict: args.strict,
  });
  const dashboard = await buildAgentMemoryDashboard({ days: args.days, market: args.market });
  const routeQuality = await buildAgentLlmRouteQualityReport({
    days: args.days,
    market: args.market,
    minCalls: 2,
  });
  const busHygieneBefore = await getMessageBusHygiene({ staleHours: args.staleHours, limit: 100 });
  const busAction = await expireStaleAgentMessages({
    staleHours: args.staleHours,
    limit: 100,
    dryRun: !args.applyBusHygiene,
  });
  const suggestions = buildOperatorSuggestions({
    activationPlan,
    routeQuality,
    busHygiene: busHygieneBefore,
  });
  const blockers = [
    ...(activationPlan.blockers || []),
    ...(doctor.blockers || []),
    ...(routeQuality.ok ? [] : ['route_quality_high_severity']),
  ];
  const result = {
    ok: blockers.length === 0,
    status: blockers.length ? 'agent_memory_operator_blocked' : 'agent_memory_operator_ready',
    generatedAt: new Date().toISOString(),
    dryRun: args.dryRun,
    market: args.market,
    flags,
    activationPlan,
    doctor: {
      ok: doctor.ok,
      status: doctor.status,
      warnings: doctor.warnings,
      blockers: doctor.blockers,
    },
    dashboardSummary: dashboard.summary,
    routeQuality,
    busHygiene: {
      before: busHygieneBefore,
      action: busAction,
    },
    suggestions,
    blockers,
  };

  if (args.writeSuggestions && suggestions.length > 0) {
    result.suggestionLog = await db.insertRuntimeConfigSuggestionLog({
      periodDays: args.days,
      actionableCount: suggestions.length,
      marketSummary: {
        market: args.market,
        source: 'agent_memory_operator',
        status: result.status,
      },
      suggestions,
      policySnapshot: result,
      reviewStatus: 'pending',
      reviewNote: 'agent_memory_operator generated suggestions',
    }).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  }

  if (args.publish) {
    await recordAgentMemoryDashboard(dashboard, { dryRun: false }).catch(() => null);
    await publishAlert({
      from_bot: 'luna',
      event_type: 'agent_memory_operator',
      alert_level: result.ok ? 1 : 2,
      message: [
        '🧠 Luna Agent Memory Operator',
        `status=${result.status}`,
        `next=${activationPlan.nextPhase || 'none'}`,
        `suggestions=${suggestions.length}`,
        `route_suggestions=${routeQuality.suggestions.length}`,
        `stale_bus=${busHygieneBefore.staleCount || 0}`,
      ].join('\n'),
      payload: result,
    }).catch(() => false);
  }

  return result;
}

async function main() {
  const args = parseArgs();
  const result = await runAgentMemoryOperator(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`${result.status} suggestions=${result.suggestions.length} blockers=${result.blockers.length}`);
  if (args.strict && !result.ok) process.exitCode = 1;
  return result;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-agent-memory-operator 실패:',
  });
}
