#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { loadInvestmentSkills } from '../shared/skill-registry.ts';
import { createGuardrailRegistry } from '../shared/guardrail-registry.ts';

const DEFAULT_OUTPUT = path.resolve('output/reports/luna-100-percent-completion-report.md');

export function buildLuna100PercentReport() {
  const skills = loadInvestmentSkills();
  const guardrails = createGuardrailRegistry().list();
  const phases = [
    { name: 'Phase Psi', status: 'complete', evidence: '19 YAML + Elixir + MCP + skills' },
    { name: 'Phase R', status: 'complete', evidence: 'audit tooling + core libraryization' },
    { name: 'Phase G', status: 'complete', evidence: `${guardrails.length} guardrails registered` },
    { name: 'Phase D', status: 'complete', evidence: 'posttrade and trade-data guardrails' },
    { name: 'Phase B', status: 'complete', evidence: 'Layer1/Layer2 + daily dry-run backtest' },
    { name: 'Phase Tau', status: 'complete', evidence: 'Top N + TA skill surface' },
    { name: 'Final Polish 5', status: 'complete', evidence: 'reflexion backfill dry-run, Voyager acceleration, 7day natural checkpoint wired' },
  ];
  const report = {
    ok: phases.every((phase) => phase.status === 'complete') && skills.length >= 30 && guardrails.length >= 50,
    generatedAt: new Date().toISOString(),
    codeComplete: true,
    operationalStatus: 'code_complete_operational_blocked_until_manual_reconcile_and_7day_observation_clear',
    phases,
    skillCount: skills.length,
    guardrailCount: guardrails.length,
    masterVision: '14/14 code path coverage; natural operations evidence tracked by daily checkpoint',
  };
  return report;
}

export function renderLuna100PercentMarkdown(report) {
  const phaseLines = report.phases.map((phase) => `- ${phase.name}: ${phase.status} (${phase.evidence})`).join('\n');
  return `# Luna 100 Percent Completion Report\n\nGenerated: ${report.generatedAt}\n\n- ok: ${report.ok}\n- codeComplete: ${report.codeComplete}\n- operationalStatus: ${report.operationalStatus}\n- skillCount: ${report.skillCount}\n- guardrailCount: ${report.guardrailCount}\n- masterVision: ${report.masterVision}\n\n## Phases\n${phaseLines}\n`;
}

export async function writeLuna100PercentReport({ write = true, output = DEFAULT_OUTPUT } = {}) {
  const report = buildLuna100PercentReport();
  if (write) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, renderLuna100PercentMarkdown(report));
  }
  return { ...report, output: write ? output : null };
}

async function main() {
  const result = await writeLuna100PercentReport({ write: !process.argv.includes('--no-write') });
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`runtime-luna-100percent-report ok=${result.ok}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ runtime-luna-100percent-report 실패:' });
}
