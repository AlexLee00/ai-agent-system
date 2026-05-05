import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildFinalActivationSummary,
  createDashboardSummary,
  type SelfImprovementSignal,
} from '../ts/lib/intelligent-library.js';
import { postSigmaAlarmWithRetry, summarizeAlarmResult } from './sigma-alarm-dispatch.js';
import { kstDateLabel } from './sigma-date.js';
import {
  appendObservationHistory,
  defaultObservationHistoryPath,
  readObservationHistory,
  summarizeObservationHistory,
  type SigmaObservationHistoryEntry,
} from './sigma-observation-history.js';
import { buildProtectedRuntimeReport, type SigmaProtectedRuntimeReport } from './sigma-protected-runtime.js';
import { resolveSigmaRuntimeEnv } from './sigma-runtime-env.js';

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { query } = require('../../../packages/core/lib/pg-pool.js') as {
  query: <T = any>(schema: string, sql: string, params?: unknown[]) => Promise<T[]>;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');

type CountMetric = {
  ok: boolean;
  value: number;
  warning?: string;
};

type ObservationMetrics = {
  alarmRoundtables24h: CountMetric;
  hubAlarms24h: CountMetric;
  voyagerSkillCandidates: CountMetric;
  graphNodes: number;
  graphEdges: number;
  datasets: number;
  entityRelationships: CountMetric;
  dataLineage: CountMetric;
  datasetSnapshots: CountMetric;
  directives24h: CountMetric;
  tier2Directives24h: CountMetric;
  mcpCalls24h: CountMetric;
  mcpToolCalls24h: CountMetric;
  reflexion24h: CountMetric;
  agentMessages7d: CountMetric;
  sigmaCost24hUsd: CountMetric;
};

type SigmaBudgetReport = {
  ok: boolean;
  dailyCostUsd: number;
  dailyLimitUsd: number;
  utilizationPct: number;
};

const dashboardSampleTexts = [
  'Sigma library memory graph connects Luna trade reflexion with Blog publishing incidents',
  'Ska reservation failures and Jay auto_dev repairs should preserve lineage and dataset value',
  'Legal case documents require rag_legal isolation and master approval before external export',
];

const dashboardSampleSignals: SelfImprovementSignal[] = [
  ...Array.from({ length: 5 }, () => ({
    team: 'sigma',
    agent: 'librarian',
    outcome: 'success' as const,
    pattern: 'cross team memory prefix improves answer quality',
    promptName: 'sigma_library_context_v1',
  })),
  ...Array.from({ length: 3 }, () => ({
    team: 'sigma',
    agent: 'librarian',
    outcome: 'failure' as const,
    pattern: 'dataset export attempted without lineage',
  })),
];

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

function argValue(name: string, fallback: string): string {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function numberEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function countRows(
  schema: string,
  table: string,
  whereSql = '',
  params: unknown[] = [],
): Promise<CountMetric> {
  try {
    const rows = await query<{ cnt: number | string }>(
      schema,
      `SELECT COUNT(*)::int AS cnt FROM ${schema}.${table} ${whereSql}`,
      params,
    );
    return { ok: true, value: Number(rows[0]?.cnt ?? 0) };
  } catch (error) {
    return {
      ok: false,
      value: 0,
      warning: `${schema}.${table}:${(error as Error).message}`,
    };
  }
}

async function collectObservationMetrics(): Promise<ObservationMetrics> {
  const env = resolveSigmaRuntimeEnv(repoRoot);
  const dashboard = createDashboardSummary({
    env: env.env,
    texts: dashboardSampleTexts,
    signals: dashboardSampleSignals,
  });
  const [
    alarmRoundtables24h,
    hubAlarms24h,
    reflexion24h,
    agentMessages7d,
    sigmaCost24hUsd,
    entityRelationships,
    dataLineage,
    datasetSnapshots,
    directives24h,
    tier2Directives24h,
    mcpCalls24h,
    mcpToolCalls24h,
  ] = await Promise.all([
    countRows('agent', 'alarm_roundtables', `WHERE created_at >= NOW() - INTERVAL '24 hours'`),
    countRows('agent', 'hub_alarms', `WHERE received_at >= NOW() - INTERVAL '24 hours'`),
    countRows('public', 'sigma_dpo_preference_pairs', `WHERE inserted_at >= NOW() - INTERVAL '24 hours'`),
    countRows('investment', 'agent_messages', `WHERE created_at >= NOW() - INTERVAL '7 days'`),
    (async (): Promise<CountMetric> => {
      try {
        const rows = await query<{ cost: string | number }>(
          'public',
          `SELECT COALESCE(SUM(cost_usd), 0)::numeric AS cost
             FROM public.sigma_llm_cost_tracking
            WHERE inserted_at >= NOW() - INTERVAL '24 hours'`,
        );
        return { ok: true, value: Number(rows[0]?.cost ?? 0) };
      } catch (error) {
        return { ok: false, value: 0, warning: `public.sigma_llm_cost_tracking:${(error as Error).message}` };
      }
    })(),
    countRows('sigma', 'entity_relationships'),
    countRows('sigma', 'data_lineage'),
    countRows('sigma', 'dataset_snapshots'),
    countRows('public', 'sigma_v2_directive_audit', `WHERE executed_at >= NOW() - INTERVAL '24 hours'`),
    countRows('public', 'sigma_v2_directive_audit', `WHERE tier = 2 AND outcome = 'tier2_applied' AND executed_at >= NOW() - INTERVAL '24 hours'`),
    countRows('public', 'sigma_mcp_usage_audit', `WHERE request_at >= NOW() - INTERVAL '24 hours'`),
    countRows('public', 'sigma_mcp_usage_audit', `WHERE endpoint = 'tools/call' AND request_at >= NOW() - INTERVAL '24 hours'`),
  ]);

  return {
    alarmRoundtables24h,
    hubAlarms24h,
    // The dashboard uses deterministic fixture signals to expose Voyager candidates.
    voyagerSkillCandidates: { ok: true, value: Number(dashboard.selfImprovement.skillCandidates || 0) },
    graphNodes: dashboard.graph.nodes,
    graphEdges: dashboard.graph.edges,
    datasets: dashboard.datasets,
    entityRelationships,
    dataLineage,
    datasetSnapshots,
    directives24h,
    tier2Directives24h,
    mcpCalls24h,
    mcpToolCalls24h,
    reflexion24h,
    agentMessages7d,
    sigmaCost24hUsd,
  };
}

function buildMasterReviewMessage(input: {
  day: string;
  ok: boolean;
  activationActive: number;
  activationTotal: number;
  dashboardStatus: string;
  metrics: ObservationMetrics;
  budget: SigmaBudgetReport;
  protectedLabels: SigmaProtectedRuntimeReport;
  observationWindow: { observedDays: number; targetDays: number; status: string };
  warnings: string[];
  blockers: string[];
}): string {
  const status = input.ok ? '정상' : '검토 필요';
  return [
    `📊 [SIGMA ${input.day} — Great Library Brain]`,
    '',
    `상태: ${status}`,
    `환경변수: ${input.activationActive}/${input.activationTotal} active`,
    `Dashboard: ${input.dashboardStatus}`,
    `관찰 누적: Day ${input.observationWindow.observedDays}/${input.observationWindow.targetDays} (${input.observationWindow.status})`,
    '',
    '자연 지표(관찰 창):',
    `- alarm_roundtables 24h: ${input.metrics.alarmRoundtables24h.value}`,
    `- hub_alarms 24h: ${input.metrics.hubAlarms24h.value}`,
    `- Voyager skill candidates: ${input.metrics.voyagerSkillCandidates.value}`,
    `- graph: nodes=${input.metrics.graphNodes}, edges=${input.metrics.graphEdges}`,
    `- datasets: ${input.metrics.datasets}`,
    `- DB meta: entity_relationships=${input.metrics.entityRelationships.value}, data_lineage=${input.metrics.dataLineage.value}, dataset_snapshots=${input.metrics.datasetSnapshots.value}`,
    `- directives 24h: total=${input.metrics.directives24h.value}, tier2_applied=${input.metrics.tier2Directives24h.value}`,
    `- MCP calls 24h: total=${input.metrics.mcpCalls24h.value}, tool_calls=${input.metrics.mcpToolCalls24h.value}`,
    `- reflexion 24h: ${input.metrics.reflexion24h.value}`,
    `- agent_messages 7d: ${input.metrics.agentMessages7d.value}`,
    `- Sigma LLM cost 24h: $${input.budget.dailyCostUsd.toFixed(4)} / $${input.budget.dailyLimitUsd.toFixed(2)} (${input.budget.utilizationPct.toFixed(1)}%)`,
    '',
    '안전 가드:',
    `- PROTECTED 6: ${input.protectedLabels.total - input.protectedLabels.missing.length}/${input.protectedLabels.total}`,
    '- Constitution 7: default ON',
    '- 이상 시 rollback: launchctl setenv SIGMA_V2_ENABLED false',
    '',
    input.blockers.length ? `blockers: ${input.blockers.join(', ')}` : 'blockers: 0',
    input.warnings.length ? `warnings: ${input.warnings.slice(0, 5).join(', ')}` : 'warnings: 0',
  ].join('\n');
}

async function main(): Promise<void> {
  const envSource = resolveSigmaRuntimeEnv(repoRoot);
  const dashboard = createDashboardSummary({
    env: envSource.env,
    texts: dashboardSampleTexts,
    signals: dashboardSampleSignals,
  });
  const activation = buildFinalActivationSummary(envSource.env);
  const metrics = await collectObservationMetrics();
  const protectedLabels = buildProtectedRuntimeReport();
  const dailyLimitUsd = numberEnv(envSource.env.SIGMA_LLM_DAILY_BUDGET_USD || process.env.SIGMA_LLM_DAILY_BUDGET_USD, 10);
  const budget: SigmaBudgetReport = {
    ok: metrics.sigmaCost24hUsd.ok && metrics.sigmaCost24hUsd.value <= dailyLimitUsd,
    dailyCostUsd: metrics.sigmaCost24hUsd.value,
    dailyLimitUsd,
    utilizationPct: dailyLimitUsd > 0 ? (metrics.sigmaCost24hUsd.value / dailyLimitUsd) * 100 : 100,
  };
  const metricWarnings = Object.values(metrics)
    .filter((metric): metric is CountMetric => typeof metric === 'object' && metric != null && 'ok' in metric)
    .filter((metric) => !metric.ok && metric.warning)
    .map((metric) => metric.warning as string);
  const budgetWarnings = budget.ok && budget.utilizationPct >= 80
    ? [`sigma_budget_near_limit:${budget.utilizationPct.toFixed(1)}pct`]
    : [];
  const warnings = [...dashboard.warnings, ...metricWarnings, ...budgetWarnings];
  let blockers = [
    ...dashboard.blockers,
    ...(activation.ok ? [] : activation.missing.map((item) => `activation_missing:${item}`)),
    ...protectedLabels.missing.map((label) => `protected_label_missing:${label}`),
    ...(budget.ok ? [] : [`sigma_daily_budget_exceeded:${budget.dailyCostUsd.toFixed(4)}/${budget.dailyLimitUsd.toFixed(2)}`]),
  ];
  const ok = blockers.length === 0;
  const observationHistoryPath = defaultObservationHistoryPath(repoRoot);
  const existingHistory = readObservationHistory(observationHistoryPath);
  const existingSummary = summarizeObservationHistory(existingHistory);
  const shouldRecord = hasArg('--record') || process.env.SIGMA_OBSERVATION_RECORD === 'true';
  const generatedAt = new Date().toISOString();
  const dateLabel = kstDateLabel();
  const historyEntry: SigmaObservationHistoryEntry = {
    date: dateLabel,
    generatedAt,
    status: ok ? 'sigma_observation_review_ready' : 'sigma_observation_review_blocked',
    ok,
    finalActivationActive: activation.active,
    finalActivationTotal: activation.total,
    dashboardStatus: dashboard.status,
    protectedMissing: protectedLabels.missing,
    blockers,
    warnings,
    metrics: {
      alarmRoundtables24h: metrics.alarmRoundtables24h.value,
      hubAlarms24h: metrics.hubAlarms24h.value,
      voyagerSkillCandidates: metrics.voyagerSkillCandidates.value,
      graphNodes: metrics.graphNodes,
      graphEdges: metrics.graphEdges,
      datasets: metrics.datasets,
      entityRelationships: metrics.entityRelationships.value,
      dataLineage: metrics.dataLineage.value,
      datasetSnapshots: metrics.datasetSnapshots.value,
      directives24h: metrics.directives24h.value,
      tier2Directives24h: metrics.tier2Directives24h.value,
      mcpCalls24h: metrics.mcpCalls24h.value,
      mcpToolCalls24h: metrics.mcpToolCalls24h.value,
      reflexion24h: metrics.reflexion24h.value,
      agentMessages7d: metrics.agentMessages7d.value,
      sigmaCost24hUsd: metrics.sigmaCost24hUsd.value,
    },
    budget,
  };
  const observationSummary = summarizeObservationHistory([
    ...existingHistory,
    ...(shouldRecord ? [historyEntry] : []),
  ]);
  if (shouldRecord) {
    appendObservationHistory(observationHistoryPath, historyEntry);
  }
  const day = argValue('--day', `Day ${observationSummary.observedDays}/${observationSummary.targetDays}`);
  const message = buildMasterReviewMessage({
    day,
    ok,
    activationActive: activation.active,
    activationTotal: activation.total,
    dashboardStatus: dashboard.status,
    metrics,
    budget,
    protectedLabels,
    observationWindow: {
      observedDays: observationSummary.observedDays,
      targetDays: observationSummary.targetDays,
      status: observationSummary.status,
    },
    warnings,
    blockers,
  });

  const output = {
    ok,
    status: ok ? 'sigma_observation_review_ready' : 'sigma_observation_review_blocked',
    generatedAt,
    day,
    activationEnvSource: envSource.source,
    finalActivation: {
      active: activation.active,
      total: activation.total,
      missing: activation.missing,
    },
    dashboardStatus: dashboard.status,
    metrics,
    budget,
    protectedLabels,
    observationHistory: {
      path: shouldRecord ? observationHistoryPath : null,
      recorded: shouldRecord,
      summary: observationSummary,
    },
    blockers,
    warnings,
    rollbackCommand: 'launchctl setenv SIGMA_V2_ENABLED false',
    telegramAttempted: false,
    telegramDelivered: false,
    telegramResult: null as unknown,
  };

  if (hasArg('--telegram') || process.env.SIGMA_OBSERVATION_REVIEW_TELEGRAM === 'true') {
    output.telegramAttempted = true;
    const dispatch = await postSigmaAlarmWithRetry({
      message,
      team: 'sigma',
      fromBot: 'sigma-observation-review',
      alertLevel: ok ? 1 : 3,
      payload: {
        type: 'sigma_observation_review',
        status: output.status,
        finalActivation: output.finalActivation,
        dashboardStatus: output.dashboardStatus,
        rollbackCommand: output.rollbackCommand,
      },
    });
    const telegramResult = dispatch.result;
    output.telegramResult = summarizeTelegramResult(telegramResult);
    output.telegramDelivered = Boolean((telegramResult as { ok?: boolean } | null)?.ok);
    (output as Record<string, unknown>).telegramAttempts = dispatch.attempts;
    if (!output.telegramDelivered) {
      warnings.push(`telegram_delivery_not_confirmed:${String((telegramResult as { error?: string } | null)?.error || 'unknown')}`);
      if (hasArg('--require-telegram')) blockers = [...blockers, 'telegram_delivery_required'];
    }
  }

  output.warnings = warnings;
  output.blockers = blockers;
  output.ok = blockers.length === 0;
  output.status = output.ok ? 'sigma_observation_review_ready' : 'sigma_observation_review_blocked';

  if (hasArg('--json') || !hasArg('--quiet')) {
    console.log(JSON.stringify(output, null, 2));
  }

  if (!output.ok && hasArg('--strict')) process.exit(1);
}

function summarizeTelegramResult(result: unknown): unknown {
  return summarizeAlarmResult(result);
}

main().catch((error) => {
  console.error(`[sigma-observation-review] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
