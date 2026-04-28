#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildRuntimeConfigSuggestionsReport } from './runtime-config-suggestions.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INVESTMENT_DIR = path.resolve(__dirname, '..');
const DEFAULT_OUTPUT = path.join(INVESTMENT_DIR, 'output', 'ops', 'luna-reflection-config-patch.json');

function parseArgs(argv = process.argv.slice(2)) {
  const args = { json: false, write: false, days: 14, output: DEFAULT_OUTPUT };
  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw === '--write') args.write = true;
    else if (raw.startsWith('--days=')) args.days = Math.max(1, Number(raw.split('=').slice(1).join('=') || 14));
    else if (raw.startsWith('--output=')) args.output = raw.split('=').slice(1).join('=') || DEFAULT_OUTPUT;
  }
  return args;
}

function sourceFromKey(key = '') {
  const prefix = 'runtime_config.luna.discoverySourceFeedback.';
  if (!String(key).startsWith(prefix)) return null;
  return String(key).slice(prefix.length).trim() || null;
}

export function buildReflectionConfigPatchFromSuggestions(suggestions = [], { checkedAt = new Date().toISOString() } = {}) {
  const relevant = (suggestions || []).filter((item) => sourceFromKey(item.key));
  const operations = relevant.map((item) => {
    const source = sourceFromKey(item.key);
    const action = String(item.suggested || '').includes('downweight')
      ? 'downweight'
      : String(item.suggested || '').includes('upweight')
        ? 'upweight'
        : 'observe';
    return {
      op: 'add',
      path: `/luna/discoverySourceFeedback/${source}`,
      value: {
        source,
        action,
        suggested: item.suggested,
        confidence: item.confidence || 'low',
        reason: item.reason,
        generatedAt: checkedAt,
        approvalRequired: action !== 'observe',
      },
    };
  });
  return {
    ok: true,
    checkedAt,
    status: operations.length > 0 ? 'reflection_config_patch_candidate' : 'reflection_config_patch_not_needed',
    operationCount: operations.length,
    approvalRequired: operations.some((op) => op.value?.approvalRequired === true),
    operations,
  };
}

export async function buildLunaReflectionConfigPatch({ days = 14 } = {}) {
  const report = await buildRuntimeConfigSuggestionsReport({ days, write: false });
  const patch = buildReflectionConfigPatchFromSuggestions(report.suggestions || [], {
    checkedAt: new Date().toISOString(),
  });
  return {
    ...patch,
    periodDays: days,
    discoveryReflection: report.discoveryReflection || null,
    sourceSuggestions: (report.suggestions || []).filter((item) => sourceFromKey(item.key)),
  };
}

export function renderLunaReflectionConfigPatch(report = {}) {
  return [
    '🧭 Luna reflection config patch',
    `status: ${report.status || 'unknown'}`,
    `operations: ${report.operationCount || 0}`,
    `approvalRequired: ${report.approvalRequired === true}`,
    ...(report.operations || []).slice(0, 5).map((op) => `- ${op.path}: ${op.value?.action || 'observe'} (${op.value?.confidence || 'low'})`),
  ].join('\n');
}

export async function writeLunaReflectionConfigPatch(report = {}, file = DEFAULT_OUTPUT) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}

export function runLunaReflectionConfigPatchSmoke() {
  const patch = buildReflectionConfigPatchFromSuggestions([
    {
      key: 'runtime_config.luna.discoverySourceFeedback.news_symbol_mapper',
      suggested: 'downweight_candidate',
      confidence: 'medium',
      reason: 'test weak source',
    },
    {
      key: 'runtime_config.luna.discoverySourceFeedback.coingecko_trending',
      suggested: 'upweight_candidate',
      confidence: 'low',
      reason: 'test strong source',
    },
  ], { checkedAt: '2026-04-29T00:00:00.000Z' });
  assert.equal(patch.operationCount, 2);
  assert.equal(patch.approvalRequired, true);
  assert.equal(patch.operations[0].value.action, 'downweight');
  assert.equal(patch.operations[1].value.action, 'upweight');
  return patch;
}

async function main() {
  const args = parseArgs();
  const report = await buildLunaReflectionConfigPatch(args);
  if (args.write) report.savedPath = await writeLunaReflectionConfigPatch(report, args.output);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(renderLunaReflectionConfigPatch(report));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna reflection config patch 실패:',
  });
}
