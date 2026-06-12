import fs from 'node:fs';
import path from 'node:path';

export type HubLlmPromotionGateId = 'GATE-H' | 'GATE-H3';
export type HubLlmPromotionGateSelector = HubLlmPromotionGateId | 'all';
export type HubLlmPromotionGateStatus =
  | 'blocked'
  | 'contract_only'
  | 'shadow_ready_data_pending'
  | 'ready_for_master_review';

export type HubLlmPromotionGateBlockerType = 'contract' | 'evidence' | 'schema' | 'safety';

export type HubLlmPromotionGateBlocker = {
  gate: HubLlmPromotionGateId | 'all';
  type: HubLlmPromotionGateBlockerType;
  name: string;
  detail: string;
  observed?: unknown;
  threshold?: unknown;
};

export type HubLlmPromotionGateCheck = {
  gate: HubLlmPromotionGateId;
  name: string;
  ok: boolean;
  type: 'contract' | 'evidence';
  detail: string;
  observed?: unknown;
  threshold?: unknown;
};

export type HubLlmPromotionGateQueryFn = (sql: string, params?: unknown[]) => Promise<unknown[] | unknown> | unknown[] | unknown;

export type HubLlmPromotionGateOptions = {
  queryFn?: HubLlmPromotionGateQueryFn | null;
  hours?: number;
  gate?: HubLlmPromotionGateSelector;
  noDb?: boolean;
  repoRoot?: string;
  packageJsonPath?: string;
  sourceFiles?: string[];
  contractsOverride?: Partial<Record<HubLlmPromotionGateId, Partial<HubLlmPromotionGateContract>>>;
  now?: Date;
};

export type HubLlmPromotionGateReport = {
  ok: boolean;
  status: HubLlmPromotionGateStatus | 'hub_llm_promotion_gate_apply_blocked';
  selectedGate: HubLlmPromotionGateSelector;
  gates: Record<HubLlmPromotionGateId, HubLlmPromotionGateStatus>;
  hours: number;
  generatedAt: string;
  shadowMode: true;
  liveMutation: false;
  promotionReady: false;
  manualPromotionReviewCandidate: boolean;
  notifyMasterReview: boolean;
  notificationPayload: Record<string, unknown> | null;
  contractChecks: HubLlmPromotionGateCheck[];
  evidenceChecks: HubLlmPromotionGateCheck[];
  blockers: HubLlmPromotionGateBlocker[];
  metrics: Record<string, unknown>;
};

type HubLlmPromotionGateContract = {
  requiredScripts: string[];
  requiredSourceMarkers: string[];
  requiredSchemaColumns?: Array<{ schema: string; table: string; columns: string[] }>;
};

type GateEvaluation = {
  status: HubLlmPromotionGateStatus;
  contractChecks: HubLlmPromotionGateCheck[];
  evidenceChecks: HubLlmPromotionGateCheck[];
  blockers: HubLlmPromotionGateBlocker[];
  metrics: Record<string, unknown>;
};

const DEFAULT_HOURS = 168;
const GATE_H_DARWIN_FAILURE_THRESHOLD = 9;
const GATE_H_DARWIN_FAILED_AVG_DURATION_MS = 30_000;
const GATE_H_DARWIN_UNKNOWN_PURPOSE_RATIO_THRESHOLD = 0.05;
const GATE_H3_SHADOW_SAMPLE_THRESHOLD = 1_000;
const GATE_H3_TIMEOUT_UNDER_ACTUAL_RATIO_THRESHOLD = 0.01;

export const HUB_LLM_GATE_CONTRACTS: Record<HubLlmPromotionGateId, HubLlmPromotionGateContract> = {
  'GATE-H': {
    requiredScripts: [
      'check:llm-stage-a',
      'llm:stage-a-selector-smoke',
      'llm:stage-a-request-log-smoke',
      'llm:stage-a-protected-secrets-smoke',
    ],
    requiredSourceMarkers: [
      'HUB_LLM_RATELIMIT_COOLDOWN_ENABLED',
      'HUB_LLM_RATELIMIT_COOLDOWN_MIN_MS',
      'isRateLimitCoolingDown',
    ],
  },
  'GATE-H3': {
    requiredScripts: [],
    requiredSourceMarkers: [
      'HUB_LLM_DYNAMIC_BUDGET_ENABLED',
    ],
    requiredSchemaColumns: [
      {
        schema: 'agent',
        table: 'llm_token_budget_usage',
        columns: [
          'created_at',
          'caller_team',
          'task_type',
          'selector_key',
          'timeout_ms',
          'duration_ms',
          'metadata',
        ],
      },
    ],
  },
};

export function buildHubLlmPromotionApplyBlockedReport(options: Partial<HubLlmPromotionGateOptions> = {}): HubLlmPromotionGateReport {
  const hours = normalizeHours(options.hours);
  const selectedGate = normalizeGate(options.gate);
  const generatedAt = (options.now || new Date()).toISOString();
  const blocker: HubLlmPromotionGateBlocker = {
    gate: selectedGate,
    type: 'safety',
    name: 'apply_blocked',
    detail: 'hub_llm_promotion_gate_apply_blocked: promotion execution is intentionally unavailable; master review must perform env/launchd changes manually.',
  };
  return {
    ok: false,
    status: 'hub_llm_promotion_gate_apply_blocked',
    selectedGate,
    gates: { 'GATE-H': 'blocked', 'GATE-H3': 'blocked' },
    hours,
    generatedAt,
    shadowMode: true,
    liveMutation: false,
    promotionReady: false,
    manualPromotionReviewCandidate: false,
    notifyMasterReview: false,
    notificationPayload: null,
    contractChecks: [],
    evidenceChecks: [],
    blockers: [blocker],
    metrics: { safety: { applyBlocked: true } },
  };
}

export async function buildHubLlmPromotionGateReport(options: HubLlmPromotionGateOptions = {}): Promise<HubLlmPromotionGateReport> {
  const hours = normalizeHours(options.hours);
  const selectedGate = normalizeGate(options.gate);
  const generatedAt = (options.now || new Date()).toISOString();
  const gateIds = selectedGate === 'all' ? (['GATE-H', 'GATE-H3'] as HubLlmPromotionGateId[]) : [selectedGate];

  const evaluated: Partial<Record<HubLlmPromotionGateId, GateEvaluation>> = {};
  for (const gate of gateIds) {
    evaluated[gate] = await evaluateGate(gate, { ...options, hours });
  }

  const gates: Record<HubLlmPromotionGateId, HubLlmPromotionGateStatus> = {
    'GATE-H': evaluated['GATE-H']?.status || 'blocked',
    'GATE-H3': evaluated['GATE-H3']?.status || 'blocked',
  };
  const contractChecks = gateIds.flatMap((gate) => evaluated[gate]?.contractChecks || []);
  const evidenceChecks = gateIds.flatMap((gate) => evaluated[gate]?.evidenceChecks || []);
  const blockers = gateIds.flatMap((gate) => evaluated[gate]?.blockers || []);
  const metrics = Object.fromEntries(gateIds.map((gate) => [gate, evaluated[gate]?.metrics || {}]));
  const readyForMaster = gateIds.every((gate) => evaluated[gate]?.status === 'ready_for_master_review');
  const status = summarizeStatus(gateIds.map((gate) => evaluated[gate]?.status || 'blocked'));

  return {
    ok: readyForMaster,
    status,
    selectedGate,
    gates,
    hours,
    generatedAt,
    shadowMode: true,
    liveMutation: false,
    promotionReady: false,
    manualPromotionReviewCandidate: readyForMaster,
    notifyMasterReview: readyForMaster,
    notificationPayload: readyForMaster ? {
      event: 'hub_llm_promotion_gate_ready_for_master_review',
      gate: selectedGate,
      gates,
      hours,
      generatedAt,
      promotionReady: false,
      liveMutation: false,
    } : null,
    contractChecks,
    evidenceChecks,
    blockers,
    metrics,
  };
}

async function evaluateGate(gate: HubLlmPromotionGateId, options: HubLlmPromotionGateOptions & { hours: number }): Promise<GateEvaluation> {
  const contractChecks = await buildContractChecks(gate, options);
  const contractBlockers = checksToBlockers(contractChecks);
  const hasSchemaContractBlocker = contractBlockers.some((blocker) => blocker.name.startsWith('schema:'));
  if (contractBlockers.length > 0 && (options.noDb || !options.queryFn || hasSchemaContractBlocker)) {
    return {
      status: 'blocked',
      contractChecks,
      evidenceChecks: [],
      blockers: contractBlockers,
      metrics: { contractReady: false, dataReady: false },
    };
  }

  if (options.noDb || !options.queryFn) {
    const noDbCheck: HubLlmPromotionGateCheck = {
      gate,
      name: 'db_evidence_skipped',
      ok: false,
      type: 'evidence',
      detail: 'Evidence checks were skipped because --no-db was requested or no queryFn was provided.',
      observed: 'skipped',
      threshold: 'read-only DB evidence required',
    };
    return {
      status: 'contract_only',
      contractChecks,
      evidenceChecks: [noDbCheck],
      blockers: [],
      metrics: { contractReady: true, dataReady: false, dbSkipped: true },
    };
  }

  const evidenceChecks = await buildEvidenceChecks(gate, options);
  const evidenceBlockers = checksToBlockers(evidenceChecks);
  const status: HubLlmPromotionGateStatus = contractBlockers.length > 0
    ? 'blocked'
    : evidenceBlockers.length > 0
    ? 'shadow_ready_data_pending'
    : 'ready_for_master_review';

  return {
    status,
    contractChecks,
    evidenceChecks,
    blockers: [...contractBlockers, ...evidenceBlockers],
    metrics: {
      contractReady: contractBlockers.length === 0,
      dataReady: evidenceBlockers.length === 0,
      ...Object.fromEntries(evidenceChecks.map((check) => [check.name, check.observed])),
    },
  };
}

async function buildContractChecks(gate: HubLlmPromotionGateId, options: HubLlmPromotionGateOptions): Promise<HubLlmPromotionGateCheck[]> {
  const repoRoot = options.repoRoot || path.resolve(__dirname, '..', '..', '..');
  const packageJsonPath = options.packageJsonPath || path.join(repoRoot, 'bots', 'hub', 'package.json');
  const contracts = mergeContract(gate, options.contractsOverride?.[gate]);
  const sourceFiles = options.sourceFiles || defaultSourceFiles(repoRoot);
  const sourceCorpus = readExistingFiles(sourceFiles).join('\n');
  const packageJson = readJson(packageJsonPath);
  const scripts = packageJson && typeof packageJson === 'object' ? (packageJson as { scripts?: Record<string, string> }).scripts || {} : {};

  const scriptChecks = contracts.requiredScripts.map((scriptName) => ({
    gate,
    name: `script:${scriptName}`,
    ok: Boolean(scripts[scriptName]),
    type: 'contract' as const,
    detail: Boolean(scripts[scriptName]) ? 'Required package script is registered.' : 'Required package script is missing.',
    observed: Boolean(scripts[scriptName]) ? scripts[scriptName] : null,
    threshold: 'present',
  }));
  const markerChecks = contracts.requiredSourceMarkers.map((marker) => ({
    gate,
    name: `source_marker:${marker}`,
    ok: sourceCorpus.includes(marker),
    type: 'contract' as const,
    detail: sourceCorpus.includes(marker) ? 'Required source marker is present.' : 'Required source marker is missing from Hub source files.',
    observed: sourceCorpus.includes(marker) ? 'present' : 'missing',
    threshold: 'present',
  }));
  const schemaChecks = await buildSchemaContractChecks(gate, contracts, options);

  return [...scriptChecks, ...markerChecks, ...schemaChecks];
}

async function buildSchemaContractChecks(
  gate: HubLlmPromotionGateId,
  contract: HubLlmPromotionGateContract,
  options: HubLlmPromotionGateOptions,
): Promise<HubLlmPromotionGateCheck[]> {
  if (!contract.requiredSchemaColumns?.length) return [];
  if (options.noDb || !options.queryFn) {
    return contract.requiredSchemaColumns.flatMap((entry) => entry.columns.map((column) => ({
      gate,
      name: `schema:${entry.schema}.${entry.table}.${column}`,
      ok: false,
      type: 'contract' as const,
      detail: 'Schema contract cannot be verified without read-only DB access.',
      observed: 'skipped',
      threshold: 'column present',
    })));
  }

  const checks: HubLlmPromotionGateCheck[] = [];
  for (const entry of contract.requiredSchemaColumns) {
    let rows: Array<Record<string, unknown>> = [];
    let schemaError: string | null = null;
    try {
      rows = normalizeRows(await options.queryFn(`
        /* hub_llm_gate:schema_columns */
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = $1
          AND table_name = $2
          AND column_name = ANY($3::text[])
      `, [entry.schema, entry.table, entry.columns]));
    } catch (error) {
      schemaError = error instanceof Error ? error.message : String(error);
    }
    const present = new Set(rows.map((row) => String(row.column_name || row.columnName || '')));
    for (const column of entry.columns) {
      checks.push({
        gate,
        name: `schema:${entry.schema}.${entry.table}.${column}`,
        ok: !schemaError && present.has(column),
        type: 'contract',
        detail: schemaError
          ? `Schema contract probe failed: ${schemaError}`
          : present.has(column) ? 'Required schema column is present.' : 'Required schema column is missing.',
        observed: schemaError || (present.has(column) ? 'present' : 'missing'),
        threshold: 'column present',
      });
    }
  }
  return checks;
}

async function buildEvidenceChecks(gate: HubLlmPromotionGateId, options: HubLlmPromotionGateOptions & { hours: number }): Promise<HubLlmPromotionGateCheck[]> {
  try {
    return gate === 'GATE-H'
      ? await buildGateHEvidenceChecks(options)
      : await buildGateH3EvidenceChecks(options);
  } catch (error) {
    return [{
      gate,
      name: 'evidence_query_error',
      ok: false,
      type: 'evidence',
      detail: 'Read-only evidence query failed.',
      observed: error instanceof Error ? error.message : String(error),
      threshold: 'query succeeds',
    }];
  }
}

async function buildGateHEvidenceChecks(options: HubLlmPromotionGateOptions & { hours: number }): Promise<HubLlmPromotionGateCheck[]> {
  const rows = normalizeRows(await options.queryFn?.(`
    /* hub_llm_gate:gate_h_evidence */
    SELECT
      count(*) FILTER (
        WHERE lower(coalesce(caller_team, '')) = 'darwin'
          AND success IS FALSE
      )::int AS darwin_failure_count,
      COALESCE(ROUND(AVG(duration_ms) FILTER (
        WHERE lower(coalesce(caller_team, '')) = 'darwin'
          AND success IS FALSE
          AND duration_ms IS NOT NULL
      ))::int, 0) AS darwin_failed_avg_duration_ms,
      count(*) FILTER (
        WHERE lower(coalesce(provider, '')) = 'local'
          AND lower(coalesce(runtime_purpose, '')) NOT LIKE 'backtest%'
      )::int AS local_general_calls,
      count(*) FILTER (
        WHERE lower(coalesce(caller_team, '')) = 'darwin'
      )::int AS darwin_total_count,
      count(*) FILTER (
        WHERE lower(coalesce(caller_team, '')) = 'darwin'
          AND lower(coalesce(runtime_purpose, 'unknown')) = 'unknown'
      )::int AS darwin_unknown_purpose_count
    FROM public.llm_routing_log
    WHERE created_at >= now() - ($1::int * interval '1 hour')
  `, [options.hours]));
  const row = rows[0] || {};
  const darwinFailureCount = toNumber(row.darwin_failure_count);
  const darwinFailedAvgDurationMs = toNumber(row.darwin_failed_avg_duration_ms);
  const localGeneralCalls = toNumber(row.local_general_calls);
  const darwinTotalCount = toNumber(row.darwin_total_count);
  const darwinUnknownPurposeCount = toNumber(row.darwin_unknown_purpose_count);
  const darwinUnknownPurposeRatio = darwinTotalCount > 0 ? darwinUnknownPurposeCount / darwinTotalCount : 0;

  return [
    {
      gate: 'GATE-H',
      name: 'darwin_failure_count',
      ok: darwinFailureCount <= GATE_H_DARWIN_FAILURE_THRESHOLD,
      type: 'evidence',
      detail: 'Darwin failure count must stay in single digits for the observation window.',
      observed: darwinFailureCount,
      threshold: `<=${GATE_H_DARWIN_FAILURE_THRESHOLD}`,
    },
    {
      gate: 'GATE-H',
      name: 'darwin_failed_avg_duration_ms',
      ok: darwinFailedAvgDurationMs < GATE_H_DARWIN_FAILED_AVG_DURATION_MS,
      type: 'evidence',
      detail: 'Darwin failed-row average duration must stay below 30 seconds.',
      observed: darwinFailedAvgDurationMs,
      threshold: `<${GATE_H_DARWIN_FAILED_AVG_DURATION_MS}`,
    },
    {
      gate: 'GATE-H',
      name: 'local_general_calls',
      ok: localGeneralCalls === 0,
      type: 'evidence',
      detail: 'Local provider calls must be absent outside backtest runtime purposes.',
      observed: localGeneralCalls,
      threshold: 0,
    },
    {
      gate: 'GATE-H',
      name: 'darwin_unknown_purpose_ratio',
      ok: darwinUnknownPurposeRatio < GATE_H_DARWIN_UNKNOWN_PURPOSE_RATIO_THRESHOLD,
      type: 'evidence',
      detail: 'Darwin unknown runtime purpose ratio must stay below the corrected whole-Darwin threshold.',
      observed: {
        ratio: darwinUnknownPurposeRatio,
        count: darwinUnknownPurposeCount,
        total: darwinTotalCount,
      },
      threshold: `<${GATE_H_DARWIN_UNKNOWN_PURPOSE_RATIO_THRESHOLD}`,
    },
  ];
}

async function buildGateH3EvidenceChecks(options: HubLlmPromotionGateOptions & { hours: number }): Promise<HubLlmPromotionGateCheck[]> {
  const rows = normalizeRows(await options.queryFn?.(`
    /* hub_llm_gate:gate_h3_evidence */
    WITH shadow AS (
      SELECT *
      FROM agent.llm_token_budget_usage
      WHERE created_at >= now() - ($1::int * interval '1 hour')
        AND (
          metadata->>'dynamic_budget_shadow' = 'true'
          OR metadata->>'dynamicBudgetShadow' = 'true'
        )
    )
    SELECT
      count(*)::int AS shadow_sample_count,
      COALESCE(
        (count(*) FILTER (WHERE timeout_ms > 0 AND duration_ms > 0 AND timeout_ms < duration_ms))::double precision
        / NULLIF(count(*), 0),
        0
      ) AS timeout_under_actual_ratio,
      count(*) FILTER (
        WHERE lower(coalesce(caller_team, '')) = 'blog'
          AND (
            lower(coalesce(selector_key, '')) IN ('blog.pos.writer', 'blog.gems.writer')
            OR lower(coalesce(task_type, '')) LIKE '%long%'
            OR lower(coalesce(task_type, '')) LIKE '%writer%'
          )
          AND (
            COALESCE(NULLIF(status, ''), 'unknown') NOT IN ('success', 'cache_hit')
            OR error IS NOT NULL
            OR (metadata->>'blog_longform_regression') = 'true'
            OR (metadata->>'blogLongformRegression') = 'true'
          )
      )::int AS blog_longform_regression_count
    FROM shadow
  `, [options.hours]));
  const row = rows[0] || {};
  const shadowSampleCount = toNumber(row.shadow_sample_count);
  const timeoutUnderActualRatio = toNumber(row.timeout_under_actual_ratio);
  const blogLongformRegressionCount = toNumber(row.blog_longform_regression_count);

  return [
    {
      gate: 'GATE-H3',
      name: 'shadow_sample_count',
      ok: shadowSampleCount >= GATE_H3_SHADOW_SAMPLE_THRESHOLD,
      type: 'evidence',
      detail: 'Dynamic budget shadow samples must reach the required observation volume.',
      observed: shadowSampleCount,
      threshold: `>=${GATE_H3_SHADOW_SAMPLE_THRESHOLD}`,
    },
    {
      gate: 'GATE-H3',
      name: 'timeout_under_actual_ratio',
      ok: timeoutUnderActualRatio < GATE_H3_TIMEOUT_UNDER_ACTUAL_RATIO_THRESHOLD,
      type: 'evidence',
      detail: 'Calculated timeout under actual duration ratio must stay below 1%.',
      observed: timeoutUnderActualRatio,
      threshold: `<${GATE_H3_TIMEOUT_UNDER_ACTUAL_RATIO_THRESHOLD}`,
    },
    {
      gate: 'GATE-H3',
      name: 'blog_longform_regression_count',
      ok: blogLongformRegressionCount === 0,
      type: 'evidence',
      detail: 'Blog long-form routes must not regress under dynamic budget shadow data.',
      observed: blogLongformRegressionCount,
      threshold: 0,
    },
  ];
}

function mergeContract(gate: HubLlmPromotionGateId, override?: Partial<HubLlmPromotionGateContract>): HubLlmPromotionGateContract {
  const base = HUB_LLM_GATE_CONTRACTS[gate];
  return {
    requiredScripts: override?.requiredScripts ?? base.requiredScripts,
    requiredSourceMarkers: override?.requiredSourceMarkers ?? base.requiredSourceMarkers,
    requiredSchemaColumns: override?.requiredSchemaColumns ?? base.requiredSchemaColumns,
  };
}

function defaultSourceFiles(repoRoot: string): string[] {
  return collectCodeFiles([
    path.join(repoRoot, 'bots', 'hub', 'lib', 'llm', 'unified-caller.ts'),
    path.join(repoRoot, 'bots', 'hub', 'lib', 'llm', 'provider-registry.ts'),
    path.join(repoRoot, 'bots', 'hub', 'lib', 'routes', 'llm.ts'),
    path.join(repoRoot, 'bots', 'hub', 'lib'),
    path.join(repoRoot, 'bots', 'hub', 'src'),
    path.join(repoRoot, 'packages', 'core', 'lib', 'token-budget.ts'),
    path.join(repoRoot, 'packages', 'core', 'lib'),
  ]);
}

function collectCodeFiles(entries: string[]): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  const visit = (entry: string) => {
    if (seen.has(entry)) return;
    seen.add(entry);
    if (!fs.existsSync(entry)) return;
    const stat = fs.statSync(entry);
    if (stat.isFile()) {
      if (path.basename(entry) === 'hub-llm-promotion-gate.ts') return;
      if (/\.(cjs|js|mjs|ts|tsx)$/.test(entry)) files.push(entry);
      return;
    }
    if (!stat.isDirectory()) return;
    for (const name of fs.readdirSync(entry)) {
      if (name === 'node_modules' || name === 'output' || name === 'dist') continue;
      visit(path.join(entry, name));
    }
  };
  entries.forEach(visit);
  return files;
}

function readExistingFiles(files: string[]): string[] {
  return files.flatMap((file) => {
    try {
      if (!fs.existsSync(file)) return [];
      return [fs.readFileSync(file, 'utf8')];
    } catch {
      return [];
    }
  });
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function checksToBlockers(checks: HubLlmPromotionGateCheck[]): HubLlmPromotionGateBlocker[] {
  return checks.filter((check) => !check.ok).map((check) => ({
    gate: check.gate,
    type: check.type,
    name: check.name,
    detail: check.detail,
    observed: check.observed,
    threshold: check.threshold,
  }));
}

function summarizeStatus(statuses: HubLlmPromotionGateStatus[]): HubLlmPromotionGateStatus {
  if (statuses.every((status) => status === 'ready_for_master_review')) return 'ready_for_master_review';
  if (statuses.some((status) => status === 'blocked')) return 'blocked';
  if (statuses.some((status) => status === 'shadow_ready_data_pending')) return 'shadow_ready_data_pending';
  return 'contract_only';
}

function normalizeRows(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
  if (value && typeof value === 'object' && Array.isArray((value as { rows?: unknown[] }).rows)) {
    return (value as { rows: Array<Record<string, unknown>> }).rows;
  }
  return [];
}

function normalizeHours(hours: unknown): number {
  const parsed = Math.floor(Number(hours || DEFAULT_HOURS));
  if (!Number.isFinite(parsed)) return DEFAULT_HOURS;
  return Math.max(1, Math.min(24 * 31, parsed));
}

function normalizeGate(gate: unknown): HubLlmPromotionGateSelector {
  if (gate === 'GATE-H' || gate === 'GATE-H3' || gate === 'all') return gate;
  return 'GATE-H';
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
