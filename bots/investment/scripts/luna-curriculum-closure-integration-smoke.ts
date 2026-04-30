#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildLunaOperationalClosurePackFromReports } from '../shared/luna-operational-closure-pack.ts';
import { buildLunaFullIntegrationClosureGateFromReports } from './runtime-luna-full-integration-closure-gate.ts';

export async function runLunaCurriculumClosureIntegrationSmoke() {
  const curriculum = {
    status: 'curriculum_bootstrap_plan_ready',
    dryRun: true,
    totalAgents: 19,
    toCreate: 19,
    requiredConfirm: 'luna-curriculum-bootstrap',
  };
  const pack = buildLunaOperationalClosurePackFromReports({
    closure: { ok: true, operationalStatus: 'operational_complete', hardBlockers: [] },
    reconcile: { blockers: [], summary: { total: 0 } },
    busHygiene: { ok: true, before: { staleCount: 0, rows: [] }, action: { dryRun: true } },
    curriculum,
  });
  assert.equal(pack.status, 'operational_warning');
  assert.equal(pack.curriculumTasks.length, 1);
  assert.equal(pack.curriculumTasks[0].toCreate, 19);

  const closure = buildLunaFullIntegrationClosureGateFromReports({
    fullIntegration: { codeComplete: true, passed: true, outstandingTasks: [] },
    reconcile: { blockers: [], summary: { total: 0 } },
    liveFire: { ok: true, blockers: [] },
    sevenDay: { pendingReasons: [] },
    posttrade: { ok: true, blockers: [] },
    memory: { readiness: { blockers: [], warnings: ['curriculum_state_empty'] } },
    busHygiene: { ok: true, before: { staleCount: 0, rows: [] }, action: { dryRun: true } },
    voyager: { naturalDataReady: true },
    curriculum,
  });
  assert.ok(closure.warnings.some((item) => item.includes('curriculum_bootstrap_required')));
  return { ok: true, pack, closure };
}

async function main() {
  const result = await runLunaCurriculumClosureIntegrationSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna curriculum closure integration smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna curriculum closure integration smoke 실패:',
  });
}
