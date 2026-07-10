#!/usr/bin/env tsx
// @ts-nocheck

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pgPool = require('../../../packages/core/lib/pg-pool.ts');
import {
  getSelectorTimeoutProfilesConfig,
  resolveSelectorTimeoutProfile,
} from '../../../packages/core/lib/selector-timeout-profiles.ts';

type RoutingStatsRow = {
  selector_key: string;
  runtime_purpose?: string | null;
  sample: number;
  avg_duration_ms: number | null;
  p95_duration_ms: number | null;
  p99_duration_ms: number | null;
  max_duration_ms: number | null;
};

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_OUT = path.join(repoRoot, 'bots', 'hub', 'output', 'selector-timeout-profiles.proposed.json');

function argValue(name: string, fallback: string | null = null): string | null {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function positiveInt(value: unknown, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function tierBounds(selectorKey: string, runtimePurpose: string) {
  const config = getSelectorTimeoutProfilesConfig();
  const baseDeclaration = config.selectors?.[selectorKey] || {};
  const declaration = baseDeclaration.purposes?.[runtimePurpose] || baseDeclaration;
  const tierName = declaration.tier || config.defaultTier || 'standard';
  const tier = config.tiers?.[tierName] || {};
  const current = resolveSelectorTimeoutProfile(selectorKey, {
    env: { ...process.env, SELECTOR_TIMEOUT_PROFILES_ENABLED: 'true' },
    runtimePurpose,
  });
  return {
    tier: tierName,
    currentTimeoutMs: current.timeoutMs || tier.timeoutMs || config.globalDefaultTimeoutMs || 60_000,
    minMs: positiveInt(current.minMs ?? declaration.minMs ?? tier.minMs, 5_000),
    maxMs: positiveInt(current.maxMs ?? declaration.maxMs ?? tier.maxMs, 300_000),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export function buildSelectorTimeoutTunerReport(rows: RoutingStatsRow[], options: any = {}) {
  const minSamples = positiveInt(options.minSamples, 10, 1, 10_000);
  const generatedAt = options.generatedAt || new Date().toISOString();
  const suggestions = rows.map((row) => {
    const selectorKey = String(row.selector_key || '').trim();
    const runtimePurpose = String(row.runtime_purpose || 'default').trim() || 'default';
    const bounds = tierBounds(selectorKey, runtimePurpose);
    const sample = positiveInt(row.sample, 0, 0);
    const p99 = Number(row.p99_duration_ms || 0);
    const proposed = sample >= minSamples && Number.isFinite(p99) && p99 > 0
      ? clamp(Math.ceil(p99 * 1.5), bounds.minMs, bounds.maxMs)
      : bounds.currentTimeoutMs;
    const deltaMs = proposed - bounds.currentTimeoutMs;
    return {
      selectorKey,
      runtimePurpose,
      sample,
      tier: bounds.tier,
      currentTimeoutMs: bounds.currentTimeoutMs,
      proposedTimeoutMs: proposed,
      deltaMs,
      avgDurationMs: row.avg_duration_ms == null ? null : Math.round(Number(row.avg_duration_ms)),
      p95DurationMs: row.p95_duration_ms == null ? null : Math.round(Number(row.p95_duration_ms)),
      p99DurationMs: row.p99_duration_ms == null ? null : Math.round(Number(row.p99_duration_ms)),
      maxDurationMs: row.max_duration_ms == null ? null : Math.round(Number(row.max_duration_ms)),
      status: sample >= minSamples ? 'advisory' : 'insufficient_samples_keep_current',
    };
  }).sort((a, b) => Math.abs(b.deltaMs) - Math.abs(a.deltaMs) || b.sample - a.sample);

  return {
    ok: true,
    shadowOnly: true,
    liveMutation: false,
    promotionReady: false,
    generatedAt,
    days: options.days,
    minSamples,
    suggestions,
    changed: suggestions.filter((item) => item.deltaMs !== 0),
  };
}

async function fetchRoutingStats(days: number): Promise<RoutingStatsRow[]> {
  return pgPool.queryReadonly('public', `
    SELECT
      COALESCE(NULLIF(selector_key, ''), NULLIF(CONCAT_WS('.', caller_team, agent), ''), 'unknown') AS selector_key,
      COALESCE(NULLIF(runtime_purpose, ''), 'default') AS runtime_purpose,
      COUNT(*)::int AS sample,
      AVG(duration_ms)::double precision AS avg_duration_ms,
      percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms)::int AS p95_duration_ms,
      percentile_disc(0.99) WITHIN GROUP (ORDER BY duration_ms)::int AS p99_duration_ms,
      MAX(duration_ms)::int AS max_duration_ms
    FROM public.llm_routing_log
    WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
      AND duration_ms IS NOT NULL
      AND duration_ms > 0
    GROUP BY 1, 2
    ORDER BY sample DESC
    LIMIT 500
  `, [days]);
}

async function main() {
  const days = positiveInt(argValue('--days', '14'), 14, 1, 90);
  const minSamples = positiveInt(argValue('--min-samples', '10'), 10, 1, 10000);
  const noDb = process.argv.includes('--no-db');
  const apply = process.argv.includes('--apply');
  const outPath = path.resolve(argValue('--out', DEFAULT_OUT) || DEFAULT_OUT);
  const rows = noDb ? [] : await fetchRoutingStats(days);
  const report = buildSelectorTimeoutTunerReport(rows, { days, minSamples });

  if (apply) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
    report.outputPath = outPath;
  }

  if (process.argv.includes('--json') || process.argv.includes('--no-db') || apply) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`selector-timeout-tuner suggestions=${report.suggestions.length} changed=${report.changed.length}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`selector-timeout-tuner failed: ${error?.message || error}`);
    process.exit(1);
  });
}
