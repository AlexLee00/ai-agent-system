#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildParameterGovernanceReport } from '../shared/runtime-parameter-governance.ts';

function renderGroup(label, rows = []) {
  const lines = [`${label} (${rows.length})`];
  for (const row of rows) {
    const range = row.min != null && row.max != null ? ` [${row.min}~${row.max}]` : '';
    lines.push(`- ${row.key}: ${row.current}${range}`);
  }
  return lines.join('\n');
}

export async function buildRuntimeParameterGovernanceReport({ json = false } = {}) {
  const report = buildParameterGovernanceReport();
  if (json) return report;
  return [
    '🧭 Runtime Parameter Governance',
    `allow: ${report.summary.allow}`,
    `escalate: ${report.summary.escalate}`,
    `block: ${report.summary.block}`,
    '',
    renderGroup('ALLOW', report.grouped.allow),
    '',
    renderGroup('ESCALATE', report.grouped.escalate),
    '',
    renderGroup('BLOCK', report.grouped.block),
  ].join('\n');
}

async function main() {
  const json = process.argv.includes('--json');
  const result = await buildRuntimeParameterGovernanceReport({ json });
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-parameter-governance-report 오류:',
  });
}
