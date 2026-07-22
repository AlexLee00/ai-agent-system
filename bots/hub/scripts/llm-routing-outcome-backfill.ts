#!/usr/bin/env tsx

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pgPool = require('../../../packages/core/lib/pg-pool');
const {
  buildLockedRollbackSnapshotPath,
  defineWriteCountEvidence,
  matchesWriteActionConfirm,
  writePlanSha256,
} = require('../../../packages/core/lib/write-action-confirm.js');

type DbRow = Record<string, any>;
type QueryReadonly = (schema: string, sql: string, params?: unknown[]) => Promise<DbRow[]>;

export const BACKFILL_WINDOW = Object.freeze({
  start: '2026-07-12T00:00:00+09:00',
  end_exclusive: '2026-07-19T00:00:00+09:00',
  source_end_exclusive: '2026-07-19T00:00:15+09:00',
  timezone: 'Asia/Seoul',
  mode: 'shadow',
});

const MATCH_WINDOW_US = 15_000_000n;
const PLAN_VERSION = 'task-0086-v1';
const ADVISORY_LOCK_KEY = 'hub:task-0086:routing-outcome-backfill';
const DEFAULT_ARTIFACT_DIR = path.join(
  os.homedir(),
  '.ai-agent-system/workspace/bridge/outbox',
);

const HUB_ROWS_SQL = `
  SELECT
    id::text AS id,
    agent,
    caller_team,
    prompt_chars,
    created_at,
    ((EXTRACT(EPOCH FROM created_at) * 1000000)::bigint)::text AS created_at_us,
    success,
    latency_ms,
    cost_usd::text AS cost_usd,
    mode,
    routing_signals #> '{cluster_recommendation,embedding_signature}' IS NOT NULL AS has_signature,
    NULLIF(routing_signals #>> '{cluster_recommendation,signature_key}', '') AS signature_key,
    NULLIF(routing_signals ->> 'routing_request_id', '') AS routing_request_id,
    NULLIF(routing_signals #>> '{execution,model}', '') AS execution_model
  FROM hub.llm_auto_routing_log
  WHERE created_at >= $1::timestamptz
    AND created_at < $2::timestamptz
    AND mode = 'shadow'
  ORDER BY created_at ASC, id ASC
`;

const PUBLIC_ROWS_SQL = `
  SELECT
    id::text AS id,
    agent,
    caller_team,
    prompt_chars,
    created_at,
    ((EXTRACT(EPOCH FROM created_at) * 1000000)::bigint)::text AS created_at_us,
    success,
    latency_ms,
    duration_ms,
    cost_usd::text AS source_cost_usd,
    cost_usd::numeric(10,6)::text AS target_cost_usd
  FROM public.llm_routing_log
  WHERE created_at >= $1::timestamptz
    AND created_at < $2::timestamptz
  ORDER BY created_at ASC, id ASC
`;

const LOCK_TARGET_ROWS_SQL = `
  SELECT id::text AS id, success, latency_ms, cost_usd::text AS cost_usd
  FROM hub.llm_auto_routing_log
  WHERE id = ANY($1::bigint[])
    AND created_at >= $2::timestamptz
    AND created_at < $3::timestamptz
    AND mode = 'shadow'
  ORDER BY id ASC
  FOR UPDATE
`;

const UPDATE_TARGET_ROWS_SQL = `
  WITH input AS (
    SELECT *
    FROM jsonb_to_recordset($1::jsonb) AS row(
      id bigint,
      success boolean,
      latency_ms integer,
      cost_usd numeric(10,6)
    )
  )
  UPDATE hub.llm_auto_routing_log AS target
  SET success = input.success,
      latency_ms = input.latency_ms,
      cost_usd = input.cost_usd
  FROM input
  WHERE target.id = input.id
    AND target.created_at >= $2::timestamptz
    AND target.created_at < $3::timestamptz
    AND target.mode = 'shadow'
    AND target.success IS NULL
    AND target.latency_ms IS NULL
    AND target.cost_usd IS NULL
  RETURNING target.id::text AS id
`;

function rowsFromResult(result: any): DbRow[] {
  return Array.isArray(result) ? result : (Array.isArray(result?.rows) ? result.rows : []);
}

function asIso(value: unknown): string | null {
  const date = value instanceof Date ? value : new Date(String(value ?? ''));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function timestampUs(row: DbRow): bigint | null {
  const explicit = String(row?.created_at_us ?? '').trim();
  if (/^-?\d+$/.test(explicit)) return BigInt(explicit);
  const iso = asIso(row?.created_at);
  return iso ? BigInt(new Date(iso).getTime()) * 1000n : null;
}

function isoFromTimestampUs(value: bigint): string {
  const seconds = value / 1_000_000n;
  const micros = value % 1_000_000n;
  const base = new Date(Number(seconds) * 1000).toISOString().slice(0, 19);
  return `${base}.${String(micros).padStart(6, '0')}Z`;
}

function exactMatchKey(row: DbRow): string | null {
  if (row?.agent == null || row?.caller_team == null || row?.prompt_chars == null) return null;
  const promptChars = Number(row.prompt_chars);
  if (!Number.isInteger(promptChars)) return null;
  return JSON.stringify([String(row.agent), String(row.caller_team), promptChars]);
}

function canonicalCost(value: unknown): string | null {
  if (value == null || String(value).trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 9_999.999999) return null;
  return parsed.toFixed(6);
}

function validSourceOutcome(row: DbRow): boolean {
  if (row?.latency_ms == null || row?.duration_ms == null) return false;
  const latency = Number(row?.latency_ms);
  const duration = Number(row?.duration_ms);
  return typeof row?.success === 'boolean'
    && Number.isInteger(latency)
    && latency >= 0
    && Number.isInteger(duration)
    && duration >= 0
    && latency === duration
    && canonicalCost(row?.source_cost_usd) != null
    && canonicalCost(row?.target_cost_usd) != null;
}

function compareIds(left: unknown, right: unknown): number {
  return String(left).localeCompare(String(right), 'en', { numeric: true });
}

function compareRows(left: DbRow, right: DbRow): number {
  const leftUs = timestampUs(left) ?? 0n;
  const rightUs = timestampUs(right) ?? 0n;
  if (leftUs !== rightUs) return leftUs < rightUs ? -1 : 1;
  return compareIds(left.id, right.id);
}

function lowerBound(rows: DbRow[], targetUs: bigint): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const middleUs = timestampUs(rows[middle]);
    if (middleUs != null && middleUs < targetUs) low = middle + 1;
    else high = middle;
  }
  return low;
}

function kstDay(row: DbRow): string {
  const us = timestampUs(row);
  return us == null ? 'invalid' : new Date(Number(us / 1000n) + (9 * 60 * 60 * 1000)).toISOString().slice(0, 10);
}

function rounded(value: number, digits = 3): number | null {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function percentile(values: number[], probability: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * probability;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low];
  return sorted[low] + ((sorted[high] - sorted[low]) * (index - low));
}

function costMicros(value: string): bigint {
  const normalized = canonicalCost(value);
  if (!normalized) return 0n;
  const [whole, fraction] = normalized.split('.');
  return (BigInt(whole) * 1_000_000n) + BigInt(fraction);
}

function microsCost(value: bigint): string {
  const whole = value / 1_000_000n;
  const fraction = String(value % 1_000_000n).padStart(6, '0');
  return `${whole}.${fraction}`;
}

function outcomeCounts(rows: DbRow[]) {
  const counts = {
    population: rows.length,
    all_null: 0,
    all_set: 0,
    partial: 0,
    success_null: 0,
    latency_ms_null: 0,
    cost_usd_null: 0,
  };
  for (const row of rows) {
    const nulls = [row.success, row.latency_ms, row.cost_usd].map((value) => value == null);
    if (nulls[0]) counts.success_null += 1;
    if (nulls[1]) counts.latency_ms_null += 1;
    if (nulls[2]) counts.cost_usd_null += 1;
    if (nulls.every(Boolean)) counts.all_null += 1;
    else if (nulls.every((value) => !value)) counts.all_set += 1;
    else counts.partial += 1;
  }
  return counts;
}

function targetState(row: DbRow, pair: DbRow): 'pending' | 'already_applied' | 'conflict' {
  const values = [row?.success, row?.latency_ms, row?.cost_usd];
  if (values.every((value) => value == null)) return 'pending';
  if (
    values.every((value) => value != null)
    && row.success === pair.success
    && Number(row.latency_ms) === pair.latency_ms
    && canonicalCost(row.cost_usd) === pair.cost_usd
  ) return 'already_applied';
  return 'conflict';
}

function inventorySha256(hubRows: DbRow[], publicRows: DbRow[]): string {
  const payload = {
    hub: [...hubRows].sort(compareRows).map((row) => ({
      id: String(row.id),
      agent: row.agent == null ? null : String(row.agent),
      caller_team: row.caller_team == null ? null : String(row.caller_team),
      prompt_chars: row.prompt_chars == null ? null : Number(row.prompt_chars),
      created_at_us: timestampUs(row)?.toString() ?? null,
      mode: row.mode == null ? null : String(row.mode),
      has_signature: Boolean(row.has_signature),
      signature_key: row.signature_key == null ? null : String(row.signature_key),
      routing_request_id: row.routing_request_id == null ? null : String(row.routing_request_id),
      execution_model: row.execution_model == null ? null : String(row.execution_model),
    })),
    public: [...publicRows].sort(compareRows).map((row) => ({
      id: String(row.id),
      agent: row.agent == null ? null : String(row.agent),
      caller_team: row.caller_team == null ? null : String(row.caller_team),
      prompt_chars: row.prompt_chars == null ? null : Number(row.prompt_chars),
      created_at_us: timestampUs(row)?.toString() ?? null,
      success: typeof row.success === 'boolean' ? row.success : null,
      latency_ms: row.latency_ms == null ? null : Number(row.latency_ms),
      duration_ms: row.duration_ms == null ? null : Number(row.duration_ms),
      source_cost_usd: row.source_cost_usd == null ? null : String(row.source_cost_usd),
      target_cost_usd: row.target_cost_usd == null ? null : canonicalCost(row.target_cost_usd),
    })),
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function stablePlanPayload(pairs: DbRow[], inventorySha: string) {
  return {
    version: PLAN_VERSION,
    window: BACKFILL_WINDOW,
    inventory_sha256: inventorySha,
    match_contract: {
      exact_fields: ['agent', 'caller_team', 'prompt_chars'],
      public_after_hub_us: { min: 0, max: Number(MATCH_WINDOW_US) },
      hub_candidate_count: 1,
      public_selection_count: 1,
      source_outcome: 'success_boolean_latency_equals_duration_nonnegative_cost',
    },
    pairs: pairs.map((pair) => ({
      hub_id: pair.hub_id,
      public_id: pair.public_id,
      agent: pair.agent,
      caller_team: pair.caller_team,
      prompt_chars: pair.prompt_chars,
      hub_created_at: pair.hub_created_at,
      public_created_at: pair.public_created_at,
      delta_us: pair.delta_us,
      delta_ms: pair.delta_ms,
      success: pair.success,
      latency_ms: pair.latency_ms,
      source_cost_usd: pair.source_cost_usd,
      cost_usd: pair.cost_usd,
    })),
  };
}

function planSha256(pairs: DbRow[], inventorySha: string): string {
  return writePlanSha256(stablePlanPayload(pairs, inventorySha), JSON.stringify);
}

function immutableRunId(): string {
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 17);
  return `${timestamp}-${crypto.randomUUID().slice(0, 8)}`;
}

async function writeImmutableFile(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(tempPath, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.link(tempPath, filePath);
  } finally {
    await handle?.close().catch(() => {});
    await fs.promises.unlink(tempPath).catch(() => {});
  }
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(code)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function buildRoutingOutcomeBackfillPlan(hubRowsInput: DbRow[], publicRowsInput: DbRow[]) {
  const hubRows = [...hubRowsInput].sort(compareRows);
  const publicRows = [...publicRowsInput].sort(compareRows);
  const inventorySha = inventorySha256(hubRows, publicRows);
  const publicByKey = new Map<string, DbRow[]>();
  for (const row of publicRows) {
    const key = exactMatchKey(row);
    if (!key || timestampUs(row) == null) continue;
    const group = publicByKey.get(key) || [];
    group.push(row);
    publicByKey.set(key, group);
  }

  const multiplicity = new Map<number, number>();
  const uniqueHubSelections: Array<{ hub: DbRow; source: DbRow; deltaUs: bigint }> = [];
  let noCandidate = 0;
  let multipleCandidates = 0;

  for (const hub of hubRows) {
    const key = exactMatchKey(hub);
    const hubUs = timestampUs(hub);
    const group = key ? (publicByKey.get(key) || []) : [];
    const candidates: DbRow[] = [];
    if (hubUs != null) {
      for (let index = lowerBound(group, hubUs); index < group.length; index += 1) {
        const sourceUs = timestampUs(group[index]);
        if (sourceUs == null) continue;
        if (sourceUs - hubUs > MATCH_WINDOW_US) break;
        candidates.push(group[index]);
      }
    }
    multiplicity.set(candidates.length, (multiplicity.get(candidates.length) || 0) + 1);
    if (candidates.length === 0) noCandidate += 1;
    else if (candidates.length > 1) multipleCandidates += 1;
    else uniqueHubSelections.push({
      hub,
      source: candidates[0],
      deltaUs: (timestampUs(candidates[0]) as bigint) - (hubUs as bigint),
    });
  }

  const sourceUse = new Map<string, number>();
  for (const selection of uniqueHubSelections) {
    const sourceId = String(selection.source.id);
    sourceUse.set(sourceId, (sourceUse.get(sourceId) || 0) + 1);
  }

  let publicReuse = 0;
  let invalidSourceOutcome = 0;
  const pairs: DbRow[] = [];
  for (const selection of uniqueHubSelections) {
    if ((sourceUse.get(String(selection.source.id)) || 0) !== 1) {
      publicReuse += 1;
      continue;
    }
    if (!validSourceOutcome(selection.source)) {
      invalidSourceOutcome += 1;
      continue;
    }
    pairs.push({
      hub_id: String(selection.hub.id),
      public_id: String(selection.source.id),
      agent: String(selection.hub.agent),
      caller_team: String(selection.hub.caller_team),
      prompt_chars: Number(selection.hub.prompt_chars),
      hub_created_at: isoFromTimestampUs(timestampUs(selection.hub) as bigint),
      public_created_at: isoFromTimestampUs(timestampUs(selection.source) as bigint),
      delta_us: String(selection.deltaUs),
      delta_ms: Number(selection.deltaUs) / 1000,
      success: selection.source.success,
      latency_ms: Number(selection.source.duration_ms),
      source_cost_usd: String(selection.source.source_cost_usd),
      cost_usd: canonicalCost(selection.source.target_cost_usd),
      before: {
        success: selection.hub.success ?? null,
        latency_ms: selection.hub.latency_ms ?? null,
        cost_usd: selection.hub.cost_usd == null ? null : canonicalCost(selection.hub.cost_usd),
      },
      learning_prerequisites: {
        mode_shadow: selection.hub.mode === 'shadow',
        signature_present: Boolean(selection.hub.has_signature),
        signature_key_present: Boolean(selection.hub.signature_key),
        routing_request_id_present: Boolean(selection.hub.routing_request_id),
        execution_model_present: Boolean(selection.hub.execution_model),
      },
    });
  }
  pairs.sort((left, right) => {
    const timeDelta = String(left.hub_created_at).localeCompare(String(right.hub_created_at));
    return timeDelta || compareIds(left.hub_id, right.hub_id);
  });

  const matchedHubIds = new Set(pairs.map((pair) => pair.hub_id));
  const dayDistribution: Record<string, { population: number; matched: number; excluded: number }> = {};
  for (const row of hubRows) {
    const day = kstDay(row);
    dayDistribution[day] ||= { population: 0, matched: 0, excluded: 0 };
    dayDistribution[day].population += 1;
    if (matchedHubIds.has(String(row.id))) dayDistribution[day].matched += 1;
  }
  for (const value of Object.values(dayDistribution)) value.excluded = value.population - value.matched;

  const deltas = pairs.map((pair) => pair.delta_ms);
  const latency = pairs.map((pair) => pair.latency_ms);
  const costTotal = pairs.reduce((sum, pair) => sum + costMicros(pair.cost_usd), 0n);
  const sourceCostTotal = pairs.reduce((sum, pair) => sum + Number(pair.source_cost_usd), 0);
  const costRoundingDeltas = pairs.map((pair) => Number(pair.cost_usd) - Number(pair.source_cost_usd));
  const learning = {
    matched_shadow: pairs.filter((pair) => pair.learning_prerequisites.mode_shadow).length,
    signature_present: pairs.filter((pair) => pair.learning_prerequisites.signature_present).length,
    signature_key_present: pairs.filter((pair) => pair.learning_prerequisites.signature_key_present).length,
    routing_request_id_present: pairs.filter((pair) => pair.learning_prerequisites.routing_request_id_present).length,
    execution_model_present: pairs.filter((pair) => pair.learning_prerequisites.execution_model_present).length,
    after_backfill: pairs.filter((pair) => Object.values(pair.learning_prerequisites).every(Boolean)).length,
  };
  const applyState = { pending: 0, already_applied: 0, conflict: 0, conflict_ids: [] as string[] };
  for (const pair of pairs) {
    const state = targetState(pair.before, pair);
    applyState[state] += 1;
    if (state === 'conflict') applyState.conflict_ids.push(pair.hub_id);
  }

  const exclusions = {
    no_candidate: noCandidate,
    multiple_candidates: multipleCandidates,
    public_reuse: publicReuse,
    invalid_source_outcome: invalidSourceOutcome,
  };
  const before = outcomeCounts(hubRows);
  const stats = {
    population: hubRows.length,
    matched: pairs.length,
    excluded: hubRows.length - pairs.length,
    exclusions,
    candidate_multiplicity: Object.fromEntries([...multiplicity].sort(([left], [right]) => left - right)),
    hub_with_candidate: hubRows.length - noCandidate,
    unique_hub_candidate_selections: uniqueHubSelections.length,
    one_to_one: {
      pair_count: pairs.length,
      distinct_hub_ids: new Set(pairs.map((pair) => pair.hub_id)).size,
      distinct_public_ids: new Set(pairs.map((pair) => pair.public_id)).size,
    },
    day_distribution: dayDistribution,
    delta_ms: {
      min: deltas.length ? Math.min(...deltas) : null,
      p50: rounded(percentile(deltas, 0.5) ?? Number.NaN),
      p90: rounded(percentile(deltas, 0.9) ?? Number.NaN),
      p95: rounded(percentile(deltas, 0.95) ?? Number.NaN),
      p99: rounded(percentile(deltas, 0.99) ?? Number.NaN),
      average: rounded(deltas.reduce((sum, value) => sum + value, 0) / deltas.length),
      max: deltas.length ? Math.max(...deltas) : null,
    },
    expected_outcomes: {
      success_true: pairs.filter((pair) => pair.success === true).length,
      success_false: pairs.filter((pair) => pair.success === false).length,
      latency_ms_min: latency.length ? Math.min(...latency) : null,
      latency_ms_average: rounded(latency.reduce((sum, value) => sum + value, 0) / latency.length),
      latency_ms_max: latency.length ? Math.max(...latency) : null,
      source_cost_usd_total: rounded(sourceCostTotal, 9),
      cost_usd_total: microsCost(costTotal),
      cost_rounding_rows: costRoundingDeltas.filter((value) => value !== 0).length,
      cost_rounding_delta_total: rounded(costRoundingDeltas.reduce((sum, value) => sum + value, 0), 9),
      cost_rounding_delta_max_abs: rounded(Math.max(0, ...costRoundingDeltas.map(Math.abs)), 9),
    },
    learning_eligibility: learning,
    target_apply_state: applyState,
    before_after: {
      ...defineWriteCountEvidence(before, { ...before }),
      dry_run_unchanged: true,
    },
  };

  return {
    version: PLAN_VERSION,
    window: BACKFILL_WINDOW,
    inventory_sha256: inventorySha,
    pairs,
    stats,
    sha256: planSha256(pairs, inventorySha),
  };
}

export async function loadRoutingOutcomeBackfillRows(queryReadonly: QueryReadonly) {
  const hubRows = rowsFromResult(await queryReadonly('hub', HUB_ROWS_SQL, [
    BACKFILL_WINDOW.start,
    BACKFILL_WINDOW.end_exclusive,
  ]));
  const publicRows = rowsFromResult(await queryReadonly('hub', PUBLIC_ROWS_SQL, [
    BACKFILL_WINDOW.start,
    BACKFILL_WINDOW.source_end_exclusive,
  ]));
  return { hubRows, publicRows };
}

function csvCell(value: unknown): string {
  if (value == null) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function pairsCsv(pairs: DbRow[]): string {
  const fields = [
    'hub_id', 'public_id', 'agent', 'caller_team', 'prompt_chars',
    'hub_created_at', 'public_created_at', 'delta_us', 'delta_ms', 'success',
    'latency_ms', 'source_cost_usd', 'cost_usd', 'before',
  ];
  return [
    fields.join(','),
    ...pairs.map((pair) => fields.map((field) => csvCell(pair[field])).join(',')),
  ].join('\n') + '\n';
}

function summaryArtifact(plan: any) {
  return {
    task: 'TASK-0086',
    status: 'dry_run',
    generated_at: new Date().toISOString(),
    live_mutation: false,
    plan_sha256: plan.sha256,
    inventory_sha256: plan.inventory_sha256,
    window: plan.window,
    match_contract: stablePlanPayload(plan.pairs, plan.inventory_sha256).match_contract,
    stats: plan.stats,
    sample_pairs: plan.pairs.slice(0, 20),
    write_gate: {
      required: true,
      command: `npm --prefix bots/hub run -s llm:routing-outcome-backfill -- --write --confirm=${plan.sha256}`,
      reviewed_plan_sha256_required: plan.sha256,
    },
    cluster_learning_review: {
      outcome_only_backfill_enters_learning: plan.stats.learning_eligibility.after_backfill,
      reason: 'cluster history also requires routing_signals.execution.model; this backfill does not modify routing_signals',
    },
  };
}

function rollbackArtifact(plan: any, rows = plan.pairs) {
  return {
    task: 'TASK-0086',
    purpose: 'rollback_snapshot',
    generated_at: new Date().toISOString(),
    plan_sha256: plan.sha256,
    inventory_sha256: plan.inventory_sha256,
    window: plan.window,
    restore_scope: 'exact_hub_ids_only',
    rows: rows.map((pair: DbRow) => ({
      hub_id: pair.hub_id,
      public_id: pair.public_id,
      before: pair.before,
      intended: {
        success: pair.success,
        latency_ms: pair.latency_ms,
        cost_usd: pair.cost_usd,
      },
    })),
  };
}

export async function writeRoutingOutcomeBackfillArtifacts(plan: any, artifactDir = DEFAULT_ARTIFACT_DIR) {
  await fs.promises.mkdir(artifactDir, { recursive: true });
  const prefix = `TASK-0086-routing-outcome-backfill-${plan.sha256.slice(0, 12)}-dry-run-${immutableRunId()}`;
  const artifacts = {
    summary: path.join(artifactDir, `${prefix}.summary.json`),
    pairs: path.join(artifactDir, `${prefix}.pairs.csv`),
    rollback_snapshot: path.join(artifactDir, `${prefix}.rollback-snapshot.json`),
  };
  await writeImmutableFile(artifacts.summary, `${JSON.stringify(summaryArtifact(plan), null, 2)}\n`);
  await writeImmutableFile(artifacts.pairs, pairsCsv(plan.pairs));
  await writeImmutableFile(
    artifacts.rollback_snapshot,
    `${JSON.stringify(rollbackArtifact(plan), null, 2)}\n`,
  );
  return artifacts;
}

async function writeLockedRollbackSnapshot(snapshot: any, artifactDir = DEFAULT_ARTIFACT_DIR): Promise<string> {
  await fs.promises.mkdir(artifactDir, { recursive: true });
  const filePath = buildLockedRollbackSnapshotPath({
    artifactDir,
    actionPrefix: 'TASK-0086-routing-outcome-backfill',
    planSha256: snapshot.plan_sha256,
    runId: immutableRunId(),
  });
  await writeImmutableFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`);
  return filePath;
}

async function writeApplicationReceipt(receipt: any, artifactDir = DEFAULT_ARTIFACT_DIR): Promise<string> {
  await fs.promises.mkdir(artifactDir, { recursive: true });
  const filePath = path.join(
    artifactDir,
    `TASK-0086-routing-outcome-backfill-${receipt.plan_sha256.slice(0, 12)}-apply-${immutableRunId()}.receipt.json`,
  );
  await writeImmutableFile(filePath, `${JSON.stringify(receipt, null, 2)}\n`);
  return filePath;
}

export async function applyRoutingOutcomeBackfillPlan(plan: any, {
  db = pgPool,
  write = false,
  confirm = '',
  artifactDir = DEFAULT_ARTIFACT_DIR,
  writeSnapshot = (snapshot: any) => writeLockedRollbackSnapshot(snapshot, artifactDir),
  writeReceipt = (receipt: any) => writeApplicationReceipt(receipt, artifactDir),
}: {
  db?: any;
  write?: boolean;
  confirm?: string;
  artifactDir?: string;
  writeSnapshot?: (snapshot: any) => Promise<string>;
  writeReceipt?: (receipt: any) => Promise<string>;
} = {}) {
  if (!write) throw new Error('write_flag_required');
  if (!matchesWriteActionConfirm(confirm, plan.sha256)) throw new Error('write_confirm_sha256_mismatch');
  if (
    !Array.isArray(plan?.pairs)
    || plan?.version !== PLAN_VERSION
    || JSON.stringify(plan?.window) !== JSON.stringify(BACKFILL_WINDOW)
    || typeof plan?.inventory_sha256 !== 'string'
    || planSha256(plan.pairs, plan.inventory_sha256) !== plan.sha256
  ) throw new Error('supplied_plan_integrity_mismatch');
  if (typeof db?.transaction !== 'function') throw new Error('write_transaction_required');

  const transactionResult = await db.transaction('hub', async (client: any) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ADVISORY_LOCK_KEY]);

    const liveRows = await loadRoutingOutcomeBackfillRows(async (_schema, sql, params = []) => (
      rowsFromResult(await client.query(sql, params))
    ));
    const livePlan = buildRoutingOutcomeBackfillPlan(liveRows.hubRows, liveRows.publicRows);
    if (livePlan.sha256 !== plan.sha256) {
      throw new Error(`backfill_plan_drift:reviewed=${plan.sha256}:live=${livePlan.sha256}`);
    }
    const authoritativePlan = livePlan;

    const ids = authoritativePlan.pairs.map((pair: DbRow) => String(pair.hub_id)).sort(compareIds);
    const lockedRows = rowsFromResult(await client.query(LOCK_TARGET_ROWS_SQL, [
      ids,
      BACKFILL_WINDOW.start,
      BACKFILL_WINDOW.end_exclusive,
    ]));
    const lockedById = new Map(lockedRows.map((row) => [String(row.id), row]));
    if (lockedRows.length !== ids.length || ids.some((id: string) => !lockedById.has(id))) {
      throw new Error(`target_lock_count_mismatch:expected=${ids.length}:actual=${lockedRows.length}`);
    }

    const pending: DbRow[] = [];
    const alreadyApplied: DbRow[] = [];
    for (const pair of authoritativePlan.pairs) {
      const locked = lockedById.get(String(pair.hub_id));
      const state = targetState(locked || {}, pair);
      if (state === 'conflict') throw new Error(`target_outcome_conflict:${pair.hub_id}`);
      if (state === 'pending') pending.push({
        ...pair,
        before: {
          success: locked?.success ?? null,
          latency_ms: locked?.latency_ms ?? null,
          cost_usd: locked?.cost_usd == null ? null : canonicalCost(locked.cost_usd),
        },
      });
      else alreadyApplied.push(pair);
    }

    let snapshotPath: string | null = null;
    if (pending.length > 0) {
      snapshotPath = await bounded(writeSnapshot({
        task: 'TASK-0086',
        purpose: 'locked_pre_update_rollback_snapshot',
        generated_at: new Date().toISOString(),
        version: authoritativePlan.version,
        plan_sha256: plan.sha256,
        inventory_sha256: authoritativePlan.inventory_sha256,
        window: authoritativePlan.window,
        restore_scope: 'exact_hub_ids_only',
        rows: rollbackArtifact(authoritativePlan, pending).rows,
      }), 15_000, 'rollback_snapshot_timeout');
      const updateInput = pending.map((pair) => ({
        id: pair.hub_id,
        success: pair.success,
        latency_ms: pair.latency_ms,
        cost_usd: pair.cost_usd,
      }));
      const updateResult = await client.query(UPDATE_TARGET_ROWS_SQL, [
        JSON.stringify(updateInput),
        BACKFILL_WINDOW.start,
        BACKFILL_WINDOW.end_exclusive,
      ]);
      const updatedIds = rowsFromResult(updateResult).map((row) => String(row.id)).sort(compareIds);
      const pendingIds = pending.map((pair) => String(pair.hub_id)).sort(compareIds);
      if (Number(updateResult?.rowCount || 0) !== pending.length || JSON.stringify(updatedIds) !== JSON.stringify(pendingIds)) {
        throw new Error(`target_update_count_mismatch:expected=${pending.length}:actual=${updateResult?.rowCount || 0}`);
      }
    }

    const verifiedRows = rowsFromResult(await client.query(LOCK_TARGET_ROWS_SQL, [
      ids,
      BACKFILL_WINDOW.start,
      BACKFILL_WINDOW.end_exclusive,
    ]));
    const verifiedById = new Map(verifiedRows.map((row) => [String(row.id), row]));
    const verificationFailures = authoritativePlan.pairs.filter((pair: DbRow) => (
      targetState(verifiedById.get(String(pair.hub_id)) || {}, pair) !== 'already_applied'
    ));
    if (verificationFailures.length > 0) {
      throw new Error(`post_update_verification_failed:${verificationFailures[0].hub_id}`);
    }
    const afterHubRows = rowsFromResult(await client.query(HUB_ROWS_SQL, [
      BACKFILL_WINDOW.start,
      BACKFILL_WINDOW.end_exclusive,
    ]));
    const updatedIdsSha256 = crypto.createHash('sha256')
      .update(pending.map((pair) => String(pair.hub_id)).sort(compareIds).join('\n'))
      .digest('hex');

    const countEvidence = defineWriteCountEvidence(
      {
        matched: { pending: pending.length, already_applied: alreadyApplied.length, conflict: 0 },
        fixed_population: outcomeCounts(liveRows.hubRows),
      },
      {
        matched: { pending: 0, already_applied: authoritativePlan.pairs.length, conflict: 0 },
        fixed_population: outcomeCounts(afterHubRows),
      },
    );
    return {
      applied: pending.length,
      already_applied: alreadyApplied.length,
      conflicts: 0,
      rollback_snapshot: snapshotPath,
      version: authoritativePlan.version,
      window: authoritativePlan.window,
      plan_sha256: plan.sha256,
      inventory_sha256: authoritativePlan.inventory_sha256,
      updated_ids_sha256: updatedIdsSha256,
      before: countEvidence.before,
      after: countEvidence.after,
    };
  });
  try {
    const receiptPath = await writeReceipt({
      task: 'TASK-0086',
      purpose: 'post_commit_application_receipt',
      committed_at: new Date().toISOString(),
      ...transactionResult,
    });
    return {
      ...transactionResult,
      ok: true,
      committed: true,
      application_receipt: receiptPath,
      receipt_error: null,
    };
  } catch (error: any) {
    return {
      ...transactionResult,
      ok: false,
      committed: true,
      application_receipt: null,
      receipt_error: `post_commit_receipt_failed:${error?.message || error}`,
    };
  }
}

function argValue(argv: string[], name: string): string {
  const prefix = `--${name}=`;
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || '';
}

export async function runRoutingOutcomeBackfill({
  argv = process.argv.slice(2),
  queryReadonly = pgPool.queryReadonly,
  db = pgPool,
  artifactDir = DEFAULT_ARTIFACT_DIR,
  writeArtifacts = writeRoutingOutcomeBackfillArtifacts,
}: {
  argv?: string[];
  queryReadonly?: QueryReadonly;
  db?: any;
  artifactDir?: string;
  writeArtifacts?: (plan: any, artifactDir?: string) => Promise<Record<string, string>>;
} = {}) {
  const write = argv.includes('--write');
  const confirm = argValue(argv, 'confirm');
  if (write && !/^[a-f0-9]{64}$/.test(confirm)) throw new Error('write_confirm_sha256_required');

  const rows = await loadRoutingOutcomeBackfillRows(queryReadonly);
  const plan = buildRoutingOutcomeBackfillPlan(rows.hubRows, rows.publicRows);
  const artifacts = await writeArtifacts(plan, artifactDir);
  if (!write) {
    return {
      ok: true,
      dry_run: true,
      write_attempted: false,
      live_mutation: false,
      plan_sha256: plan.sha256,
      matched: plan.stats.matched,
      excluded: plan.stats.excluded,
      artifacts,
    };
  }
  if (!matchesWriteActionConfirm(confirm, plan.sha256)) throw new Error('write_confirm_sha256_mismatch');
  const applied = await applyRoutingOutcomeBackfillPlan(plan, {
    db,
    write: true,
    confirm,
    artifactDir,
  });
  return {
    ok: true,
    dry_run: false,
    write_attempted: true,
    live_mutation: applied.applied > 0,
    plan_sha256: plan.sha256,
    matched: plan.stats.matched,
    excluded: plan.stats.excluded,
    artifacts,
    ...applied,
  };
}

async function main() {
  try {
    const result = await runRoutingOutcomeBackfill();
    console.log(JSON.stringify(result, null, 2));
    if (result.ok === false) process.exitCode = 2;
  } finally {
    await pgPool.closeAll?.();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[llm-routing-outcome-backfill] ${error?.message || error}`);
    process.exitCode = 1;
  });
}
