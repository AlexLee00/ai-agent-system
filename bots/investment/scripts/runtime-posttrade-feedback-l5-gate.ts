#!/usr/bin/env node
// @ts-nocheck

import { buildPosttradeFeedbackDoctor } from './runtime-posttrade-feedback-doctor.ts';
import { runPosttradeFeedbackReadiness } from './runtime-posttrade-feedback-readiness.ts';
import { buildPosttradeFeedbackActionAudit } from './runtime-posttrade-feedback-action-audit.ts';
import { buildPosttradeFeedbackActionStaging } from './runtime-posttrade-feedback-action-staging.ts';
import { mirrorExistingPosttradeSkills } from '../shared/posttrade-skill-extractor.ts';
import { loadLunaConstitution } from '../shared/luna-constitution.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function parseArgs(argv = process.argv.slice(2)) {
  return {
    json: argv.includes('--json'),
    strict: argv.includes('--strict'),
  };
}

export async function buildPosttradeFeedbackL5Gate({ strict = false } = {}) {
  const [doctor, readiness, actionAudit, actionStaging, skillMirror] = await Promise.all([
    buildPosttradeFeedbackDoctor({ strict: false }),
    runPosttradeFeedbackReadiness({ limit: 3 }),
    buildPosttradeFeedbackActionAudit({ days: 30, strict: false }),
    buildPosttradeFeedbackActionStaging({ days: 30, limit: 100 }).catch((error) => ({
      ok: false,
      error: String(error?.message || error || 'unknown'),
    })),
    mirrorExistingPosttradeSkills({ market: 'all', limit: 50, dryRun: true }).catch((error) => ({
      ok: false,
      error: String(error?.message || error || 'unknown'),
    })),
  ]);
  const constitution = loadLunaConstitution();
  const blockers = [];

  if (doctor?.ok !== true) blockers.push('doctor_failed');
  if (readiness?.ok !== true || (readiness?.blockers || []).length > 0) blockers.push('readiness_blocked');
  if (actionAudit?.ok !== true) blockers.push('feedback_action_audit_missing');
  if (actionStaging?.ok !== true) blockers.push('feedback_action_staging_unavailable');
  if (strict && Number(actionStaging?.rejectedCount || 0) > 0) blockers.push('feedback_action_staging_rejections_present');
  if (skillMirror?.ok !== true) blockers.push('skill_mirror_unavailable');
  if (constitution?.ok !== true || Number(constitution.ruleCount || 0) < 8) blockers.push('constitution_missing_or_incomplete');

  const warningCount = (doctor?.warnings || []).length;
  if (strict && warningCount > 0) blockers.push('doctor_warnings_present');

  return {
    ok: blockers.length === 0,
    strict,
    status: blockers.length === 0 ? 'posttrade_l5_gate_clear' : 'posttrade_l5_gate_blocked',
    blockers,
    doctor: {
      ok: doctor?.ok === true,
      failures: doctor?.failures || [],
      warnings: doctor?.warnings || [],
    },
    readiness: {
      ok: readiness?.ok === true,
      blockers: readiness?.blockers || [],
      nextAction: readiness?.nextAction || null,
    },
    actionAudit: {
      ok: actionAudit?.ok === true,
      expectedMappings: actionAudit?.expectedMappings || 0,
      missingMappings: actionAudit?.missingMappings || [],
    },
    actionStaging: {
      ok: actionStaging?.ok === true,
      patchCount: actionStaging?.patchCount || 0,
      rejectedCount: actionStaging?.rejectedCount || 0,
      requiresApproval: actionStaging?.requiresApproval === true,
    },
    skillMirror: {
      ok: skillMirror?.ok === true,
      checked: skillMirror?.checked || 0,
      dryRun: skillMirror?.dryRun === true,
    },
    constitution: {
      ok: constitution?.ok === true,
      ruleCount: constitution?.ruleCount || 0,
      path: constitution?.path || null,
    },
  };
}

async function main() {
  const args = parseArgs();
  const result = await buildPosttradeFeedbackL5Gate(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`${result.status} — blockers=${result.blockers.join(',') || 'none'}`);
  if (result.ok !== true) throw new Error(result.status);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-posttrade-feedback-l5-gate 실패:',
  });
}
