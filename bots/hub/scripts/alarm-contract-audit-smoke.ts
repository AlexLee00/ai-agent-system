#!/usr/bin/env tsx
'use strict';

const { buildAlarmContractAudit } = require('./alarm-contract-audit.ts');

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function main(): void {
  const result = buildAlarmContractAudit();
  assert(Number(result.checked_files) > 0, 'expected alarm contract audit to scan files');
  assert(result.missing_field_counts && typeof result.missing_field_counts === 'object', 'expected missing field summary');
  assert(Array.isArray(result.findings), 'expected findings array');
  assert(result.ok === true, `expected runtime-covered alarm contract audit, findings=${result.findings_count}`);
  console.log(JSON.stringify({
    ok: true,
    checked_files: result.checked_files,
    checked_calls: result.checked_calls,
    findings_count: result.findings_count,
    runtime_covered_count: result.runtime_covered_count,
    strict_ready: result.ok,
  }));
}

main();
