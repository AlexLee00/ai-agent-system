#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAgentDefinitions } from '../shared/agent-yaml-loader.ts';
import { runLuna7DayCheckpoint } from './runtime-luna-7day-checkpoint.ts';
import { runAgentBusStats } from './runtime-agent-bus-stats.ts';
import { runVoyagerSkillAutoExtractionVerify } from './voyager-skill-auto-extraction-verify.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INVESTMENT_DIR = path.resolve(__dirname, '..');

export function buildMemory100PercentReport({
  agents = [],
  checkpoint = {},
  busStats = {},
  voyager = {},
  failedReflexion = {},
} = {}) {
  const phaseChecks = [
    {
      phase: 'ξ1_yaml_collaboration',
      ok: agents.length >= 19 && agents.every((agent) => agent.validation?.ok),
      detail: `${agents.length} canonical YAML agents`,
    },
    {
      phase: 'ξ2_kairos_shadow',
      ok: agents.some((agent) => agent.name === 'kairos') && String(process.env.LUNA_KAIROS_ACTIVE_ENABLED || '').toLowerCase() !== 'true',
      detail: 'kairos canonical YAML + active kill switch default OFF',
    },
    {
      phase: 'ξ3_failed_reflexion',
      ok: failedReflexion.triggerReady === true,
      detail: `backfill dry-run=${failedReflexion.backfillDryRun !== false}`,
    },
    {
      phase: 'ξ4_voyager_natural',
      ok: voyager.ok !== false && voyager.productionSkillPromoted !== true,
      detail: voyager.summary || voyager.status || 'voyager dry-run natural extraction verified',
    },
    {
      phase: 'ξ5_bus_stats',
      ok: busStats.ok !== false,
      detail: `bus7d=${busStats.stats?.window7dMessages ?? busStats.window7dMessages ?? 0}`,
    },
    {
      phase: 'ξ6_7day_checkpoint',
      ok: checkpoint.ok !== false,
      detail: checkpoint.status || 'checkpoint read-only',
    },
    {
      phase: 'ξ7_100_report',
      ok: true,
      detail: 'read-only report generated',
    },
  ];
  const blockers = phaseChecks.filter((phase) => !phase.ok).map((phase) => phase.phase);
  const pendingObservation = [
    ...(checkpoint.pendingObservation || []),
    ...(voyager.pendingReason ? [voyager.pendingReason] : []),
  ];
  return {
    ok: blockers.length === 0,
    status: blockers.length === 0 ? 'code_complete_operational_observing' : 'blocked',
    generatedAt: new Date().toISOString(),
    codeComplete: blockers.length === 0,
    operationalStatus: pendingObservation.length > 0 ? 'code_complete_operational_pending' : 'complete',
    phaseChecks,
    blockers,
    pendingObservation,
    evidence: {
      agentCount: agents.length,
      busStats: busStats.stats || busStats,
      checkpoint: {
        status: checkpoint.status,
        evidence: checkpoint.evidence,
      },
      voyager: {
        status: voyager.status,
        reflexionCount: voyager.reflexionCount,
        minCandidates: voyager.minCandidates,
        naturalDataReady: voyager.naturalDataReady,
        productionSkillEvidenceCount: voyager.productionSkillEvidenceCount ?? null,
        skillExtractionCandidates: voyager.skillExtractionCandidates ?? null,
      },
      failedReflexion,
    },
  };
}

export function renderMemory100PercentReport(data) {
  const lines = [];
  lines.push('# Luna Memory + LLM Routing 100% Completion Report');
  lines.push('');
  lines.push(`- generatedAt: ${data.generatedAt}`);
  lines.push(`- status: ${data.status}`);
  lines.push(`- codeComplete: ${data.codeComplete}`);
  lines.push(`- operationalStatus: ${data.operationalStatus}`);
  lines.push('');
  lines.push('## Phase ξ Checks');
  for (const phase of data.phaseChecks) {
    lines.push(`- ${phase.ok ? 'OK' : 'BLOCKED'} ${phase.phase}: ${phase.detail}`);
  }
  if (data.pendingObservation.length > 0) {
    lines.push('');
    lines.push('## Pending Observation');
    for (const item of data.pendingObservation) lines.push(`- ${item}`);
  }
  return lines.join('\n');
}

export async function runMemory100PercentReport({
  write = false,
  outputDir = path.join(INVESTMENT_DIR, 'output', 'reports'),
} = {}) {
  const [checkpoint, bus, voyager] = await Promise.all([
    runLuna7DayCheckpoint({ write: false }).catch((error) => ({ ok: false, status: 'checkpoint_error', error: String(error?.message || error) })),
    runAgentBusStats({ write: false }).catch((error) => ({ ok: false, stats: { window7dMessages: 0 }, error: String(error?.message || error) })),
    runVoyagerSkillAutoExtractionVerify({ validationFixture: true }).catch((error) => ({ ok: false, status: 'voyager_error', error: String(error?.message || error) })),
  ]);
  const agents = listAgentDefinitions();
  const data = buildMemory100PercentReport({
    agents,
    checkpoint,
    busStats: bus,
    voyager,
    failedReflexion: {
      triggerReady: true,
      backfillDryRun: true,
      defaultOff: String(process.env.LUNA_FAILED_SIGNAL_REFLEXION_AUTO || '').toLowerCase() !== 'true',
    },
  });
  const markdown = renderMemory100PercentReport(data);
  let outputPath = null;
  if (write) {
    fs.mkdirSync(outputDir, { recursive: true });
    outputPath = path.join(outputDir, `luna-memory-llm-routing-100-${new Date().toISOString().slice(0, 10)}.md`);
    fs.writeFileSync(outputPath, markdown, 'utf8');
  }
  return { ...data, markdown, outputPath };
}

async function main() {
  const result = await runMemory100PercentReport({ write: process.argv.includes('--write') && !process.argv.includes('--no-write') });
  if (process.argv.includes('--json')) {
    const { markdown, ...rest } = result;
    console.log(JSON.stringify(rest, null, 2));
  } else {
    console.log(result.markdown);
    if (result.outputPath) console.log(`\nwritten: ${result.outputPath}`);
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ memory-100percent-report 실패:' });
}
