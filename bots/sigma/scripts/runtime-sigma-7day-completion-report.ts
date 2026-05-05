import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildFinalActivationSummary,
  createDashboardSummary,
} from '../ts/lib/intelligent-library.js';
import { postSigmaAlarmWithRetry, summarizeAlarmResult } from './sigma-alarm-dispatch.js';
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

function buildMessage(output: Record<string, any>): string {
  const status = output.completionReady ? '100% 관찰 완료' : output.status;
  return [
    `📈 [SIGMA 7-Day Completion] ${status}`,
    `관찰: Day ${output.observation.observedDays}/${output.observation.targetDays}`,
    `기간: ${output.observation.firstDate || '-'} → ${output.observation.latestDate || '-'}`,
    `activation: ${output.finalActivation.active}/${output.finalActivation.total}`,
    `dashboard: ${output.dashboardStatus}`,
    `PROTECTED 6 missing: ${output.protectedLabels.missing.length}`,
    `blockers: ${output.blockers.length ? output.blockers.join(', ') : '0'}`,
    `warnings: ${output.warnings.length ? output.warnings.slice(0, 8).join(', ') : '0'}`,
    `rollback: ${output.rollbackCommand}`,
  ].join('\n');
}

function buildTrend(rows: ReturnType<typeof readObservationHistory>) {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const first = sorted[0] ?? null;
  const latest = sorted.at(-1) ?? null;
  return {
    firstDate: first?.date ?? null,
    latestDate: latest?.date ?? null,
    graphNodesDelta: first && latest ? latest.metrics.graphNodes - first.metrics.graphNodes : 0,
    graphEdgesDelta: first && latest ? latest.metrics.graphEdges - first.metrics.graphEdges : 0,
    maxVoyagerSkillCandidates: sorted.reduce((max, row) => Math.max(max, row.metrics.voyagerSkillCandidates), 0),
    totalHubAlarms24hWindows: sorted.reduce((sum, row) => sum + row.metrics.hubAlarms24h, 0),
    totalRoundtables24hWindows: sorted.reduce((sum, row) => sum + row.metrics.alarmRoundtables24h, 0),
    totalDirectives24hWindows: sorted.reduce((sum, row) => sum + (row.metrics.directives24h ?? 0), 0),
    totalTier2Directives24hWindows: sorted.reduce((sum, row) => sum + (row.metrics.tier2Directives24h ?? 0), 0),
    totalMcpCalls24hWindows: sorted.reduce((sum, row) => sum + (row.metrics.mcpCalls24h ?? 0), 0),
    totalMcpToolCalls24hWindows: sorted.reduce((sum, row) => sum + (row.metrics.mcpToolCalls24h ?? 0), 0),
    latestEntityRelationships: latest?.metrics.entityRelationships ?? 0,
    latestDataLineage: latest?.metrics.dataLineage ?? 0,
    latestDatasetSnapshots: latest?.metrics.datasetSnapshots ?? 0,
    totalSigmaCostUsd: sorted.reduce((sum, row) => sum + row.budget.dailyCostUsd, 0),
  };
}

async function main(): Promise<void> {
  const envSource = resolveSigmaRuntimeEnv(repoRoot);
  const activation = buildFinalActivationSummary(envSource.env);
  const dashboard = createDashboardSummary({ env: envSource.env });
  const protectedLabels = buildProtectedRuntimeReport();
  const historyPath = defaultObservationHistoryPath(repoRoot);
  const historyRows = readObservationHistory(historyPath);
  const observation = summarizeObservationHistory(historyRows);
  const trend = buildTrend(historyRows);
  const blockers = [
    ...dashboard.blockers,
    ...(activation.ok ? [] : activation.missing.map((item) => `activation_missing:${item}`)),
    ...protectedLabels.missing.map((label) => `protected_label_missing:${label}`),
    ...observation.blockerDates.map((date) => `observation_blocked:${date}`),
  ];
  const warnings = [
    ...dashboard.warnings,
    ...(observation.status === 'pending_observation'
      ? [`pending_observation:${observation.observedDays}/${observation.targetDays}`]
      : []),
    ...observation.missingDates.map((date) => `observation_missing:${date}`),
  ];
  const completionReady = activation.ok
    && dashboard.blockers.length === 0
    && protectedLabels.missing.length === 0
    && observation.status === 'ready';
  const hardBlocked = blockers.length > 0;
  const output = {
    ok: !hardBlocked,
    completionReady,
    status: hardBlocked
      ? 'sigma_7day_completion_blocked'
      : completionReady
        ? 'sigma_7day_completion_ready'
        : 'sigma_7day_completion_pending_observation',
    generatedAt: new Date().toISOString(),
    activationEnvSource: envSource.source,
    historyPath,
    finalActivation: {
      active: activation.active,
      total: activation.total,
      missing: activation.missing,
    },
    dashboardStatus: dashboard.status,
    protectedLabels,
    observation,
    trend,
    blockers,
    warnings,
    nextActions: completionReady
      ? ['review 7-day evidence and decide Sigma autonomous expansion']
      : ['continue daily observation review until 7 consecutive clean days are collected'],
    rollbackCommand: 'launchctl setenv SIGMA_V2_ENABLED false',
    telegramAttempted: false,
    telegramDelivered: false,
    telegramResult: null as unknown,
  };

  if (hasArg('--telegram')) {
    output.telegramAttempted = true;
    const dispatch = await postSigmaAlarmWithRetry({
      message: buildMessage(output),
      team: 'sigma',
      fromBot: 'sigma-7day-completion-report',
      alertLevel: hardBlocked ? 3 : 1,
      payload: {
        type: 'sigma_7day_completion_report',
        status: output.status,
        completionReady,
        rollbackCommand: output.rollbackCommand,
      },
    });
    output.telegramResult = summarizeAlarmResult(dispatch.result);
    output.telegramDelivered = Boolean((dispatch.result as { ok?: boolean } | null)?.ok);
    (output as Record<string, unknown>).telegramAttempts = dispatch.attempts;
  }

  if (hasArg('--json') || !hasArg('--quiet')) {
    console.log(JSON.stringify(output, null, 2));
  }

  if (hardBlocked && hasArg('--strict')) process.exit(1);
}

main().catch((error) => {
  console.error(`[sigma-7day-completion-report] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
