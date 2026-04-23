#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildInvestmentAgentRoleSummary } from '../shared/agent-role-state.ts';
import { buildPositionReevaluationSummary } from './position-reevaluation-summary.ts';

function parseArgs(argv = []) {
  const args = {
    exchange: 'binance',
    refresh: true,
    json: false,
  };
  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw === '--no-refresh') args.refresh = false;
    else if (raw.startsWith('--exchange=')) args.exchange = raw.split('=').slice(1).join('=') || 'binance';
  }
  return args;
}

function buildDecision(summary = null) {
  const rows = Array.isArray(summary?.rows) ? summary.rows : [];
  const topPriority = rows[0] || null;
  return {
    status: rows.length === 0 ? 'agent_roles_empty' : 'agent_roles_ready',
    headline: rows.length === 0
      ? '현재 저장된 에이전트 역할 상태가 없습니다.'
      : `${summary.market} 시장에서 ${topPriority?.agent_id || 'agent'}가 ${topPriority?.mission || 'mission'} 임무를 우선 수행 중입니다.`,
    metrics: {
      count: rows.length,
      topPriority: topPriority ? {
        agentId: topPriority.agent_id,
        mission: topPriority.mission,
        roleMode: topPriority.role_mode,
        priority: Number(topPriority.priority || 0),
      } : null,
    },
  };
}

function renderText(payload) {
  const { args, summary, decision } = payload;
  const lines = [
    '🧭 Investment Agent Role Summary',
    `exchange: ${args.exchange}`,
    `status: ${decision.status}`,
    `headline: ${decision.headline}`,
    '',
  ];
  for (const row of summary.rows || []) {
    lines.push(`- ${row.agent_id}: ${row.mission} / ${row.role_mode} / priority ${row.priority}`);
    if (row.reason) lines.push(`  ${row.reason}`);
  }
  return lines.join('\n');
}

export async function buildRuntimeAgentRoleReport(args = {}) {
  const reevaluationSummary = args.refresh
    ? await buildPositionReevaluationSummary({
        exchange: args.exchange === 'binance' ? null : args.exchange,
        paper: false,
        persist: true,
        json: true,
        minutesBack: 180,
      }).catch(() => null)
    : null;
  const summary = await buildInvestmentAgentRoleSummary({
    exchange: args.exchange,
    refresh: args.refresh,
    reevaluationReport: reevaluationSummary?.report || reevaluationSummary,
  });
  const decision = buildDecision(summary);
  const payload = { ok: true, args, summary, decision };
  if (args.json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await buildRuntimeAgentRoleReport(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-agent-role-report 오류:',
  });
}
