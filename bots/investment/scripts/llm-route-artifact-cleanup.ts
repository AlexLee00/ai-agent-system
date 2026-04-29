#!/usr/bin/env node
// @ts-nocheck

import {
  countHubDisabledSmokeArtifacts,
  deleteHubDisabledSmokeArtifacts,
  listHubDisabledSmokeArtifacts,
} from '../shared/db/llm-routing.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const REQUIRED_CONFIRM = 'cleanup-llm-route-artifacts';

function parseArgs(argv = process.argv.slice(2)) {
  const limitRaw = argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1];
  return {
    json: argv.includes('--json'),
    apply: argv.includes('--apply'),
    confirm: argv.find((arg) => arg.startsWith('--confirm='))?.split('=')[1] || null,
    limit: Math.min(500, Math.max(1, Number(limitRaw || 50) || 50)),
  };
}

export async function buildLlmRouteArtifactCleanupPlan({ limit = 50 } = {}) {
  const rows = await listHubDisabledSmokeArtifacts({ limit }).catch(() => []);
  const artifactCount = await countHubDisabledSmokeArtifacts().catch(() => 0);
  return {
    ok: true,
    status: artifactCount > 0 ? 'llm_route_artifacts_found' : 'llm_route_artifacts_clear',
    generatedAt: new Date().toISOString(),
    artifactCount,
    sample: rows,
    requiredConfirm: REQUIRED_CONFIRM,
  };
}

export async function runLlmRouteArtifactCleanup({
  apply = false,
  confirm = null,
  limit = 50,
} = {}) {
  const plan = await buildLlmRouteArtifactCleanupPlan({ limit });
  if (!apply) {
    return {
      ...plan,
      dryRun: true,
      applied: false,
      deleted: 0,
      nextAction: plan.artifactCount > 0 ? `rerun_with_--apply_--confirm=${REQUIRED_CONFIRM}` : 'no_cleanup_needed',
    };
  }
  if (confirm !== REQUIRED_CONFIRM) {
    return {
      ...plan,
      ok: false,
      dryRun: false,
      applied: false,
      deleted: 0,
      error: `confirmation_required:${REQUIRED_CONFIRM}`,
    };
  }
  const result = await deleteHubDisabledSmokeArtifacts();
  return {
    ...plan,
    ok: true,
    status: 'llm_route_artifacts_deleted',
    dryRun: false,
    applied: true,
    deleted: Number(result?.rowCount || 0),
    nextAction: 'rerun_route_quality_report',
  };
}

async function main() {
  const args = parseArgs();
  const report = await runLlmRouteArtifactCleanup(args);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(`${report.status} dryRun=${report.dryRun} artifacts=${report.artifactCount} deleted=${report.deleted || 0}`);
  return report;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ llm-route-artifact-cleanup 실패:',
  });
}
