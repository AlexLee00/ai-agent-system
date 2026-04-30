#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLuna7DayReport } from './runtime-luna-7day-report.ts';
import { collectAgentBusStats } from '../shared/agent-bus-stats.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INVESTMENT_DIR = path.resolve(__dirname, '..');

function boolArg(name) {
  return process.argv.includes(`--${name}`);
}

export function build7DayCheckpointSummary({ report, busStats }) {
  const critical = [];
  const warnings = [];
  if (report.criteria?.smokeReg0 === false) critical.push('smoke_regression_detected');
  if ((report.reflexions?.count || 0) < 5) warnings.push(`reflexion_accumulation_pending:${report.reflexions?.count || 0}/5`);
  if ((report.skills?.libraryTotal || 0) < 1) warnings.push('skill_library_empty_or_pending');
  if ((busStats?.window7dMessages || 0) === 0) warnings.push('agent_bus_no_7d_messages');
  return {
    ok: critical.length === 0,
    status: critical.length > 0 ? 'critical' : report.status,
    generatedAt: new Date().toISOString(),
    critical,
    warnings,
    pendingObservation: report.pendingReasons || [],
    evidence: {
      periodDays: report.periodDays,
      fired: report.signals?.fired || 0,
      reflexions: report.reflexions?.count || 0,
      skills: report.skills?.libraryTotal || 0,
      bus7d: busStats?.window7dMessages || 0,
      bus24h: busStats?.window24hMessages || 0,
    },
  };
}

export async function runLuna7DayCheckpoint({
  days = 7,
  write = false,
  outputDir = path.join(INVESTMENT_DIR, 'output', 'reports'),
} = {}) {
  const [report, busStats] = await Promise.all([
    runLuna7DayReport({ days }),
    collectAgentBusStats({ days }).catch(() => ({ ok: false, window7dMessages: 0, window24hMessages: 0 })),
  ]);
  const summary = build7DayCheckpointSummary({ report, busStats });
  let outputPath = null;
  if (write) {
    fs.mkdirSync(outputDir, { recursive: true });
    outputPath = path.join(outputDir, `luna-7day-checkpoint-${new Date().toISOString().slice(0, 10)}.json`);
    fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2), 'utf8');
  }
  return { ...summary, outputPath };
}

export async function runLuna7DayCheckpointSmoke() {
  const summary = build7DayCheckpointSummary({
    report: {
      status: 'pending_observation',
      periodDays: 7,
      criteria: { smokeReg0: true },
      signals: { fired: 2 },
      reflexions: { count: 4 },
      skills: { libraryTotal: 0 },
      pendingReasons: ['reflexions 4/5'],
    },
    busStats: { window7dMessages: 10, window24hMessages: 2 },
  });
  if (!summary.ok) throw new Error('pending observation should not be critical');
  if (!summary.warnings.some((item) => item.includes('reflexion_accumulation_pending'))) {
    throw new Error('reflexion pending warning missing');
  }
  return { ok: true, summary };
}

async function main() {
  const result = boolArg('smoke')
    ? await runLuna7DayCheckpointSmoke()
    : await runLuna7DayCheckpoint({ write: boolArg('write') });
  if (process.argv.includes('--json') || boolArg('smoke')) console.log(JSON.stringify(result, null, 2));
  else console.log(`[luna-7day-checkpoint] ${result.status}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ luna-7day-checkpoint 실패:' });
}
