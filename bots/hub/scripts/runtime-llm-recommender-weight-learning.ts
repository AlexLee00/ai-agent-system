#!/usr/bin/env tsx
// @ts-nocheck

import { createRequire } from 'node:module';
import {
  fetchLlmRecommenderWeightLearningReport,
  persistLlmRecommenderWeightShadow,
  type LlmRecommenderWeightLearningReport,
} from '../lib/llm-recommender-weight-learning.ts';

const require = createRequire(import.meta.url);

type RuntimeArgs = {
  json: boolean;
  dryRun: boolean;
  write: boolean;
  strict: boolean;
  noDb: boolean;
  days: number;
  minSamples: number;
};

type RuntimeDeps = {
  argv?: string[];
  queryFn?: ((sql: string, params?: unknown[]) => Promise<unknown[]> | unknown[]) | null;
  writeFn?: typeof persistLlmRecommenderWeightShadow;
};

const DEFAULT_DAYS = 7;
const DEFAULT_MIN_SAMPLES = 30;

export function parseLlmRecommenderWeightLearningArgs(argv = process.argv.slice(2)): RuntimeArgs {
  const args: RuntimeArgs = {
    json: false,
    dryRun: true,
    write: false,
    strict: false,
    noDb: false,
    days: DEFAULT_DAYS,
    minSamples: DEFAULT_MIN_SAMPLES,
  };

  for (const arg of argv) {
    if (arg === '--json') args.json = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--write') args.write = true;
    else if (arg === '--no-dry-run') args.dryRun = false;
    else if (arg === '--strict') args.strict = true;
    else if (arg === '--no-db') args.noDb = true;
    else if (arg.startsWith('--days=')) {
      const parsed = Math.floor(Number(arg.slice('--days='.length)));
      if (Number.isFinite(parsed) && parsed > 0) args.days = Math.min(parsed, 90);
    } else if (arg.startsWith('--min-samples=')) {
      const parsed = Math.floor(Number(arg.slice('--min-samples='.length)));
      if (Number.isFinite(parsed) && parsed > 0) args.minSamples = Math.min(parsed, 10_000);
    }
  }

  return args;
}

export async function runLlmRecommenderWeightLearningRuntime(deps: RuntimeDeps = {}): Promise<{
  report: LlmRecommenderWeightLearningReport;
  exitCode: number;
  wrote: boolean;
}> {
  const args = parseLlmRecommenderWeightLearningArgs(deps.argv);
  const queryFn = args.noDb ? null : deps.queryFn || buildRuntimeQueryFn();
  const report = await fetchLlmRecommenderWeightLearningReport({
    queryFn,
    noDb: args.noDb,
    days: args.days,
    minSamples: args.minSamples,
  });
  let wrote = false;

  if (args.write && !args.dryRun && !args.noDb) {
    const writeFn = deps.writeFn || persistLlmRecommenderWeightShadow;
    await writeFn(report);
    wrote = true;
  }

  const exitCode = args.strict && !report.manualPromotionReviewCandidate ? 1 : 0;
  return { report, exitCode, wrote };
}

function buildRuntimeQueryFn() {
  const pgPool = require('../../../packages/core/lib/pg-pool');
  return async (sql: string, params: unknown[] = []) => {
    assertReadOnlySql(sql);
    return pgPool.query('public', sql, params);
  };
}

function assertReadOnlySql(sql: string): void {
  const normalized = String(sql || '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
  if (!/^(select|with)\b/i.test(normalized)) {
    throw new Error('llm_recommender_weight_learning_read_only_violation: only SELECT/WITH statements are allowed');
  }
  if (/\b(insert|update|delete|alter|create|drop|truncate|grant|revoke|merge|copy|call)\b/i.test(normalized)) {
    throw new Error('llm_recommender_weight_learning_read_only_violation: mutating SQL keyword detected');
  }
}

function printReport(report: LlmRecommenderWeightLearningReport, args: RuntimeArgs, wrote: boolean): void {
  if (args.json) {
    console.log(JSON.stringify({ ...report, wrote }, null, 2));
    return;
  }

  console.log([
    `[llm-recommender-weight-learning] status=${report.status}`,
    `manualPromotionReviewCandidate=${report.manualPromotionReviewCandidate}`,
    `dryRun=${args.dryRun}`,
    `wrote=${wrote}`,
    `eligibleRows=${report.metrics.eligibleRows}`,
  ].join(' '));
}

async function main(): Promise<void> {
  const args = parseLlmRecommenderWeightLearningArgs();
  const { report, exitCode, wrote } = await runLlmRecommenderWeightLearningRuntime({ argv: process.argv.slice(2) });
  printReport(report, args, wrote);
  process.exitCode = exitCode;
}

if (require.main === module) {
  main().catch((error) => {
    const report = {
      ok: false,
      status: 'insufficient_feedback_static_weights',
      source: 'llm_recommender_weight_learning',
      shadowOnly: true,
      liveMutation: false,
      promotionReady: false,
      manualPromotionReviewCandidate: false,
      generatedAt: new Date().toISOString(),
      days: DEFAULT_DAYS,
      minSamples: DEFAULT_MIN_SAMPLES,
      baseWeights: {},
      weights: {},
      deltas: {},
      maxDelta: 0.07,
      metrics: {},
      reasons: [],
      blockers: [error?.message || String(error)],
    };
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
  });
}
