#!/usr/bin/env node
'use strict';

const { parseArgs, collectJayUsage } = require('./lib/jay-usage');

function fmt(n) {
  return Number(n || 0).toLocaleString();
}

function main() {
  const { days, json } = parseArgs();
  const report = collectJayUsage({ days });

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const lines = [];
  lines.push(`📊 제이 LLM 사용량 리포트 (${days}일)`);
  lines.push('');
  lines.push(`총 호출: ${fmt(report.total.calls)}회`);
  lines.push(`총 토큰: ${fmt(report.total.totalTokens)}`);
  lines.push(`입력: ${fmt(report.total.input)} / 출력: ${fmt(report.total.output)}`);
  lines.push(`캐시 읽기: ${fmt(report.total.cacheRead)} / 캐시 쓰기: ${fmt(report.total.cacheWrite)}`);

  const modelRows = Object.values(report.byModel)
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 8);

  if (modelRows.length) {
    lines.push('');
    lines.push('모델별:');
    for (const row of modelRows) {
      lines.push(`- ${row.provider}/${row.model}: ${fmt(row.totalTokens)} tok (${fmt(row.calls)}회)`);
    }
  }

  const dateRows = Object.entries(report.byDate)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, days);

  if (dateRows.length) {
    lines.push('');
    lines.push('일별:');
    for (const [date, row] of dateRows) {
      lines.push(`- ${date}: ${fmt(row.totalTokens)} tok (${fmt(row.calls)}회)`);
    }
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

main();
