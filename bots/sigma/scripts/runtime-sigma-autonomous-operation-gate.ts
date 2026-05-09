import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildFinalActivationSummary,
} from '../ts/lib/intelligent-library.js';
import {
  buildSelfImprovementSignalsFromRecords,
  collectLibraryPersistenceMetrics,
  collectLibraryRecords,
} from '../ts/lib/library-data-source.js';
import { buildSelfImprovementPlan } from '../ts/lib/self-improvement-pipeline.js';
import {
  defaultObservationHistoryPath,
  readObservationHistory,
  summarizeObservationHistory,
} from './sigma-observation-history.js';
import { buildProtectedRuntimeReport } from './sigma-protected-runtime.js';
import { resolveSigmaRuntimeEnv } from './sigma-runtime-env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

async function checkMcpRuntime(): Promise<{
  ok: boolean;
  status: string;
  health?: string;
  error?: string;
}> {
  if (hasArg('--skip-mcp-runtime')) {
    return { ok: true, status: 'mcp_runtime_check_skipped' };
  }
  try {
    const response = await fetch('http://127.0.0.1:4000/sigma/v2/health', {
      signal: AbortSignal.timeout(2_000),
    });
    const body = await response.json().catch(() => ({}));
    return {
      ok: response.status === 200 && body.status === 'ok',
      status: response.status === 200 ? 'mcp_runtime_health_checked' : 'mcp_runtime_unhealthy',
      health: String(body.status ?? response.status),
    };
  } catch (error) {
    return {
      ok: false,
      status: 'mcp_runtime_unavailable',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const envSource = resolveSigmaRuntimeEnv(repoRoot);
const activation = buildFinalActivationSummary(envSource.env);
const protectedLabels = buildProtectedRuntimeReport();
const sourceReport = await collectLibraryRecords({ sinceHours: 24 * 7, limitPerSource: 120 });
const signals = buildSelfImprovementSignalsFromRecords(sourceReport.records);
const selfImprovement = buildSelfImprovementPlan(signals, { dryRun: true });
const persistence = await collectLibraryPersistenceMetrics();
const observationHistory = readObservationHistory(defaultObservationHistoryPath(repoRoot));
const observation = summarizeObservationHistory(observationHistory);
const mcpRuntime = await checkMcpRuntime();

const routineAvoidCandidates = selfImprovement.skillCandidates.filter((candidate) => (
  candidate.kind === 'AVOID'
  && /signal_sent|observed|general_review|reflection_unavailable/.test(candidate.pattern.toLowerCase())
));
const materializationReady = persistence.entityRelationships > 0
  && persistence.dataLineage > 0
  && persistence.datasetSnapshots > 0;
const observationReady = observation.status === 'ready';

const hardBlockers = [
  ...activation.missing.map((item) => `activation_missing:${item}`),
  ...protectedLabels.missing.map((label) => `protected_label_missing:${label}`),
  ...(mcpRuntime.ok ? [] : [`mcp_runtime:${mcpRuntime.status}`]),
  ...routineAvoidCandidates.map((candidate) => `routine_avoid_candidate:${candidate.fileName}`),
];
const pendingObservation = [
  ...(materializationReady ? [] : ['pending_materialization']),
  ...(observationReady ? [] : [`pending_7day_observation:${observation.observedDays}/${observation.targetDays}`]),
  ...(selfImprovement.activation.applyMode === 'autonomous' && (!materializationReady || !observationReady)
    ? ['autonomous_apply_requires_materialization_and_7day_observation']
    : []),
];
const autonomousApplyReady = hardBlockers.length === 0
  && materializationReady
  && observationReady
  && mcpRuntime.ok
  && routineAvoidCandidates.length === 0;
const status = hardBlockers.length > 0
  ? 'sigma_autonomous_operation_blocked'
  : autonomousApplyReady
    ? 'sigma_autonomous_operation_ready'
    : 'code_complete_operational_pending';

const output = {
  ok: hardBlockers.length === 0,
  status,
  codeComplete: true,
  autonomousApplyReady,
  generatedAt: new Date().toISOString(),
  activationEnvSource: envSource.source,
  finalActivation: {
    active: activation.active,
    total: activation.total,
    missing: activation.missing,
  },
  mcpRuntime,
  materialization: {
    ready: materializationReady,
    metrics: persistence,
  },
  selfImprovementCandidateQuality: {
    ok: routineAvoidCandidates.length === 0,
    signalCount: signals.length,
    skillCandidates: selfImprovement.skillCandidates.length,
    routineAvoidCandidates: routineAvoidCandidates.map((candidate) => ({
      fileName: candidate.fileName,
      pattern: candidate.pattern,
    })),
    applyMode: selfImprovement.activation.applyMode,
  },
  protectedLabels,
  observation,
  hardBlockers,
  pendingObservation,
  nextActions: autonomousApplyReady
    ? ['review final evidence before enabling autonomous skill apply']
    : [
      ...(materializationReady ? [] : ['run library materialization apply with confirm when ready']),
      ...(observationReady ? [] : ['continue Sigma 7-day natural observation until ready']),
      ...(routineAvoidCandidates.length === 0 ? [] : ['fix routine event candidate classifier before apply']),
    ],
};

if (hasArg('--json') || !hasArg('--quiet')) {
  console.log(JSON.stringify(output, null, 2));
}
if (hardBlockers.length > 0 && hasArg('--strict')) process.exit(1);
