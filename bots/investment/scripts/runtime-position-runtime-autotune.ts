#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs';
import path from 'node:path';
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runPositionRuntimeTuning } from './runtime-position-runtime-tuning.ts';

const OVERRIDE_FILE = '/Users/alexlee/projects/ai-agent-system/bots/investment/output/ops/position-runtime-overrides.json';

function parseArgs(argv = []) {
  const args = {
    exchange: null,
    apply: false,
    confirm: null,
    json: false,
  };
  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw === '--apply') args.apply = true;
    else if (raw.startsWith('--exchange=')) args.exchange = raw.split('=').slice(1).join('=') || null;
    else if (raw.startsWith('--confirm=')) args.confirm = raw.split('=').slice(1).join('=') || null;
  }
  return args;
}

function loadOverrides() {
  try {
    if (!fs.existsSync(OVERRIDE_FILE)) return {};
    return JSON.parse(fs.readFileSync(OVERRIDE_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function overrideKeyForExchange(exchange) {
  if (exchange === 'binance') return 'position_watch_crypto_realtime_ms';
  if (exchange === 'kis' || exchange === 'kis_overseas') return 'position_watch_stock_realtime_ms';
  return null;
}

function buildUpdates(suggestions = []) {
  const updates = {};
  const appliedSuggestions = [];
  for (const suggestion of suggestions) {
    if (!suggestion?.exchange) continue;
    const key = overrideKeyForExchange(suggestion.exchange);
    if (!key || !Number.isFinite(Number(suggestion.recommendedCadenceMs))) continue;
    updates[key] = Number(suggestion.recommendedCadenceMs);
    appliedSuggestions.push({
      exchange: suggestion.exchange,
      key,
      status: suggestion.status,
      recommendedCadenceMs: Number(suggestion.recommendedCadenceMs),
      currentAverageCadenceMs: suggestion.currentAverageCadenceMs ?? null,
      reason: suggestion.reason || null,
    });
  }
  return { updates, appliedSuggestions };
}

function persistOverrides(updates = {}) {
  const previous = loadOverrides();
  const next = { ...previous, ...updates, updatedAt: new Date().toISOString() };
  const dir = path.dirname(OVERRIDE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(OVERRIDE_FILE, JSON.stringify(next, null, 2));
  return { previous, next };
}

function renderText(result = {}) {
  const lines = [
    '🛠️ Position Runtime Autotune',
    `status: ${result.status || 'unknown'}`,
    `override file: ${result.overrideFile || OVERRIDE_FILE}`,
  ];
  for (const item of result.appliedSuggestions || []) {
    lines.push(`- ${item.exchange} | ${item.key} ${item.currentAverageCadenceMs || 'n/a'} -> ${item.recommendedCadenceMs} | ${item.reason || 'n/a'}`);
  }
  return lines.join('\n');
}

export async function runPositionRuntimeAutotune(args = {}) {
  const tuning = await runPositionRuntimeTuning({
    exchange: args.exchange || null,
    json: true,
  });
  const { updates, appliedSuggestions } = buildUpdates(tuning.suggestions || []);

  if (!args.apply) {
    return {
      ok: true,
      status: Object.keys(updates).length > 0 ? 'position_runtime_autotune_ready' : 'position_runtime_autotune_idle',
      tuning,
      overrideFile: OVERRIDE_FILE,
      updates,
      appliedSuggestions,
    };
  }

  if (args.confirm !== 'runtime-autotune') {
    return {
      ok: false,
      status: 'position_runtime_autotune_confirmation_required',
      overrideFile: OVERRIDE_FILE,
      updates,
      appliedSuggestions,
      reason: 'use --confirm=runtime-autotune',
    };
  }

  const persisted = persistOverrides(updates);
  return {
    ok: true,
    status: 'position_runtime_autotune_applied',
    tuning,
    overrideFile: OVERRIDE_FILE,
    updates,
    appliedSuggestions,
    persisted,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runPositionRuntimeAutotune(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderText(result));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: () => db.initSchema(),
    run: main,
    errorPrefix: '❌ runtime-position-runtime-autotune 오류:',
  });
}
