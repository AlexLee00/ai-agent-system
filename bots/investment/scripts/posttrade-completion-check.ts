#!/usr/bin/env node
// @ts-nocheck

import { buildPosttradeFeedbackL5Gate } from './runtime-posttrade-feedback-l5-gate.ts';
import { buildGuardrailResult, defineGuardrailCli } from './guardrail-check-common.ts';

export async function runPosttradeCompletionCheck() {
  const gate = await buildPosttradeFeedbackL5Gate({ strict: false }).catch((error) => ({
    ok: false,
    blockers: ['posttrade_gate_unavailable'],
    error: String(error?.message || error),
  }));
  return buildGuardrailResult({
    name: 'posttrade_evaluation_completion',
    severity: 'high',
    owner: 'chronos',
    blockers: gate.ok === true ? [] : (gate.blockers?.length ? gate.blockers : ['posttrade_l5_gate_blocked']),
    warnings: gate.ok === true && gate.status !== 'posttrade_l5_gate_clear' ? [gate.status] : [],
    evidence: {
      status: gate.status || null,
      readiness: gate.readiness || null,
      actionAudit: gate.actionAudit || null,
      actionStaging: gate.actionStaging || null,
    },
  });
}

defineGuardrailCli(import.meta.url, {
  name: 'posttrade_evaluation_completion',
  run: runPosttradeCompletionCheck,
});
