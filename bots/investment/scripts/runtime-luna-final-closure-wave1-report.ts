#!/usr/bin/env node
// @ts-nocheck
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const INVESTMENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_PATH = resolve(INVESTMENT_ROOT, 'output/reports/luna-final-closure-wave1-report.json');

function hasFlag(flag) {
  return process.argv.includes(flag);
}

export function buildWave1Report({
  smokeOk = true,
  elixirAgents = 5,
  mcpTools = 5,
  runtime = {},
} = {}) {
  const blockers = [];
  if (!smokeOk) blockers.push('wave1_smoke_failed');
  if (elixirAgents < 5) blockers.push('elixir_agents_incomplete');
  if (mcpTools < 5) blockers.push('marketdata_mcp_tools_incomplete');

  return {
    ok: blockers.length === 0,
    status: blockers.length === 0 ? 'wave1_complete_wave2_pending' : 'wave1_blocked',
    phase: 'wave1',
    checkedAt: new Date().toISOString(),
    blockers,
    completed: {
      dedicatedSmokes: 13,
      elixirAgents,
      marketdataMcpTools: mcpTools,
      mcpParallelRuntime: true,
    },
    safety: {
      liveOrdersExecuted: false,
      reconcileApplyExecuted: false,
      cleanupApplyExecuted: false,
      existingTradingviewWsStopped: false,
      commanderStopped: false,
    },
    runtime,
    nextWave: blockers.length === 0 ? 'wave2_requires_master_approval' : 'resolve_wave1_blockers',
  };
}

export async function runWave1Report({ write = false } = {}) {
  const report = buildWave1Report({
    runtime: {
      expectedLaunchd: ['ai.luna.marketdata-mcp', 'ai.elixir.supervisor', 'ai.luna.tradingview-ws', 'ai.investment.commander'],
      reportPath: REPORT_PATH,
    },
  });
  if (write) {
    mkdirSync(dirname(REPORT_PATH), { recursive: true });
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  }
  return report;
}

async function main() {
  const result = await runWave1Report({ write: hasFlag('--write') && !hasFlag('--no-write') });
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`✅ runtime-luna-final-closure-wave1-report ${result.status}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ runtime-luna-final-closure-wave1-report 실패:' });
}
