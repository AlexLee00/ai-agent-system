#!/usr/bin/env tsx

const pgPool = require('../../../packages/core/lib/pg-pool');

const RULE_IDS = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6'] as const;
const RULE_NAMES: Record<RuleId, string> = {
  R1: 'concrete_title',
  R2: 'concrete_details',
  R3: 'first_person_experience',
  R4: 'trial_and_error',
  R5: 'structure_and_length',
  R6: 'forbidden_artifacts',
};
const DEFAULT_DAYS = 90;
const DEFAULT_LIMIT = 1000;
const DEFAULT_MIN_SAMPLES_PER_SIDE = 5;
const DEFAULT_MIN_ABSOLUTE_DELTA = 1.5;

type RuleId = typeof RULE_IDS[number];
type ScopeName = 'all' | 'pos' | 'general';
type RuleStatus = 'insufficient' | 'no_meaningful_delta' | 'relax_candidate' | 'retain_signal';

type HarnessRule = {
  id?: unknown;
  name?: unknown;
  passed?: unknown;
};

type HarnessReport = {
  would_block?: unknown;
  rules?: unknown;
};

export type HarnessCrankRow = {
  post_id?: unknown;
  post_type?: unknown;
  category?: unknown;
  publish_date?: unknown;
  scored_date?: unknown;
  crank_total?: unknown;
  harness_report?: unknown;
};

type QueryPool = {
  queryReadonly: (schema: string, sql: string, params?: unknown[]) => Promise<HarnessCrankRow[]>;
};

type Distribution = {
  count: number;
  average: number | null;
  min: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
  max: number | null;
};

type RuleComparison = {
  rule: RuleId;
  name: string;
  violated: Distribution;
  passed: Distribution;
  delta: number | null;
  status: RuleStatus;
  suggestion: string;
};

type ScopeReport = {
  sample_size: number;
  would_block: {
    blocked: Distribution;
    clear: Distribution;
    delta: number | null;
  };
  rules: Record<RuleId, RuleComparison>;
};

type NormalizedRow = {
  postId: string;
  segment: 'pos' | 'general';
  crankTotal: number;
  wouldBlock: boolean;
  rules: Map<RuleId, boolean>;
};

export type HarnessCrankCalibrationReport = {
  ok: true;
  status: 'insufficient' | 'monitor' | 'candidates_available';
  source: string;
  generated_at: string;
  harness_reports_seen: number;
  pending_score_count: number;
  total_samples: number;
  methodology: {
    metric: 'crank_total';
    latest_score_per_post: true;
    pos_mapping: 'post_type=lecture';
    days: number;
    row_limit: number;
    min_samples_per_side: number;
    min_absolute_delta: number;
    causal_claim: false;
  };
  scopes: Record<ScopeName, ScopeReport>;
  recommendations: Array<{
    scope: ScopeName;
    rule: RuleId;
    status: 'relax_candidate' | 'retain_signal';
    delta: number;
    violated_n: number;
    passed_n: number;
    suggestion: string;
  }>;
};

function positiveNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) return fallback;
  return Math.min(maximum, parsed);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseHarnessReport(value: unknown): HarnessReport | null {
  if (value && typeof value === 'object') return value as HarnessReport;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as HarnessReport : null;
  } catch {
    return null;
  }
}

function booleanValue(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function normalizeRow(row: HarnessCrankRow): NormalizedRow | null {
  const postId = String(row.post_id ?? '').trim();
  if (row.crank_total == null || row.crank_total === '') return null;
  const crankTotal = Number(row.crank_total);
  const harness = parseHarnessReport(row.harness_report);
  const wouldBlock = booleanValue(harness?.would_block);
  if (!postId || !Number.isFinite(crankTotal) || !harness || wouldBlock == null) return null;

  const rules = new Map<RuleId, boolean>();
  if (Array.isArray(harness.rules)) {
    for (const rawRule of harness.rules as HarnessRule[]) {
      const id = String(rawRule?.id || '').trim() as RuleId;
      const passed = booleanValue(rawRule?.passed);
      if (RULE_IDS.includes(id) && passed != null) rules.set(id, passed);
    }
  }
  return {
    postId,
    segment: String(row.post_type || '').trim().toLowerCase() === 'lecture' ? 'pos' : 'general',
    crankTotal,
    wouldBlock,
    rules,
  };
}

function percentile(sorted: number[], ratio: number): number | null {
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * ratio;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return round2(sorted[lower]);
  const weight = index - lower;
  return round2(sorted[lower] * (1 - weight) + sorted[upper] * weight);
}

function distribution(values: number[]): Distribution {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) {
    return { count: 0, average: null, min: null, p25: null, median: null, p75: null, max: null };
  }
  return {
    count: sorted.length,
    average: round2(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    min: sorted[0],
    p25: percentile(sorted, 0.25),
    median: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    max: sorted[sorted.length - 1],
  };
}

function formatDelta(value: number | null): string {
  if (value == null) return 'n/a';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
}

function compareRule(
  rows: NormalizedRow[],
  rule: RuleId,
  minSamplesPerSide: number,
  minAbsoluteDelta: number,
): RuleComparison {
  const violated = distribution(rows.filter((row) => row.rules.get(rule) === false).map((row) => row.crankTotal));
  const passed = distribution(rows.filter((row) => row.rules.get(rule) === true).map((row) => row.crankTotal));
  const delta = violated.average == null || passed.average == null
    ? null
    : round2(violated.average - passed.average);

  let status: RuleStatus;
  if (violated.count < minSamplesPerSide || passed.count < minSamplesPerSide || delta == null) {
    status = 'insufficient';
  } else if (Math.abs(delta) < minAbsoluteDelta) {
    status = 'no_meaningful_delta';
  } else {
    status = delta > 0 ? 'relax_candidate' : 'retain_signal';
  }

  const sampleLabel = `n=${violated.count}/${passed.count}`;
  let suggestion: string;
  if (status === 'insufficient') {
    suggestion = `${rule} 표본 부족·${sampleLabel}·양쪽 ${minSamplesPerSide}개 필요 → insufficient`;
  } else if (status === 'no_meaningful_delta') {
    suggestion = `${rule} 위반 crank 델타 ${formatDelta(delta)}·${sampleLabel} → 의미 있는 차이 없음`;
  } else if (status === 'relax_candidate') {
    suggestion = `${rule} 위반 crank 델타 ${formatDelta(delta)}·${sampleLabel} → 완화 후보`;
  } else {
    suggestion = `${rule} 위반 crank 델타 ${formatDelta(delta)}·${sampleLabel} → 유지 근거`;
  }
  return { rule, name: RULE_NAMES[rule], violated, passed, delta, status, suggestion };
}

function buildScope(
  rows: NormalizedRow[],
  minSamplesPerSide: number,
  minAbsoluteDelta: number,
): ScopeReport {
  const blocked = distribution(rows.filter((row) => row.wouldBlock).map((row) => row.crankTotal));
  const clear = distribution(rows.filter((row) => !row.wouldBlock).map((row) => row.crankTotal));
  const delta = blocked.average == null || clear.average == null ? null : round2(blocked.average - clear.average);
  const rules = Object.fromEntries(RULE_IDS.map((rule) => [
    rule,
    compareRule(rows, rule, minSamplesPerSide, minAbsoluteDelta),
  ])) as Record<RuleId, RuleComparison>;
  return { sample_size: rows.length, would_block: { blocked, clear, delta }, rules };
}

export function buildHarnessCrankCalibrationReport(
  rawRows: HarnessCrankRow[] = [],
  options: {
    minSamplesPerSide?: number;
    minAbsoluteDelta?: number;
    generatedAt?: string;
    days?: number;
    limit?: number;
  } = {},
): HarnessCrankCalibrationReport {
  const minSamplesPerSide = Math.floor(positiveNumber(
    options.minSamplesPerSide,
    DEFAULT_MIN_SAMPLES_PER_SIDE,
    1,
    1000,
  ));
  const minAbsoluteDelta = positiveNumber(
    options.minAbsoluteDelta,
    DEFAULT_MIN_ABSOLUTE_DELTA,
    0,
    100,
  );
  const harnessReportsSeen = rawRows.filter((row) => {
    const harness = parseHarnessReport(row.harness_report);
    return String(row.post_id ?? '').trim() && booleanValue(harness?.would_block) != null;
  }).length;
  const rows = rawRows.map(normalizeRow).filter((row): row is NormalizedRow => row != null);
  const scopes: Record<ScopeName, ScopeReport> = {
    all: buildScope(rows, minSamplesPerSide, minAbsoluteDelta),
    pos: buildScope(rows.filter((row) => row.segment === 'pos'), minSamplesPerSide, minAbsoluteDelta),
    general: buildScope(rows.filter((row) => row.segment === 'general'), minSamplesPerSide, minAbsoluteDelta),
  };
  const recommendations = (Object.entries(scopes) as Array<[ScopeName, ScopeReport]>).flatMap(([scope, report]) => (
    RULE_IDS.map((rule) => report.rules[rule])
      .filter((comparison) => comparison.status === 'relax_candidate' || comparison.status === 'retain_signal')
      .map((comparison) => ({
        scope,
        rule: comparison.rule,
        status: comparison.status as 'relax_candidate' | 'retain_signal',
        delta: comparison.delta as number,
        violated_n: comparison.violated.count,
        passed_n: comparison.passed.count,
        suggestion: comparison.suggestion,
      }))
  ));
  const hasComparableRule = RULE_IDS.some((rule) => scopes.all.rules[rule].status !== 'insufficient');
  return {
    ok: true,
    status: recommendations.length > 0 ? 'candidates_available' : hasComparableRule ? 'monitor' : 'insufficient',
    source: 'blog.posts.metadata.harness_report+blog.crank_scores.latest',
    generated_at: options.generatedAt || new Date().toISOString(),
    harness_reports_seen: harnessReportsSeen,
    pending_score_count: harnessReportsSeen - rows.length,
    total_samples: rows.length,
    methodology: {
      metric: 'crank_total',
      latest_score_per_post: true,
      pos_mapping: 'post_type=lecture',
      days: Math.floor(positiveNumber(options.days, DEFAULT_DAYS, 1, 3650)),
      row_limit: Math.floor(positiveNumber(options.limit, DEFAULT_LIMIT, 1, 10_000)),
      min_samples_per_side: minSamplesPerSide,
      min_absolute_delta: minAbsoluteDelta,
      causal_claim: false,
    },
    scopes,
    recommendations,
  };
}

export async function fetchHarnessCrankCalibrationRows(options: {
  days?: number;
  limit?: number;
  pool?: QueryPool;
} = {}): Promise<HarnessCrankRow[]> {
  const days = Math.floor(positiveNumber(options.days, DEFAULT_DAYS, 1, 3650));
  const limit = Math.floor(positiveNumber(options.limit, DEFAULT_LIMIT, 1, 10_000));
  const pool = options.pool || pgPool as QueryPool;
  return pool.queryReadonly('blog', `
    WITH latest_scores AS (
      SELECT DISTINCT ON (cs.post_id)
        cs.post_id,
        cs.scored_date,
        cs.crank_total
      FROM blog.crank_scores cs
      ORDER BY cs.post_id, cs.scored_date DESC, cs.id DESC
    )
    SELECT
      p.id AS post_id,
      p.post_type,
      p.category,
      p.publish_date,
      CASE WHEN latest_scores.scored_date >= p.publish_date THEN latest_scores.scored_date END AS scored_date,
      CASE WHEN latest_scores.scored_date >= p.publish_date THEN latest_scores.crank_total END AS crank_total,
      p.metadata->'harness_report' AS harness_report
    FROM blog.posts p
    LEFT JOIN latest_scores ON latest_scores.post_id = p.id
    WHERE p.metadata ? 'harness_report'
      AND p.publish_date IS NOT NULL
      AND p.publish_date >= CURRENT_DATE - ($1::text || ' days')::interval
    ORDER BY latest_scores.scored_date DESC NULLS LAST, p.id DESC
    LIMIT $2
  `, [String(days), limit]);
}

export function formatHarnessCrankCalibrationSummary(report: HarnessCrankCalibrationReport): string {
  const lines = [
    `harness-crank calibration status=${report.status} scored=${report.total_samples} harness=${report.harness_reports_seen} pending=${report.pending_score_count}`,
    `gate: each_side>=${report.methodology.min_samples_per_side}, |delta|>=${report.methodology.min_absolute_delta}, correlation_only`,
  ];
  for (const scope of ['all', 'pos', 'general'] as ScopeName[]) {
    const scoped = report.scopes[scope];
    lines.push(
      `[${scope}] n=${scoped.sample_size} would_block=${scoped.would_block.blocked.count}/${scoped.would_block.clear.count} delta=${formatDelta(scoped.would_block.delta)}`,
    );
    for (const rule of RULE_IDS) lines.push(`- [${scope}] ${scoped.rules[rule].suggestion}`);
  }
  return lines.join('\n');
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

async function main(): Promise<void> {
  const days = positiveNumber(argument('days'), DEFAULT_DAYS, 1, 3650);
  const limit = positiveNumber(argument('limit'), DEFAULT_LIMIT, 1, 10_000);
  const minSamplesPerSide = positiveNumber(
    argument('min-samples-per-side'),
    DEFAULT_MIN_SAMPLES_PER_SIDE,
    1,
    1000,
  );
  const minAbsoluteDelta = positiveNumber(
    argument('min-absolute-delta'),
    DEFAULT_MIN_ABSOLUTE_DELTA,
    0,
    100,
  );
  const rows = await fetchHarnessCrankCalibrationRows({ days, limit });
  const report = buildHarnessCrankCalibrationReport(rows, {
    days,
    limit,
    minSamplesPerSide,
    minAbsoluteDelta,
  });
  if (!process.argv.includes('--json')) console.log(formatHarnessCrankCalibrationSummary(report));
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`harness-crank-calibration-report failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
