#!/usr/bin/env node
// @ts-nocheck

import { buildGuardrailResult, defineGuardrailCli, runProcess } from './guardrail-check-common.ts';

export async function runElixirSupervisorHealth() {
  const label = 'ai.elixir.supervisor';
  const result = await runProcess('launchctl', ['list'], { timeoutMs: 5000 });
  const loaded = result.ok && String(result.stdout || '').includes(label);
  return buildGuardrailResult({
    name: 'elixir_supervisor_health',
    severity: 'critical',
    owner: 'system',
    blockers: loaded ? [] : [`launchd_label_not_loaded:${label}`],
    evidence: {
      label,
      loaded,
      launchctlExitCode: result.exitCode,
      stdoutPreview: String(result.stdout || '').split('\n').filter((line) => line.includes(label)).join('\n'),
      stderrPreview: String(result.stderr || '').slice(0, 500),
    },
  });
}

defineGuardrailCli(import.meta.url, {
  name: 'elixir_supervisor_health',
  run: runElixirSupervisorHealth,
});
