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

function countParams(params = '') {
  const trimmed = String(params || '').trim();
  if (!trimmed) return 0;
  return trimmed.split(',').filter(Boolean).length;
}

function auditFunctions(path) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const findings = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/);
    if (!match) continue;
    const name = match[1];
    const paramCount = countParams(match[2]);
    let depth = 0;
    let end = i;
    for (let j = i; j < lines.length; j++) {
      depth += (lines[j].match(/{/g) || []).length;
      depth -= (lines[j].match(/}/g) || []).length;
      if (j > i && depth <= 0) {
        end = j;
        break;
      }
    }
    const lineCount = Math.max(1, end - i + 1);
    if (lineCount > 50) findings.push({ type: 'long_function', name, start: i + 1, lines: lineCount });
    if (paramCount > 5) findings.push({ type: 'many_parameters', name, start: i + 1, parameters: paramCount });
  }
  return findings;
}

export function runFunctionAudit() {
  const files = TARGET_DIRS.flatMap((dir) => walk(join(ROOT, dir)));
  const findings = [];
  for (const file of files) {
    findings.push(...auditFunctions(file).map((finding) => ({ file: relative(ROOT, file), ...finding })));
  }
  return {
    ok: true,
    mode: 'advisory',
    scannedFiles: files.length,
    findingCount: findings.length,
    topFindings: findings.sort((a, b) => Number(b.lines || b.parameters || 0) - Number(a.lines || a.parameters || 0)).slice(0, 50),
    note: 'Wave 2 function audit is advisory and intentionally non-blocking.',
  };
}

async function main() {
  const result = runFunctionAudit();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`refactor-function-audit scanned=${result.scannedFiles} findings=${result.findingCount}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ refactor-function-audit 실패:' });
}
