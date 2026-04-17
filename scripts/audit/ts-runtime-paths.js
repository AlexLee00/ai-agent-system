#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const roots = ['bots', 'packages', 'elixir', 'scripts']
  .map((entry) => path.join(repoRoot, entry))
  .filter((entry) => fs.existsSync(entry));

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const SOURCE_BASENAMES = ['', '.legacy'];
const IMPORT_RE = /\b(?:require\(|from\s+|import\()\s*['"]([^'"]+)['"]/g;
const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  '.next',
  '.turbo',
  'venv',
  '.venv',
  'site-packages',
  'archive',
]);

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, files);
      continue;
    }
    if (!/\.(?:[cm]?js|ts|tsx)$/u.test(entry.name)) continue;
    files.push(fullPath);
  }
  return files;
}

function unique(items) {
  return [...new Set(items)];
}

function candidatePaths(specifier, filePath) {
  if (specifier.startsWith('.')) {
    const abs = path.resolve(path.dirname(filePath), specifier);
    const ext = path.extname(abs);
    if (ext) {
      const stem = abs.slice(0, -ext.length);
      return unique([
        abs,
        ...SOURCE_EXTENSIONS.map((candidateExt) => stem + candidateExt),
        ...SOURCE_BASENAMES.flatMap((basename) =>
          SOURCE_EXTENSIONS.map((candidateExt) => `${stem}${basename}${candidateExt}`),
        ),
        path.join(abs, 'index.ts'),
        path.join(abs, 'index.js'),
      ]);
    }

    return unique([
      abs,
      ...SOURCE_EXTENSIONS.map((candidateExt) => abs + candidateExt),
      ...SOURCE_BASENAMES.flatMap((basename) =>
        SOURCE_EXTENSIONS.map((candidateExt) => `${abs}${basename}${candidateExt}`),
      ),
      path.join(abs, 'index.ts'),
      path.join(abs, 'index.js'),
    ]);
  }

  if (specifier.startsWith('packages/') || specifier.startsWith('bots/') || specifier.startsWith('elixir/')) {
    const abs = path.join(repoRoot, specifier);
    const ext = path.extname(abs);
    const stem = ext ? abs.slice(0, -ext.length) : abs;
    return unique([
      abs,
      ...SOURCE_EXTENSIONS.map((candidateExt) => stem + candidateExt),
      ...SOURCE_BASENAMES.flatMap((basename) =>
        SOURCE_EXTENSIONS.map((candidateExt) => `${stem}${basename}${candidateExt}`),
      ),
      path.join(abs, 'index.ts'),
      path.join(abs, 'index.js'),
    ]);
  }

  return [];
}

function isBrokenReference(specifier, filePath) {
  if (!specifier.startsWith('.') && !specifier.startsWith('packages/') && !specifier.startsWith('bots/') && !specifier.startsWith('elixir/')) {
    return null;
  }

  const candidates = candidatePaths(specifier, filePath);
  if (candidates.length === 0) return null;
  const existing = candidates.find((candidate) => fs.existsSync(candidate));
  if (existing) return null;

  return {
    file: path.relative(repoRoot, filePath),
    specifier,
    candidates: candidates
      .slice(0, 6)
      .map((candidate) => path.relative(repoRoot, candidate)),
  };
}

function scanFile(filePath) {
  const rawContent = fs.readFileSync(filePath, 'utf8');
  const content = rawContent
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
  const broken = [];
  for (const match of content.matchAll(IMPORT_RE)) {
    const specifier = match[1];
    const brokenRef = isBrokenReference(specifier, filePath);
    if (brokenRef) broken.push(brokenRef);
  }
  return broken;
}

function main() {
  const files = roots.flatMap((dir) => walk(dir));
  const broken = files.flatMap((filePath) => scanFile(filePath));

  const summary = {
    scannedFiles: files.length,
    brokenCount: broken.length,
    broken,
  };

  console.log(JSON.stringify(summary, null, 2));

  if (broken.length > 0) {
    process.exitCode = 1;
  }
}

main();
