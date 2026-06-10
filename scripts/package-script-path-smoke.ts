#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const scriptFilePattern = /\.(?:[cm]?js|tsx?|py|sh|mjs|cjs)$/;

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function listPackageJsons(): string[] {
  const candidates = ['package.json'];
  for (const workspaceRoot of ['bots', 'packages']) {
    const abs = path.join(repoRoot, workspaceRoot);
    if (!fs.existsSync(abs)) continue;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkg = path.join(workspaceRoot, entry.name, 'package.json');
      if (fs.existsSync(path.join(repoRoot, pkg))) candidates.push(pkg);
    }
  }
  return candidates;
}

function tokenize(script: string): string[] {
  return script.match(/"[^"]+"|'[^']+'|\S+/g)?.map((token) => token.replace(/^['"]|['"]$/g, '')) || [];
}

function shouldCheckToken(tokens: string[], index: number): boolean {
  const token = tokens[index];
  if (!scriptFilePattern.test(token)) return false;
  if (token.includes('$') || token.includes('*') || token.startsWith('-')) return false;
  const prev = tokens[index - 1] || '';
  return prev !== '-e' && prev !== '-c';
}

const missing: string[] = [];

for (const pkgRel of listPackageJsons()) {
  const pkgAbs = path.join(repoRoot, pkgRel);
  const pkgDir = path.dirname(pkgAbs);
  const pkg = readJson(pkgAbs);
  for (const [scriptName, command] of Object.entries<string>(pkg.scripts || {})) {
    const tokens = tokenize(command);
    for (let i = 0; i < tokens.length; i += 1) {
      if (!shouldCheckToken(tokens, i)) continue;
      const target = path.resolve(pkgDir, tokens[i]);
      if (!fs.existsSync(target)) missing.push(`${pkgRel} :: ${scriptName} -> ${tokens[i]}`);
    }
  }
}

assert.deepEqual(missing, [], `package scripts reference missing files:\n${missing.join('\n')}`);
console.log('package_script_path_smoke_ok');
