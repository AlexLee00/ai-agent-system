#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { buildGuardrailResult, defineGuardrailCli } from './guardrail-check-common.ts';

export async function runLifecycleCompletionCheck() {
  const coverage = await db.getLifecyclePhaseCoverage({ days: 7 }).catch((error) => ({ error: String(error?.message || error) }));
  if (!Array.isArray(coverage)) {
    return buildGuardrailResult({
      name: 'lifecycle_stage_completion',
      severity: 'high',
      owner: 'luna',
      blockers: ['lifecycle_coverage_unavailable'],
      evidence: { error: coverage?.error || 'unknown' },
    });
  }
  const stageSet = new Set();
  for (const row of coverage || []) {
    for (const phase of row.covered_phases || row.coveredPhases || []) stageSet.add(String(phase));
  }
  return buildGuardrailResult({
    name: 'lifecycle_stage_completion',
    severity: 'high',
    owner: 'luna',
    warnings: coverage.length === 0 ? ['no_lifecycle_events_7d'] : [],
    evidence: {
      scopedPositions7d: coverage.length,
      coveredPhaseCount: stageSet.size,
      coveredPhases: [...stageSet].sort(),
    },
  });
}

defineGuardrailCli(import.meta.url, {
  name: 'lifecycle_stage_completion',
  run: runLifecycleCompletionCheck,
});
