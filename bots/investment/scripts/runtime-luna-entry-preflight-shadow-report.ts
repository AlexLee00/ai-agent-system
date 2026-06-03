#!/usr/bin/env node
// @ts-nocheck

import { loadEntryPreflightShadowReport } from '../shared/entry-materialize-preflight.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function buildTextReport(report = {}) {
  const summary = report.summary || {};
  const lines = [];
  lines.push('S2 C3 entry preflight SHADOW report');
  lines.push(`days=${report.days}`);
  lines.push(`total=${summary.total || 0} linked=${summary.linked || 0}`);
  lines.push(`predicted_block=${summary.predicted_block || 0} actual_block=${summary.actual_block || 0}`);
  lines.push(`agreement=${summary.agreement || 0} agreement_pct=${summary.agreement_pct ?? null}`);
  lines.push(`missed_block=${summary.missed_block || 0} over_block=${summary.over_block || 0}`);
  lines.push('');
  lines.push('by decision:');
  for (const row of report.byDecision || []) {
    lines.push(`- ${row.preflight_decision}: ${row.count}`);
  }
  return lines.join('\n');
}

export async function main() {
  const json = hasFlag('json');
  const days = num(argValue('days', process.env.ENTRY_PREFLIGHT_SHADOW_REPORT_DAYS || 14), 14);
  const limit = num(argValue('limit', 50), 50);
  const report = await loadEntryPreflightShadowReport({ days, limit });
  if (json) {
    console.log(JSON.stringify({ ok: true, ...report }, null, 2));
    return report;
  }
  console.log(buildTextReport(report));
  return report;
}

if (isDirectExecution(import.meta.url)) {
  runCliMain({ run: main });
}

export default main;
