#!/usr/bin/env tsx

import { createRequire } from 'node:module';
import {
  QUARANTINED_EXACT_LLM_ROUTES,
} from '../../../packages/core/lib/llm-provider-retirement';

type ObservationRow = {
  selector_key?: string;
  runtime_purpose?: string;
  calls?: number | string;
  successes?: number | string;
  failures?: number | string;
  timeout_calls?: number | string;
  fallback_calls?: number | string;
  fallback_attempts?: number | string;
  quarantined_route_calls?: number | string;
  selected_routes?: string[] | string | null;
  first_seen?: string | Date | null;
  last_seen?: string | Date | null;
};

type BuildOptions = {
  hours?: number;
  selectors?: string[];
  generatedAt?: string;
};

type ObservationTotals = {
  calls: number;
  successes: number;
  failures: number;
  timeoutCalls: number;
  fallbackCalls: number;
  fallbackAttempts: number;
  quarantinedRouteCalls: number;
};

const require = createRequire(__filename);
const DEFAULT_SELECTORS = Object.freeze([
  'investment.nemesis',
  'investment.chronos',
  'chronos.backtest',
]);

function positiveInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function numeric(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeText(value: unknown, fallback = ''): string {
  return String(value || '').trim() || fallback;
}

function normalizeRoutes(value: ObservationRow['selected_routes']): string[] {
  if (Array.isArray(value)) return value.map((route) => normalizeText(route)).filter(Boolean);
  const text = normalizeText(value);
  if (!text) return [];
  if (text.startsWith('{') && text.endsWith('}')) {
    return text.slice(1, -1).split(',').map((route) => route.replace(/^"|"$/g, '').trim()).filter(Boolean);
  }
  return [text];
}

function isoOrNull(value: ObservationRow['first_seen']): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function summarizeRows(rows: ObservationRow[], selectorKey: string) {
  const matching = rows.filter((row) => normalizeText(row.selector_key, 'unknown') === selectorKey);
  const runtimePurposes = new Set<string>();
  const selectedRoutes = new Set<string>();
  let firstSeen: string | null = null;
  let lastSeen: string | null = null;
  const summary = {
    selectorKey,
    status: 'no_sample',
    reasons: ['no_sample'] as string[],
    calls: 0,
    successes: 0,
    failures: 0,
    timeoutCalls: 0,
    fallbackCalls: 0,
    fallbackAttempts: 0,
    quarantinedRouteCalls: 0,
    runtimePurposes: [] as string[],
    selectedRoutes: [] as string[],
    firstSeen: null as string | null,
    lastSeen: null as string | null,
  };

  for (const row of matching) {
    summary.calls += numeric(row.calls);
    summary.successes += numeric(row.successes);
    summary.failures += numeric(row.failures);
    summary.timeoutCalls += numeric(row.timeout_calls);
    summary.fallbackCalls += numeric(row.fallback_calls);
    summary.fallbackAttempts += numeric(row.fallback_attempts);
    summary.quarantinedRouteCalls += numeric(row.quarantined_route_calls);
    runtimePurposes.add(normalizeText(row.runtime_purpose, 'default'));
    normalizeRoutes(row.selected_routes).forEach((route) => selectedRoutes.add(route));
    const rowFirst = isoOrNull(row.first_seen);
    const rowLast = isoOrNull(row.last_seen);
    if (rowFirst && (!firstSeen || rowFirst < firstSeen)) firstSeen = rowFirst;
    if (rowLast && (!lastSeen || rowLast > lastSeen)) lastSeen = rowLast;
  }

  summary.runtimePurposes = [...runtimePurposes].sort();
  summary.selectedRoutes = [...selectedRoutes].sort();
  summary.firstSeen = firstSeen;
  summary.lastSeen = lastSeen;
  if (summary.calls === 0) return summary;

  const reasons: string[] = [];
  if (summary.failures > 0) reasons.push('failure_observed');
  if (summary.timeoutCalls > 0) reasons.push('timeout_observed');
  if (summary.fallbackCalls > 0) reasons.push('fallback_observed');
  if (summary.quarantinedRouteCalls > 0) reasons.push('quarantined_route_observed');
  summary.status = reasons.length > 0 ? 'degraded' : 'healthy';
  summary.reasons = reasons;
  return summary;
}

export function buildRoutingObservationReport(rows: ObservationRow[] = [], options: BuildOptions = {}) {
  const hours = positiveInteger(options.hours, 24, 1, 168);
  const selectorKeys = (options.selectors?.length ? options.selectors : DEFAULT_SELECTORS)
    .map((selector) => normalizeText(selector))
    .filter(Boolean);
  const selectors = selectorKeys.map((selectorKey) => summarizeRows(rows, selectorKey));
  const totals = selectors.reduce<ObservationTotals>((acc, selector) => ({
    calls: acc.calls + selector.calls,
    successes: acc.successes + selector.successes,
    failures: acc.failures + selector.failures,
    timeoutCalls: acc.timeoutCalls + selector.timeoutCalls,
    fallbackCalls: acc.fallbackCalls + selector.fallbackCalls,
    fallbackAttempts: acc.fallbackAttempts + selector.fallbackAttempts,
    quarantinedRouteCalls: acc.quarantinedRouteCalls + selector.quarantinedRouteCalls,
  }), {
    calls: 0,
    successes: 0,
    failures: 0,
    timeoutCalls: 0,
    fallbackCalls: 0,
    fallbackAttempts: 0,
    quarantinedRouteCalls: 0,
  });
  const status = selectors.some((item) => item.status === 'degraded')
    ? 'degraded'
    : (selectors.every((item) => item.status === 'no_sample')
        ? 'no_sample'
        : (selectors.some((item) => item.status === 'no_sample') ? 'incomplete' : 'healthy'));
  const missingSelectors = selectors
    .filter((item) => item.status === 'no_sample')
    .map((item) => item.selectorKey);

  return {
    ok: true,
    status,
    generatedAt: options.generatedAt || new Date().toISOString(),
    windowHours: hours,
    source: 'public.llm_routing_log',
    selectors,
    selectorCoverage: {
      required: selectors.length,
      sampled: selectors.length - missingSelectors.length,
      missingSelectors,
    },
    totals,
    quarantinedRoutes: Object.keys(QUARANTINED_EXACT_LLM_ROUTES),
    liveMutation: false,
    dbWrite: false,
    externalCall: false,
  };
}

export async function fetchRoutingObservationRows(hours = 24): Promise<ObservationRow[]> {
  const pgPool = require('../../../packages/core/lib/pg-pool.ts');
  const quarantinedRoutes = Object.keys(QUARANTINED_EXACT_LLM_ROUTES);
  return pgPool.queryReadonly('public', `
    SELECT
      COALESCE(NULLIF(selector_key, ''), NULLIF(CONCAT_WS('.', caller_team, agent), ''), 'unknown') AS selector_key,
      COALESCE(NULLIF(runtime_purpose, ''), 'default') AS runtime_purpose,
      COUNT(*)::int AS calls,
      COUNT(*) FILTER (WHERE success IS TRUE)::int AS successes,
      COUNT(*) FILTER (WHERE success IS NOT TRUE)::int AS failures,
      COUNT(*) FILTER (
        WHERE LOWER(COALESCE(error, '')) LIKE '%timeout%'
           OR LOWER(COALESCE(error, '')) LIKE '%deadline_exceeded%'
      )::int AS timeout_calls,
      COUNT(*) FILTER (WHERE COALESCE(fallback_count, 0) > 0)::int AS fallback_calls,
      COALESCE(SUM(fallback_count), 0)::int AS fallback_attempts,
      COUNT(*) FILTER (
        WHERE selected_route = ANY($2::text[])
           OR COALESCE(attempted_providers, '[]'::jsonb) ?| $2::text[]
      )::int AS quarantined_route_calls,
      ARRAY_AGG(DISTINCT selected_route) FILTER (WHERE selected_route IS NOT NULL) AS selected_routes,
      MIN(created_at) AS first_seen,
      MAX(created_at) AS last_seen
    FROM public.llm_routing_log
    WHERE created_at >= NOW() - ($1::int * INTERVAL '1 hour')
    GROUP BY 1, 2
    ORDER BY calls DESC
  `, [positiveInteger(hours, 24, 1, 168), quarantinedRoutes]);
}

function parseArgs(argv = process.argv.slice(2)) {
  let hours = 24;
  const selectors: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--hours') hours = positiveInteger(argv[++index], 24, 1, 168);
    else if (arg.startsWith('--hours=')) hours = positiveInteger(arg.slice('--hours='.length), 24, 1, 168);
    else if (arg === '--selector') selectors.push(normalizeText(argv[++index]));
    else if (arg.startsWith('--selector=')) selectors.push(normalizeText(arg.slice('--selector='.length)));
    else if (arg === '--selectors') selectors.push(...normalizeText(argv[++index]).split(','));
    else if (arg.startsWith('--selectors=')) selectors.push(...arg.slice('--selectors='.length).split(','));
    else if (arg !== '--json') throw new Error(`unknown argument: ${arg}`);
  }
  return { hours, selectors: selectors.map((item) => item.trim()).filter(Boolean) };
}

async function main() {
  const options = parseArgs();
  const pgPool = require('../../../packages/core/lib/pg-pool.ts');
  try {
    const rows = await fetchRoutingObservationRows(options.hours);
    console.log(JSON.stringify(buildRoutingObservationReport(rows, options), null, 2));
  } finally {
    await pgPool.closeAll();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`llm-routing-24h-observation failed: ${error?.message || error}`);
    process.exit(1);
  });
}

export const _testOnly = {
  normalizeRoutes,
  summarizeRows,
  parseArgs,
};
