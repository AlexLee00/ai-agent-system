#!/usr/bin/env node
// @ts-nocheck
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const TARGET_DIRS = ['shared', 'team'];
const EXCLUDE = new Set(['node_modules', 'output', 'dist', 'build']);

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    if (EXCLUDE.has(entry)) continue;
    const path = join(dir, entry);
    const st = statSync(path);
    if (st.isDirectory()) files.push(...walk(path));
    else if (/\.(ts|js)$/.test(entry)) files.push(path);
  }
  return files;
}

function auditFile(path) {
  const text = readFileSync(path, 'utf8');
  const lines = text.split(/\r?\n/);
  const findings = [];
  lines.forEach((line, index) => {
    const fn = line.match(/\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/);
    if (fn) {
      const name = fn[1];
      const words = name.split(/(?=[A-Z])|_/).filter(Boolean);
      if (words.length >= 5) findings.push({ type: 'long_function_name', name, line: index + 1 });
      if (!/^(build|calc|calculate|fetch|get|load|list|validate|normalize|resolve|run|process|create|update|insert|delete|sync|persist|classify|score|select|parse|format|ensure|apply|should|is|has|to|from)/.test(name)) {
        findings.push({ type: 'function_should_start_with_verb', name, line: index + 1 });
      }
    }
    const snake = line.match(/\b(?:const|let|var)\s+([a-z][a-z0-9]*_[a-z0-9_]+)/);
    if (snake) findings.push({ type: 'snake_case_variable', name: snake[1], line: index + 1 });
  });
  return findings;
}

export function runNamingAudit() {
  const files = TARGET_DIRS.flatMap((dir) => walk(join(ROOT, dir)));
  const findings = [];
  for (const file of files) {
    const fileFindings = auditFile(file).map((finding) => ({ file: relative(ROOT, file), ...finding }));
    findings.push(...fileFindings);
  }
  return {
    ok: true,
    mode: 'advisory',
    scannedFiles: files.length,
    findingCount: findings.length,
    topFindings: findings.slice(0, 50),
    note: 'Wave 2 naming audit is advisory; behavior-preserving refactors should be applied manually by target module.',
  };
}

async function main() {
  const result = runNamingAudit();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`refactor-naming-audit scanned=${result.scannedFiles} findings=${result.findingCount}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ refactor-naming-audit 실패:' });
}
