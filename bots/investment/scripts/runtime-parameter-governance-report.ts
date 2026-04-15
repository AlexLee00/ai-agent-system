#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildInvestmentCliInsight } from '../shared/cli-insight.ts';
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
  report.aiSummary = await buildInvestmentCliInsight({
    bot: 'runtime-parameter-governance-report',
    requestType: 'runtime-parameter-governance-report',
    title: '투자 runtime parameter governance 리포트 요약',
    data: {
      summary: report.summary,
      grouped: {
        allow: report.grouped.allow.slice(0, 5),
        escalate: report.grouped.escalate.slice(0, 5),
        block: report.grouped.block.slice(0, 5),
      },
    },
    fallback:
      Number(report.summary.block || 0) > 0
        ? `runtime governance는 block ${report.summary.block}개가 있어 자동 조정보다 승인/정책 판단이 필요한 축이 남아 있습니다.`
        : `runtime governance는 allow ${report.summary.allow}, escalate ${report.summary.escalate} 기준으로 현재 운영 경계가 비교적 선명합니다.`,
  });
  if (json) return report;
  return [
    '🧭 Runtime Parameter Governance',
    report.aiSummary ? `🔍 AI: ${report.aiSummary}` : null,
    `allow: ${report.summary.allow}`,
    `escalate: ${report.summary.escalate}`,
    `block: ${report.summary.block}`,
    '',
    renderGroup('ALLOW', report.grouped.allow),
    '',
    renderGroup('ESCALATE', report.grouped.escalate),
    '',
    renderGroup('BLOCK', report.grouped.block),
  ].filter(Boolean).join('\n');
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
