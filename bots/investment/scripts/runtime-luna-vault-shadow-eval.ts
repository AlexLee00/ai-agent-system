#!/usr/bin/env node
// @ts-nocheck

import {
  buildVaultShadowEvalReport,
  evaluateVaultShadowOutcomes,
} from '../shared/luna-vault-shadow-eval.ts';

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function argValue(name: string, fallback: string | null = null): string | null {
  const args = process.argv.slice(2);
  const prefix = `--${name}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  if (found) return found.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  if (index >= 0) {
    const value = args[index + 1];
    if (value && !value.startsWith('--')) return value;
  }
  return fallback;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  const safeValue = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, safeValue));
}

async function main() {
  const json = hasFlag('json');
  const evaluate = hasFlag('evaluate') || hasFlag('write');
  const reportOnly = hasFlag('report-only') || hasFlag('report');
  const windowDays = boundedNumber(argValue('window-days', '14'), 14, 1, 90);
  const limit = boundedNumber(argValue('limit', '200'), 200, 1, 1000);

  const evaluation = reportOnly
    ? null
    : await evaluateVaultShadowOutcomes({ windowDays, limit, write: evaluate });
  const report = await buildVaultShadowEvalReport({ limit: 500 });
  const result = {
    ok: true,
    mode: reportOnly ? 'report_only' : evaluate ? 'evaluate_write' : 'evaluate_dry_run',
    evaluation,
    report,
    safety: {
      writesOnlyWhenEvaluateFlag: true,
      writeTableOnly: evaluate ? 'investment.luna_vault_shadow_eval' : null,
      liveTradeImpact: false,
      curriculumImpact: false,
    },
    generatedAt: new Date().toISOString(),
  };

  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    const e = evaluation;
    console.log(`[luna-vault-shadow-eval] mode=${result.mode} evaluated=${e?.evaluatedRows ?? 0} scored=${e?.scoredRows ?? 0} base=${report.overall.baseHitRate} vault=${report.overall.vaultHitRate} lift=${report.overall.lift}`);
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
  process.exitCode = 1;
});
