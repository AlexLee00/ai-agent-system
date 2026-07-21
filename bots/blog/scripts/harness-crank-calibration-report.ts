#!/usr/bin/env tsx

const pgPool = require('../../../packages/core/lib/pg-pool');
const {
  CONTENT_HARNESS_CALIBRATION,
  buildContentHarnessReport,
} = require('../lib/content-harness.ts');

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
  calibrated_harness_report?: unknown;
  title?: unknown;
  content?: unknown;
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
  crankTotal: number | null;
  wouldBlock: boolean;
  rules: Map<RuleId, boolean>;
  calibratedRules: Map<RuleId, boolean>;
};

type ThresholdBacktest = {
  min_noncritical_violations: number;
  blocked_count: number;
  blocked_rate: number;
  pending_score_count: number;
  blocked_crank: Distribution;
  clear_crank: Distribution;
  crank_delta: number | null;
  classification_status: 'insufficient' | 'comparable';
};

type CalibrationScope = {
  sample_size: number;
  scored_count: number;
  pending_score_count: number;
  thresholds: ThresholdBacktest[];
  selected: ThresholdBacktest;
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
    cohort: { min_post_id: number; max_post_id: number };
  };
  scopes: Record<ScopeName, ScopeReport>;
  calibration: {
    version: string;
    critical_rules: string[];
    min_noncritical_violations: number;
    cohort: { min_post_id: number; max_post_id: number };
    causal_claim: false;
    legacy_r5_passed: number;
    calibrated_r5_passed: number;
    scopes: Record<ScopeName, CalibrationScope>;
  };
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
  const hasCrank = row.crank_total != null && row.crank_total !== '';
  const crankTotal = hasCrank ? Number(row.crank_total) : null;
  const harness = parseHarnessReport(row.harness_report);
  const wouldBlock = booleanValue(harness?.would_block);
  if (!postId || (crankTotal != null && !Number.isFinite(crankTotal)) || !harness || wouldBlock == null) return null;

  const rules = new Map<RuleId, boolean>();
  if (Array.isArray(harness.rules)) {
    for (const rawRule of harness.rules as HarnessRule[]) {
      const id = String(rawRule?.id || '').trim() as RuleId;
      const passed = booleanValue(rawRule?.passed);
      if (RULE_IDS.includes(id) && passed != null) rules.set(id, passed);
    }
  }
  let calibratedHarness = parseHarnessReport(row.calibrated_harness_report);
  if (!calibratedHarness && String(row.content || '').trim()) {
    calibratedHarness = buildContentHarnessReport({
      title: String(row.title || ''),
      content: String(row.content || ''),
      postType: String(row.post_type || '').trim().toLowerCase() === 'lecture' ? 'lecture' : 'general',
    });
  }
  const calibratedRules = new Map<RuleId, boolean>();
  if (Array.isArray(calibratedHarness?.rules)) {
    for (const rawRule of calibratedHarness.rules as HarnessRule[]) {
      const id = String(rawRule?.id || '').trim() as RuleId;
      const passed = booleanValue(rawRule?.passed);
      if (RULE_IDS.includes(id) && passed != null) calibratedRules.set(id, passed);
    }
  }
  return {
    postId,
    segment: String(row.post_type || '').trim().toLowerCase() === 'lecture' ? 'pos' : 'general',
    crankTotal,
    wouldBlock,
    rules,
    calibratedRules,
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
  const violated = distribution(rows
    .filter((row) => row.rules.get(rule) === false && row.crankTotal != null)
    .map((row) => row.crankTotal as number));
  const passed = distribution(rows
    .filter((row) => row.rules.get(rule) === true && row.crankTotal != null)
    .map((row) => row.crankTotal as number));
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
  const blocked = distribution(rows
    .filter((row) => row.wouldBlock && row.crankTotal != null)
    .map((row) => row.crankTotal as number));
  const clear = distribution(rows
    .filter((row) => !row.wouldBlock && row.crankTotal != null)
    .map((row) => row.crankTotal as number));
  const delta = blocked.average == null || clear.average == null ? null : round2(blocked.average - clear.average);
  const rules = Object.fromEntries(RULE_IDS.map((rule) => [
    rule,
    compareRule(rows, rule, minSamplesPerSide, minAbsoluteDelta),
  ])) as Record<RuleId, RuleComparison>;
  return { sample_size: rows.length, would_block: { blocked, clear, delta }, rules };
}

function candidateWouldBlock(row: NormalizedRow, minNoncriticalViolations: number): boolean {
  const failedRules = RULE_IDS.filter((rule) => row.calibratedRules.get(rule) === false);
  const criticalRules = new Set<string>(CONTENT_HARNESS_CALIBRATION.criticalRules);
  return failedRules.some((rule) => criticalRules.has(rule))
    || failedRules.filter((rule) => !criticalRules.has(rule)).length >= minNoncriticalViolations;
}

function buildThresholdBacktest(
  rows: NormalizedRow[],
  minNoncriticalViolations: number,
  minSamplesPerSide: number,
): ThresholdBacktest {
  const blockedRows = rows.filter((row) => candidateWouldBlock(row, minNoncriticalViolations));
  const clearRows = rows.filter((row) => !candidateWouldBlock(row, minNoncriticalViolations));
  const blockedCrank = distribution(blockedRows
    .filter((row) => row.crankTotal != null)
    .map((row) => row.crankTotal as number));
  const clearCrank = distribution(clearRows
    .filter((row) => row.crankTotal != null)
    .map((row) => row.crankTotal as number));
  const crankDelta = blockedCrank.average == null || clearCrank.average == null
    ? null
    : round2(blockedCrank.average - clearCrank.average);
  return {
    min_noncritical_violations: minNoncriticalViolations,
    blocked_count: blockedRows.length,
    blocked_rate: rows.length ? round2((blockedRows.length / rows.length) * 100) : 0,
    pending_score_count: blockedRows.filter((row) => row.crankTotal == null).length,
    blocked_crank: blockedCrank,
    clear_crank: clearCrank,
    crank_delta: crankDelta,
    classification_status: blockedCrank.count >= minSamplesPerSide && clearCrank.count >= minSamplesPerSide
      ? 'comparable'
      : 'insufficient',
  };
}

function buildCalibrationScope(rows: NormalizedRow[], minSamplesPerSide: number): CalibrationScope {
  const thresholds = RULE_IDS.map((_, index) => (
    buildThresholdBacktest(rows, index + 1, minSamplesPerSide)
  ));
  return {
    sample_size: rows.length,
    scored_count: rows.filter((row) => row.crankTotal != null).length,
    pending_score_count: rows.filter((row) => row.crankTotal == null).length,
    thresholds,
    selected: thresholds[CONTENT_HARNESS_CALIBRATION.minNoncriticalViolations - 1],
  };
}

export function buildHarnessCrankCalibrationReport(
  rawRows: HarnessCrankRow[] = [],
  options: {
    minSamplesPerSide?: number;
    minAbsoluteDelta?: number;
    generatedAt?: string;
    days?: number;
    limit?: number;
    minPostId?: number;
    maxPostId?: number;
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
  const minPostId = Math.floor(positiveNumber(options.minPostId, 0, 0, 2_147_483_647));
  const maxPostId = Math.floor(positiveNumber(options.maxPostId, 2_147_483_647, 0, 2_147_483_647));
  const cohortRows = rawRows.filter((row) => {
    const postId = Number(row.post_id);
    return Number.isFinite(postId) && postId >= minPostId && postId <= maxPostId;
  });
  const harnessReportsSeen = cohortRows.filter((row) => {
    const harness = parseHarnessReport(row.harness_report);
    return String(row.post_id ?? '').trim() && booleanValue(harness?.would_block) != null;
  }).length;
  const allRows = cohortRows.map(normalizeRow).filter((row): row is NormalizedRow => row != null);
  const rows = allRows.filter((row) => row.crankTotal != null);
  const scopes: Record<ScopeName, ScopeReport> = {
    all: buildScope(rows, minSamplesPerSide, minAbsoluteDelta),
    pos: buildScope(rows.filter((row) => row.segment === 'pos'), minSamplesPerSide, minAbsoluteDelta),
    general: buildScope(rows.filter((row) => row.segment === 'general'), minSamplesPerSide, minAbsoluteDelta),
  };
  const calibrationScopes: Record<ScopeName, CalibrationScope> = {
    all: buildCalibrationScope(allRows, minSamplesPerSide),
    pos: buildCalibrationScope(allRows.filter((row) => row.segment === 'pos'), minSamplesPerSide),
    general: buildCalibrationScope(allRows.filter((row) => row.segment === 'general'), minSamplesPerSide),
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
      cohort: { min_post_id: minPostId, max_post_id: maxPostId },
    },
    scopes,
    calibration: {
      version: CONTENT_HARNESS_CALIBRATION.version,
      critical_rules: [...CONTENT_HARNESS_CALIBRATION.criticalRules],
      min_noncritical_violations: CONTENT_HARNESS_CALIBRATION.minNoncriticalViolations,
      cohort: { min_post_id: minPostId, max_post_id: maxPostId },
      causal_claim: false,
      legacy_r5_passed: allRows.filter((row) => row.rules.get('R5') === true).length,
      calibrated_r5_passed: allRows.filter((row) => row.calibratedRules.get('R5') === true).length,
      scopes: calibrationScopes,
    },
    recommendations,
  };
}

export async function fetchHarnessCrankCalibrationRows(options: {
  days?: number;
  limit?: number;
  minPostId?: number;
  maxPostId?: number;
  pool?: QueryPool;
} = {}): Promise<HarnessCrankRow[]> {
  const days = Math.floor(positiveNumber(options.days, DEFAULT_DAYS, 1, 3650));
  const limit = Math.floor(positiveNumber(options.limit, DEFAULT_LIMIT, 1, 10_000));
  const minPostId = Math.floor(positiveNumber(options.minPostId, 0, 0, 2_147_483_647));
  const maxPostId = Math.floor(positiveNumber(options.maxPostId, 2_147_483_647, 0, 2_147_483_647));
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
      p.title,
      p.content,
      CASE WHEN latest_scores.scored_date >= p.publish_date THEN latest_scores.scored_date END AS scored_date,
      CASE WHEN latest_scores.scored_date >= p.publish_date THEN latest_scores.crank_total END AS crank_total,
      p.metadata->'harness_report' AS harness_report
    FROM blog.posts p
    LEFT JOIN latest_scores ON latest_scores.post_id = p.id
    WHERE p.metadata ? 'harness_report'
      AND p.publish_date IS NOT NULL
      AND p.publish_date >= CURRENT_DATE - ($1::text || ' days')::interval
      AND p.id BETWEEN $3 AND $4
    ORDER BY latest_scores.scored_date DESC NULLS LAST, p.id DESC
    LIMIT $2
  `, [String(days), limit, minPostId, maxPostId]);
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
    const calibrated = report.calibration.scopes[scope];
    for (const threshold of calibrated.thresholds) {
      lines.push(
        `- [${scope}] calibrated>=${threshold.min_noncritical_violations} blocked=${threshold.blocked_count}/${calibrated.sample_size} (${threshold.blocked_rate.toFixed(2)}%) crank=${threshold.blocked_crank.average ?? 'n/a'}/${threshold.clear_crank.average ?? 'n/a'} status=${threshold.classification_status}`,
      );
    }
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
  const minPostId = positiveNumber(argument('min-post-id'), 0, 0, 2_147_483_647);
  const maxPostId = positiveNumber(argument('max-post-id'), 2_147_483_647, 0, 2_147_483_647);
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
  const rows = await fetchHarnessCrankCalibrationRows({ days, limit, minPostId, maxPostId });
  const report = buildHarnessCrankCalibrationReport(rows, {
    days,
    limit,
    minSamplesPerSide,
    minAbsoluteDelta,
    minPostId,
    maxPostId,
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
