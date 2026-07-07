#!/usr/bin/env node
// @ts-nocheck

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendTransitionTelemetry } from '../shared/transition-telemetry.ts';
import {
  applyPredictionLedgerPlan,
  buildPredictionAccuracy,
  buildPredictionLedgerReport,
  buildPredictionLedgerTransitionPlan,
  fetchPredictionLedgerRows,
  isSigmaPredictionEnabled,
} from '../vault/validation-transition.ts';

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? Math.trunc(parsed) : fallback));
}

export async function buildRuntimeSigmaPredictionLedger(options = {}) {
  const now = options.now || new Date();
  const dryRun = options.dryRun !== false;
  const env = options.env || process.env;
  const rows = options.rows || (options.noDb ? [] : await fetchPredictionLedgerRows({
    limit: options.limit || 500,
    queryReadonly: options.queryReadonly,
  }));
  const plan = buildPredictionLedgerTransitionPlan({ rows, now });
  const applyPlan = plan.filter((item) => item.apply).slice(0, Math.max(1, Math.min(500, Number(options.applyLimit || options.limit || 500) || 500)));
  const shouldApply = options.apply === true && !dryRun;
  const applyResult = shouldApply
    ? await applyPredictionLedgerPlan(applyPlan, { pg: options.pg, env })
    : { applied: [], count: 0, skipped: true, reason: dryRun ? 'dry_run' : 'apply_not_requested' };
  const ledger = buildPredictionLedgerReport({ rows, now });
  const accuracy = buildPredictionAccuracy({ rows });
  const counts = {
    ...ledger.counts,
    forwardToDueCandidates: plan.filter((item) => item.reason === 'prediction_horizon_due' && item.apply).length,
    dueToResolvedCandidates: plan.filter((item) => /^prediction_(hit|miss)$/.test(item.reason) && item.apply).length,
    unresolvedDue: plan.filter((item) => item.reason === 'validation_unresolved').length,
    applicable: applyPlan.length,
    applied: applyResult.count || 0,
  };
  const report = {
    ok: true,
    source: 'sigma_prediction_ledger',
    generatedAt: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    dryRun,
    liveMutation: Boolean(applyResult.count > 0),
    predictionEnabled: isSigmaPredictionEnabled(env),
    rowCount: rows.length,
    counts,
    accuracy,
    plan,
    applyResult,
    safety: {
      teamDbReadOnly: true,
      sigmaWriteRequiresEnvAndApply: true,
      newTables: 0,
      launchctlImpact: false,
      ddlApply: false,
    },
  };
  appendTransitionTelemetry({
    type: 'sigma_prediction_ledger',
    dryRun,
    predictionEnabled: report.predictionEnabled,
    counts,
    accuracy: accuracy.overall,
  }, { path: options.telemetryPath, env });
  return report;
}

async function main() {
  const result = await buildRuntimeSigmaPredictionLedger({
    limit: boundedInt(argValue('limit', '500'), 500, 1, 2000),
    applyLimit: boundedInt(argValue('apply-limit', argValue('limit', '500')), 500, 1, 500),
    dryRun: !hasFlag('apply') || hasFlag('dry-run'),
    apply: hasFlag('apply'),
    noDb: hasFlag('no-db'),
    telemetryPath: argValue('telemetry-path', null),
  });
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`[sigma-prediction-ledger] forward_due=${result.counts.forwardToDueCandidates} due_resolved=${result.counts.dueToResolvedCandidates} applied=${result.counts.applied} dryRun=${result.dryRun}`);
  }
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }, null, 2));
    process.exitCode = 1;
  });
}

export default {
  buildRuntimeSigmaPredictionLedger,
};
