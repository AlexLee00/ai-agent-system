#!/usr/bin/env tsx
// @ts-nocheck

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const retiredAbsoluteRoot = ['', 'Users', 'alexlee', 'projects', 'ai-agent-system'].join('/');
const scanTargets = [
  path.join(repoRoot, 'bots', 'hub', 'lib'),
  path.join(repoRoot, 'bots', 'hub', 'src'),
  path.join(repoRoot, 'bots', 'hub', 'scripts', 'local-llm-policy-report.ts'),
  path.join(repoRoot, 'bots', 'hub', 'scripts', 'llm-oauth4-master-review.ts'),
  path.join(repoRoot, 'packages', 'core', 'lib', 'hub-client.ts'),
];

function walk(target) {
  if (!fs.existsSync(target)) return [];
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  const files = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.git')) continue;
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile() && /\.(ts|tsx|js|mjs|cjs|json)$/.test(entry.name)) files.push(full);
  }
  return files;
}

const offenders = [];
for (const file of scanTargets.flatMap(walk)) {
  const relative = path.relative(repoRoot, file);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    if (line.includes(retiredAbsoluteRoot)) {
      offenders.push({ file: relative, line: index + 1, text: line.trim() });
    }
  });
}

if (offenders.length > 0) {
  console.error(JSON.stringify({ ok: false, offenders }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  scanned_targets: scanTargets.map((target) => path.relative(repoRoot, target)),
  retired_absolute_root_absent: true,
}, null, 2));
