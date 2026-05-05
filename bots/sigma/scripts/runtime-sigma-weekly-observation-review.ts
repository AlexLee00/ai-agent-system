import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildFinalActivationSummary,
  createDashboardSummary,
  type SelfImprovementSignal,
} from '../ts/lib/intelligent-library.js';
import { postSigmaAlarmWithRetry, summarizeAlarmResult } from './sigma-alarm-dispatch.js';
import {
  defaultObservationHistoryPath,
  readObservationHistory,
  summarizeObservationHistory,
} from './sigma-observation-history.js';
import { buildProtectedRuntimeReport } from './sigma-protected-runtime.js';
import { resolveSigmaRuntimeEnv } from './sigma-runtime-env.js';

const require = createRequire(import.meta.url);
const { query } = require('../../../packages/core/lib/pg-pool.js') as {
  query: <T = any>(schema: string, sql: string, params?: unknown[]) => Promise<T[]>;
};
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');

type Metric = {
  ok: boolean;
  value: number;
  warning?: string;
};

const sampleTexts = [
  'Sigma weekly review connects Luna trade reflexion, Hub alarms, and team memory graph growth',
  'Great Library Brain weekly evaluation must preserve constitution, lineage, and budget evidence',
  'Voyager skill extraction and Self-RAG improvements require seven-day observation before expansion',
];

const sampleSignals: SelfImprovementSignal[] = [
  ...Array.from({ length: 5 }, () => ({
    team: 'sigma',
    agent: 'librarian',
    outcome: 'success' as const,
    pattern: 'weekly cross team memory review improves routing decisions',
    promptName: 'sigma_library_weekly_review_v1',
  })),
  ...Array.from({ length: 3 }, () => ({
    team: 'sigma',
    agent: 'librarian',
    outcome: 'failure' as const,
    pattern: 'weekly dataset export attempted without lineage evidence',
  })),
];

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

function numberEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function countRows(schema: string, table: string, whereSql = ''): Promise<Metric> {
  try {
    const rows = await query<{ cnt: number | string }>(
      schema,
      `SELECT COUNT(*)::int AS cnt FROM ${schema}.${table} ${whereSql}`,
    );
    return { ok: true, value: Number(rows[0]?.cnt ?? 0) };
  } catch (error) {
    return { ok: false, value: 0, warning: `${schema}.${table}:${(error as Error).message}` };
  }
}

async function sumCost7d(): Promise<Metric> {
  try {
    const rows = await query<{ cost: string | number }>(
      'public',
      `SELECT COALESCE(SUM(cost_usd), 0)::numeric AS cost
         FROM public.sigma_llm_cost_tracking
        WHERE inserted_at >= NOW() - INTERVAL '7 days'`,
    );
    return { ok: true, value: Number(rows[0]?.cost ?? 0) };
  } catch (error) {
    return { ok: false, value: 0, warning: `public.sigma_llm_cost_tracking:${(error as Error).message}` };
  }
}

async function collectWeeklyMetrics() {
  const [
    alarmRoundtables7d,
    hubAlarms7d,
    dpo7d,
    directives7d,
    agentMessages7d,
    sigmaCost7dUsd,
  ] = await Promise.all([
    countRows('agent', 'alarm_roundtables', `WHERE created_at >= NOW() - INTERVAL '7 days'`),
    countRows('agent', 'hub_alarms', `WHERE received_at >= NOW() - INTERVAL '7 days'`),
    countRows('public', 'sigma_dpo_preference_pairs', `WHERE inserted_at >= NOW() - INTERVAL '7 days'`),
    countRows('public', 'sigma_v2_directive_audit', `WHERE executed_at >= NOW() - INTERVAL '7 days'`),
    countRows('investment', 'agent_messages', `WHERE created_at >= NOW() - INTERVAL '7 days'`),
    sumCost7d(),
  ]);

  return {
    alarmRoundtables7d,
    hubAlarms7d,
    dpo7d,
    directives7d,
    agentMessages7d,
    sigmaCost7dUsd,
  };
}

function buildWeeklyMessage(input: {
  ok: boolean;
  activationActive: number;
  activationTotal: number;
  dashboardStatus: string;
  graphNodes: number;
  graphEdges: number;
  datasets: number;
  skillCandidates: number;
  protectedTotal: number;
  protectedMissing: string[];
  observationWindow: { observedDays: number; targetDays: number; status: string };
  metrics: Awaited<ReturnType<typeof collectWeeklyMetrics>>;
  weeklyCostLimitUsd: number;
  budgetPct: number;
  blockers: string[];
  warnings: string[];
}): string {
  return [
    `📊 [SIGMA Weekly Great Library Review] ${input.ok ? '정상' : '검토 필요'}`,
    '',
    `환경변수: ${input.activationActive}/${input.activationTotal} active`,
    `Dashboard: ${input.dashboardStatus}`,
    `PROTECTED 6: ${input.protectedTotal - input.protectedMissing.length}/${input.protectedTotal}`,
    `관찰 누적: Day ${input.observationWindow.observedDays}/${input.observationWindow.targetDays} (${input.observationWindow.status})`,
    '',
    '7일 누적:',
    `- alarm_roundtables: ${input.metrics.alarmRoundtables7d.value}`,
    `- hub_alarms: ${input.metrics.hubAlarms7d.value}`,
    `- DPO/reflexion pairs: ${input.metrics.dpo7d.value}`,
    `- directives: ${input.metrics.directives7d.value}`,
    `- agent_messages: ${input.metrics.agentMessages7d.value}`,
    `- graph: nodes=${input.graphNodes}, edges=${input.graphEdges}`,
    `- datasets: ${input.datasets}`,
    `- Voyager skill candidates: ${input.skillCandidates}`,
    `- Sigma LLM cost 7d: $${input.metrics.sigmaCost7dUsd.value.toFixed(4)} / $${input.weeklyCostLimitUsd.toFixed(2)} (${input.budgetPct.toFixed(1)}%)`,
    '',
    '안전 가드:',
    '- Constitution 7: default ON',
    '- 이상 시 rollback: launchctl setenv SIGMA_V2_ENABLED false',
    input.blockers.length ? `blockers: ${input.blockers.join(', ')}` : 'blockers: 0',
    input.warnings.length ? `warnings: ${input.warnings.slice(0, 8).join(', ')}` : 'warnings: 0',
  ].join('\n');
}

async function main(): Promise<void> {
  const envSource = resolveSigmaRuntimeEnv(repoRoot);
  const dashboard = createDashboardSummary({
    env: envSource.env,
    texts: sampleTexts,
    signals: sampleSignals,
  });
  const activation = buildFinalActivationSummary(envSource.env);
  const protectedLabels = buildProtectedRuntimeReport();
  const metrics = await collectWeeklyMetrics();
  const historyPath = defaultObservationHistoryPath(repoRoot);
  const observationHistory = summarizeObservationHistory(readObservationHistory(historyPath));
  const dailyLimitUsd = numberEnv(envSource.env.SIGMA_LLM_DAILY_BUDGET_USD || process.env.SIGMA_LLM_DAILY_BUDGET_USD, 10);
  const weeklyCostLimitUsd = dailyLimitUsd * 7;
  const budgetPct = weeklyCostLimitUsd > 0 ? (metrics.sigmaCost7dUsd.value / weeklyCostLimitUsd) * 100 : 100;
  const metricWarnings = Object.values(metrics)
    .filter((metric): metric is Metric => typeof metric === 'object' && metric != null && 'ok' in metric)
    .filter((metric) => !metric.ok && metric.warning)
    .map((metric) => metric.warning as string);
  const warnings = [
    ...dashboard.warnings,
    ...metricWarnings,
    ...(budgetPct >= 80 && budgetPct <= 100 ? [`sigma_weekly_budget_near_limit:${budgetPct.toFixed(1)}pct`] : []),
  ];
  const blockers = [
    ...dashboard.blockers,
    ...(activation.ok ? [] : activation.missing.map((item) => `activation_missing:${item}`)),
    ...protectedLabels.missing.map((label) => `protected_label_missing:${label}`),
    ...(budgetPct > 100 ? [`sigma_weekly_budget_exceeded:${metrics.sigmaCost7dUsd.value.toFixed(4)}/${weeklyCostLimitUsd.toFixed(2)}`] : []),
  ];
  const ok = blockers.length === 0;
  const message = buildWeeklyMessage({
    ok,
    activationActive: activation.active,
    activationTotal: activation.total,
    dashboardStatus: dashboard.status,
    graphNodes: dashboard.graph.nodes,
    graphEdges: dashboard.graph.edges,
    datasets: dashboard.datasets,
    skillCandidates: dashboard.selfImprovement.skillCandidates,
    protectedTotal: protectedLabels.total,
    protectedMissing: protectedLabels.missing,
    observationWindow: {
      observedDays: observationHistory.observedDays,
      targetDays: observationHistory.targetDays,
      status: observationHistory.status,
    },
    metrics,
    weeklyCostLimitUsd,
    budgetPct,
    blockers,
    warnings,
  });
  const output = {
    ok,
    status: ok ? 'sigma_weekly_observation_ready' : 'sigma_weekly_observation_blocked',
    generatedAt: new Date().toISOString(),
    activationEnvSource: envSource.source,
    finalActivation: {
      active: activation.active,
      total: activation.total,
      missing: activation.missing,
    },
    dashboardStatus: dashboard.status,
    protectedLabels,
    observationHistory: {
      path: historyPath,
      summary: observationHistory,
    },
    budget: {
      cost7dUsd: metrics.sigmaCost7dUsd.value,
      limit7dUsd: weeklyCostLimitUsd,
      utilizationPct: budgetPct,
    },
    metrics,
    blockers,
    warnings,
    rollbackCommand: 'launchctl setenv SIGMA_V2_ENABLED false',
    telegramAttempted: false,
    telegramDelivered: false,
    telegramResult: null as unknown,
  };

  if (hasArg('--telegram') || process.env.SIGMA_WEEKLY_OBSERVATION_TELEGRAM === 'true') {
    output.telegramAttempted = true;
    const dispatch = await postSigmaAlarmWithRetry({
      message,
      team: 'sigma',
      fromBot: 'sigma-weekly-observation-review',
      alertLevel: ok ? 1 : 3,
      payload: {
        type: 'sigma_weekly_observation_review',
        status: output.status,
        rollbackCommand: output.rollbackCommand,
      },
    });
    const result = dispatch.result;
    output.telegramResult = summarizeAlarmResult(result);
    output.telegramDelivered = Boolean((result as { ok?: boolean } | null)?.ok);
    (output as Record<string, unknown>).telegramAttempts = dispatch.attempts;
    if (!output.telegramDelivered) {
      warnings.push(`telegram_delivery_not_confirmed:${String((result as { error?: string } | null)?.error || 'unknown')}`);
      if (hasArg('--require-telegram')) blockers.push('telegram_delivery_required');
    }
  }

  output.warnings = warnings;
  output.blockers = blockers;
  output.ok = blockers.length === 0;
  output.status = output.ok ? 'sigma_weekly_observation_ready' : 'sigma_weekly_observation_blocked';

  if (hasArg('--json') || !hasArg('--quiet')) {
    console.log(JSON.stringify(output, null, 2));
  }

  if (!output.ok && hasArg('--strict')) process.exit(1);
}

main().catch((error) => {
  console.error(`[sigma-weekly-observation-review] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
