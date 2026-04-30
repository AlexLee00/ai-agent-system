#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { createGuardrailRegistry, runRegisteredGuardrails } from '../shared/guardrail-registry.ts';

const OUT_DIR = path.resolve('output/guardrails');

export async function runGuardrailsHourly({ dryRun = true, write = true, category = null } = {}) {
  const registry = createGuardrailRegistry();
  const entries = registry.list(category);
  const result = await runRegisteredGuardrails({ category, dryRun });
  const byCategory = {};
  for (const entry of entries) {
    byCategory[entry.category] = (byCategory[entry.category] || 0) + 1;
  }
  const report = {
    ok: result.ok,
    generatedAt: new Date().toISOString(),
    dryRun,
    total: result.total,
    passed: result.passed,
    byCategory,
    criticalFailures: result.results.filter((item) => !item.ok && item.severity === 'critical'),
    warningCount: result.results.filter((item) => !item.ok && item.severity !== 'critical').length,
  };
  if (write) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const stamp = report.generatedAt.slice(0, 10);
    fs.writeFileSync(path.join(OUT_DIR, `luna-guardrail-report-${stamp}.json`), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, 'luna-guardrail-dashboard.html'), renderGuardrailHtml(report));
  }
  return report;
}

function renderGuardrailHtml(report) {
  const rows = Object.entries(report.byCategory)
    .map(([category, count]) => `<tr><td>${category}</td><td>${count}</td></tr>`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Luna Guardrails</title></head><body><h1>Luna Guardrails</h1><p>ok=${report.ok} dryRun=${report.dryRun} total=${report.total}</p><table><tbody>${rows}</tbody></table></body></html>`;
}

async function main() {
  const result = await runGuardrailsHourly({
    dryRun: !process.argv.includes('--execute'),
    write: !process.argv.includes('--no-write'),
  });
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`runtime-luna-guardrails-hourly ok=${result.ok} total=${result.total}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ runtime-luna-guardrails-hourly 실패:' });
}
