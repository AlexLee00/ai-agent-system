#!/usr/bin/env tsx
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.LLM_TEAM_SELECTOR_VERSION = 'v3.0_oauth_4';
process.env.LLM_TEAM_SELECTOR_AB_PERCENT = '100';
process.env.HUB_BUDGET_GUARDIAN_ENABLED = 'false';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const selector = require('../../../packages/core/lib/llm-model-selector.ts');

const GEMINI_DIAGNOSTIC_SELECTORS = new Set([
  'hub.gemini.cli.adapter.smoke',
  'hub.gemini.cli.readiness.live',
  'hub.unified.oauth.gemini.smoke',
]);

const OPERATIONAL_SOURCE_PATHS = [
  'bots/edu-x/SPEC.md',
  'bots/edu-x/lib',
  'bots/edu-x/scripts',
  'bots/blog/api',
  'bots/blog/lib',
  'bots/blog/config.json',
  'bots/orchestrator/lib',
  'bots/orchestrator/src',
  'bots/orchestrator/config.json',
  'bots/claude/config.json',
  'bots/claude/lib/archer/config.ts',
  'packages/core/lib/chunked-llm.ts',
];

const SCANNED_OUTPUT_DIRS = [
  'bots/edu-x/output',
];

function isGeminiEntry(entry: any): boolean {
  const provider = String(entry?.provider || '').trim().toLowerCase();
  const model = String(entry?.model || '').trim().toLowerCase();
  return provider.includes('gemini')
    || model.startsWith('gemini-')
    || model.startsWith('gemini/')
    || model.startsWith('gemini-oauth/')
    || model.startsWith('gemini-cli-oauth/')
    || model.startsWith('gemini-codeassist-oauth/')
    || model.startsWith('google-gemini-cli/');
}

const SCANNED_EXT_RE = /\.(ts|tsx|js|mjs|cjs|json|md|html|txt)$/i;

function collectFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath));
      continue;
    }
    if (SCANNED_EXT_RE.test(entry.name)) files.push(fullPath);
  }
  return files;
}

function collectPath(inputPath: string): string[] {
  if (!fs.existsSync(inputPath)) return [];
  const stats = fs.statSync(inputPath);
  if (stats.isDirectory()) return collectFiles(inputPath);
  return SCANNED_EXT_RE.test(inputPath) ? [inputPath] : [];
}

function relativePath(filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join('/');
}

const selectorFindings: Array<{ key: string; routes: string[] }> = [];
for (const key of selector.listLLMSelectorKeys()) {
  const description = selector.describeLLMSelector(key, {
    selectorVersion: 'v3.0_oauth_4',
    rolloutPercent: 100,
    rolloutKey: `gemini-residue-audit:${key}`,
  });
  const chain = Array.isArray(description?.chain) ? description.chain : [];
  const geminiRoutes = chain
    .filter(isGeminiEntry)
    .map((entry: any) => `${entry.provider}/${entry.model}`);
  if (GEMINI_DIAGNOSTIC_SELECTORS.has(key)) continue;
  if (geminiRoutes.length > 0) selectorFindings.push({ key, routes: geminiRoutes });
}

const filesToScan = [
  ...OPERATIONAL_SOURCE_PATHS.flatMap((file) => collectPath(path.join(repoRoot, file))),
  ...SCANNED_OUTPUT_DIRS.flatMap((dir) => collectFiles(path.join(repoRoot, dir))),
];

const residueFiles = filesToScan
  .filter((filePath, index, list) => list.indexOf(filePath) === index)
  .filter((filePath) => fs.existsSync(filePath))
  .filter((filePath) => /gemini/i.test(fs.readFileSync(filePath, 'utf8')))
  .map(relativePath);

assert.deepEqual(selectorFindings, [], 'non-diagnostic selector chains must not route to Gemini');
assert.deepEqual(residueFiles, [], 'operational posting/team source files must not contain Gemini residue');

console.log(JSON.stringify({
  ok: true,
  selector_keys_checked: selector.listLLMSelectorKeys().length,
  diagnostic_selectors_allowlisted: [...GEMINI_DIAGNOSTIC_SELECTORS],
  operational_files_checked: filesToScan.length,
  scanned_output_dirs: SCANNED_OUTPUT_DIRS,
}, null, 2));
