#!/usr/bin/env tsx
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const REQUIRED_FIELDS = ['alarmType', 'visibility', 'eventType', 'incidentKey'];
const IGNORE_FILES = new Set([
  'packages/core/lib/hub-alarm-client.ts',
]);

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function findPostAlarmFilesViaRg(): string[] | null {
  const result = spawnSync('rg', [
    '-l',
    'postAlarm\\s*\\(',
    '-g',
    '!**/node_modules/**',
    '-g',
    '!**/.git/**',
    '-g',
    '!**/dist/**',
    'bots',
    'packages',
    'scripts',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || (result.status === null && !String(result.stdout || '').trim())) return null;
  return String(result.stdout || '').trim().split('\n').filter(Boolean);
}

function findPostAlarmFilesViaGrep(): string[] {
  const searchDirs = ['bots', 'packages', 'scripts'];
  const result = spawnSync('grep', [
    '-rl',
    '--include=*.ts',
    '--include=*.js',
    '--exclude-dir=node_modules',
    '--exclude-dir=.git',
    '--exclude-dir=dist',
    'postAlarm',
    ...searchDirs,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0 && !String(result.stdout || '').trim()) return [];
  return String(result.stdout || '').trim().split('\n').filter(Boolean);
}

function findPostAlarmFiles(): string[] {
  const rgResult = findPostAlarmFilesViaRg();
  if (rgResult !== null) return rgResult;
  return findPostAlarmFilesViaGrep();
}

function isAuditTarget(file: string): boolean {
  if (IGNORE_FILES.has(file)) return false;
  if (/(^|\/)(__tests__|docs|context)\//.test(file)) return false;
  if (/(\.md|\.markdown)$/.test(file)) return false;
  if (/(smoke|test|fixture)\.(t|j)s$/.test(file)) return false;
  return true;
}

function extractCallSnippet(text: string, startIndex: number): string {
  let depth = 0;
  let started = false;
  for (let i = startIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(') {
      depth += 1;
      started = true;
    } else if (ch === ')') {
      depth -= 1;
      if (started && depth <= 0) return text.slice(startIndex, i + 1);
    }
    if (i - startIndex > 2400) break;
  }
  return text.slice(startIndex, startIndex + 2400);
}

function isLikelyCommentedOut(text: string, startIndex: number): boolean {
  const lineStart = text.lastIndexOf('\n', startIndex) + 1;
  const prefix = text.slice(lineStart, startIndex);
  return /\/\/|\/\*/.test(prefix) || /^\s*\*/.test(prefix);
}

function lineNumber(text: string, index: number): number {
  return text.slice(0, index).split(/\r?\n/).length;
}

function auditFile(file: string) {
  const text = fs.readFileSync(path.join(repoRoot, file), 'utf8');
  const rows = [];
  const pattern = /postAlarm\s*\(/g;
  let match;
  while ((match = pattern.exec(text))) {
    if (isLikelyCommentedOut(text, match.index)) continue;
    const snippet = extractCallSnippet(text, match.index);
    const missing = REQUIRED_FIELDS.filter((field) => !new RegExp(`\\b${field}\\s*:`).test(snippet));
    const hasMessageObject = /\bmessage\s*:/.test(snippet) || /[{,]\s*message\s*[,}]/.test(snippet);
    const hasMessageFirstArg = /^postAlarm\s*\(\s*[^,{][\s\S]*?,\s*\{/.test(snippet);
    const hasTeamContext = /\bteam\s*:/.test(snippet) || /[{,]\s*team\s*[,}]/.test(snippet);
    const hasProducerContext = /\b(fromBot|bot)\s*:/.test(snippet) || /[{,]\s*(fromBot|bot)\s*[,}]/.test(snippet);
    const hasSeverityContext = /\b(alertLevel|level|severity)\s*:/.test(snippet) || /[{,]\s*(alertLevel|level|severity)\s*[,}]/.test(snippet);
    const runtimeCovered = (hasMessageObject || hasMessageFirstArg)
      && (hasTeamContext || hasProducerContext || hasSeverityContext);
    const explicitComplete = missing.length === 0;
    const unsafe = !explicitComplete && !runtimeCovered;
    rows.push({
      file,
      line: lineNumber(text, match.index),
      missing,
      runtime_covered: runtimeCovered,
      explicit_complete: explicitComplete,
      unsafe,
      preview: snippet.replace(/\s+/g, ' ').slice(0, 220),
    });
  }
  return rows;
}

export function buildAlarmContractAudit() {
  const files = findPostAlarmFiles().filter(isAuditTarget);
  const calls = files.flatMap(auditFile);
  const findings = calls.filter((row: any) => row.unsafe);
  const byMissing = calls.reduce((acc: Record<string, number>, row: any) => {
    for (const key of row.missing) acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  return {
    ok: findings.length === 0,
    checked_files: files.length,
    checked_calls: calls.length,
    findings_count: findings.length,
    runtime_covered_count: calls.filter((row: any) => row.runtime_covered).length,
    explicit_complete_count: calls.filter((row: any) => row.explicit_complete).length,
    legacy_backlog_count: calls.filter((row: any) => !row.explicit_complete && row.runtime_covered).length,
    missing_field_counts: byMissing,
    findings: findings.slice(0, 200),
    legacy_backlog: calls
      .filter((row: any) => !row.explicit_complete && row.runtime_covered)
      .slice(0, 200),
  };
}

function main() {
  const result = buildAlarmContractAudit();
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`alarm_contract_audit: ${result.findings_count} findings across ${result.checked_files} files`);
    for (const finding of result.findings.slice(0, 20)) {
      console.log(`- ${finding.file}:${finding.line} missing=${finding.missing.join(',')}`);
    }
  }
  if (hasFlag('strict') && !result.ok) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  buildAlarmContractAudit,
};
