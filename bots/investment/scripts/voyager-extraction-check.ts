#!/usr/bin/env node
// @ts-nocheck

import { runVoyagerSkillAutoExtractionVerify } from './voyager-skill-auto-extraction-verify.ts';
import { buildGuardrailResult, defineGuardrailCli } from './guardrail-check-common.ts';

export async function runVoyagerExtractionCheck() {
  const result = await runVoyagerSkillAutoExtractionVerify({ validationFixture: true }).catch((error) => ({
    ok: false,
    status: 'voyager_verify_failed',
    pendingReason: String(error?.message || error),
  }));
  return buildGuardrailResult({
    name: 'voyager_skill_extraction',
    severity: 'medium',
    owner: 'luna',
    blockers: result.enabled === false ? ['voyager_auto_extraction_disabled'] : [],
    warnings: result.naturalDataReady === true ? [] : [result.pendingReason || 'insufficient_natural_data'],
    evidence: {
      status: result.status,
      reflexionCount: result.reflexionCount || 0,
      minCandidates: result.minCandidates || 5,
      naturalDataReady: result.naturalDataReady === true,
      validationFixture: result.validationFixture || null,
    },
  });
}

defineGuardrailCli(import.meta.url, {
  name: 'voyager_skill_extraction',
  run: runVoyagerExtractionCheck,
});
